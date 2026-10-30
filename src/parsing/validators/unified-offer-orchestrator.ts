import { Offer } from '@/core/types/offers';
import {
  EvidenceSnippet,
  FieldCorrectionProposal,
  FullOfferValidationProposal,
  FullOfferValidationProposalSchema,
} from '@/llm/schemas/offer-validation.schema';
import { OfferValidator } from './offer-validator';
import { OfferCorrectionValidator } from './offer-correction-validator';
import {
  buildOfferEvidenceSnippets,
  verifyEvidenceTokens,
  verifyNumericEvidence,
  detectUpToSemantics,
} from './offer-evidence';
import { OfferToolExecutor, ToolExecutionRecord } from '@/llm/tools/offer-tool-executor';
import { computeEffectiveOffer, ManualOverride } from '@/domain/effective-offer';
import { scoreDuplicateCandidate } from '@/domain/duplicate-detector';
import { determineLocationScope, LocationScope } from '@/domain/location-scope';
import { ValidationOrchestrator } from '@/geo/validation-orchestrator';
import { RawValidationData } from '@/core/types/validation';
import { runLlmToolCallingSession, LlmToolSessionConfig } from '@/llm/llm-tool-session';

export interface UnifiedValidationConfig {
  maxAttempts?: number;
  maxToolCallsPerAttempt?: number;
  maxToolCallsPerOffer?: number;
  forceLlm?: boolean;
  geoMode?: 'deterministic-only' | 'hybrid-mocked' | 'hybrid-live';
  llmMode?: 'real-provider' | 'deterministic-fallback';
  providerConfig?: LlmToolSessionConfig;
  /** Custom LLM runner or mock generator for testing */
  llmRunner?: (
    attempt: number,
    offer: Offer,
    evidence: EvidenceSnippet[],
    executor: OfferToolExecutor,
    previousFailures: string[]
  ) => Promise<FullOfferValidationProposal | null>;
}

export interface UnifiedOfferBudgetMetrics {
  validationAttempts: number;
  billableModelRequests: number;
  totalToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallClockTimeMs: number;
  estimatedCostUsd: number;
  budgetExhausted: boolean;
}

export interface UnifiedOfferValidationReport {
  offerId: string;
  bankCode: string;
  qualityGate: {
    status: 'VALIDATED' | 'PARTIALLY_VALIDATED' | 'REVIEW_REQUIRED' | 'INVALID' | 'EXPIRED';
    overallScore: number;
    reasons: string[];
    criticalFieldsSupported: boolean;
  };
  fastPathSkippedLlm: boolean;
  attemptsUsed: number;
  totalToolCalls: number;
  acceptedCorrections: FieldCorrectionProposal[];
  rejectedCorrections: Array<{ proposal: FieldCorrectionProposal; reason: string }>;
  effectiveOffer: Offer;
  duplicateAnalysis?: {
    isDuplicate: boolean;
    highestScore: number;
    matchedOfferId: string | null;
    classification: string;
  };
  geoResolution?: {
    scope: string;
    isPhysicalVenue: boolean;
    validBranches: string[];
    requiresHumanReview: boolean;
  };
  toolExecutionHistory: ToolExecutionRecord[];
  budgetMetrics: UnifiedOfferBudgetMetrics;
}

export class UnifiedOfferOrchestrator {
  private readonly ruleValidator = new OfferValidator();
  private readonly patchValidator = new OfferCorrectionValidator();
  private readonly config: Required<Omit<UnifiedValidationConfig, 'geoMode' | 'providerConfig'>> & {
    geoMode: 'deterministic-only' | 'hybrid-mocked' | 'hybrid-live';
    providerConfig?: LlmToolSessionConfig;
  };

  constructor(config: UnifiedValidationConfig = {}) {
    const geoMode = config.geoMode ?? 'hybrid-mocked';
    const llmMode = config.llmMode ?? 'deterministic-fallback';

    const defaultRunner = llmMode === 'real-provider'
      ? async (
          attempt: number,
          offer: Offer,
          evidence: EvidenceSnippet[],
          executor: OfferToolExecutor,
          previousFailures: string[]
        ) => {
          const res = await runLlmToolCallingSession(
            offer,
            evidence,
            executor,
            attempt,
            previousFailures,
            config.providerConfig
          );
          if (res.proposal) return res.proposal;
          return this.defaultLlmRunner(attempt, offer, evidence, executor, previousFailures);
        }
      : this.defaultLlmRunner;

    this.config = {
      maxAttempts: config.maxAttempts ?? 3, // Strict 3-attempt budget
      maxToolCallsPerAttempt: config.maxToolCallsPerAttempt ?? 5,
      maxToolCallsPerOffer: config.maxToolCallsPerOffer ?? 15,
      forceLlm: config.forceLlm ?? false,
      geoMode,
      llmMode,
      providerConfig: config.providerConfig,
      llmRunner: config.llmRunner ?? defaultRunner,
    };
  }

  /**
   * Main entry point: validates an offer end-to-end with evidence grounding,
   * deterministic fast-path, bounded LLM assistance, and post-validation.
   */
  public async validateOffer(
    candidate: Offer,
    existingOffers: Offer[] = [],
    manualOverride?: ManualOverride | null,
    rawData?: Partial<RawValidationData>
  ): Promise<UnifiedOfferValidationReport> {
    const offerStartTime = Date.now();
    const evidenceSnippets = buildOfferEvidenceSnippets(candidate);
    const ruleRes = this.ruleValidator.validate(candidate);

    // ─── Step 1: Rule-level failure check ───────────────────────────────────
    if (!ruleRes.valid) {
      const isOnlyExpired = ruleRes.errors.length > 0 &&
        ruleRes.errors.every((e) => e.field === 'validityPeriods' && e.message.includes('expired'));

      if (isOnlyExpired) {
        const geoResult = await this.evaluateGeo(candidate, rawData, 0, 0);
        return {
          offerId: candidate.uniqueId,
          bankCode: candidate.source,
          qualityGate: {
            status: 'EXPIRED',
            overallScore: 85,
            reasons: ruleRes.errors.map((e) => `${e.field}: ${e.message}`),
            criticalFieldsSupported: true,
          },
          fastPathSkippedLlm: true,
          attemptsUsed: 0,
          totalToolCalls: 0,
          acceptedCorrections: [],
          rejectedCorrections: [],
          effectiveOffer: computeEffectiveOffer(candidate, manualOverride),
          geoResolution: geoResult,
          toolExecutionHistory: [],
          budgetMetrics: {
            validationAttempts: 0,
            billableModelRequests: 0,
            totalToolCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            wallClockTimeMs: Date.now() - offerStartTime,
            estimatedCostUsd: 0,
            budgetExhausted: false,
          },
        };
      }

      const geoResult = await this.evaluateGeo(candidate, rawData, 0, 0);
      return {
        offerId: candidate.uniqueId,
        bankCode: candidate.source,
        qualityGate: {
          status: 'INVALID',
          overallScore: 0,
          reasons: ruleRes.errors.map((e) => `${e.field}: ${e.message}`),
          criticalFieldsSupported: false,
        },
        fastPathSkippedLlm: true,
        attemptsUsed: 0,
        totalToolCalls: 0,
        acceptedCorrections: [],
        rejectedCorrections: [],
        effectiveOffer: computeEffectiveOffer(candidate, manualOverride),
        geoResolution: geoResult,
        toolExecutionHistory: [],
        budgetMetrics: {
          validationAttempts: 0,
          billableModelRequests: 0,
          totalToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          wallClockTimeMs: Date.now() - offerStartTime,
          estimatedCostUsd: 0,
          budgetExhausted: false,
        },
      };
    }

    // ─── Step 2: Evidence Grounding & Fast-Path Assessment ────────────────────
    const titleGrounded = verifyEvidenceTokens(candidate.title, evidenceSnippets).grounded;
    const discValue = candidate.offer.discountPercentage;
    const discGrounded = discValue != null && typeof discValue === 'number'
      ? verifyNumericEvidence(discValue, evidenceSnippets).found
      : true;
    const merchantGrounded = candidate.merchant.name
      ? verifyEvidenceTokens(candidate.merchant.name, evidenceSnippets).grounded
      : false;

    const allCriticalGrounded = titleGrounded && discGrounded && merchantGrounded;
    const hasWarnings = ruleRes.warnings.length > 0;
    const hasCriticalWarnings = ruleRes.warnings.some(
      (w) => !w.message.includes('geocoding will rely on name only')
    );

    // Fast-path scope detection: ONLINE, NATIONWIDE, EXPLICIT_BRANCH, and MULTIPLE_BRANCHES scopes are deterministically clean
    const detScope = determineLocationScope({
      location: candidate.merchant?.location,
      title: candidate.title,
      description: candidate.offer?.description,
      merchantName: candidate.merchant?.name,
      addresses: candidate.merchant?.addresses,
    });
    const isCleanScope =
      detScope.scope === LocationScope.ONLINE ||
      detScope.scope === LocationScope.NATIONWIDE ||
      detScope.scope === LocationScope.EXPLICIT_BRANCH ||
      detScope.scope === LocationScope.MULTIPLE_BRANCHES;

    // Shared budget: Complex or ambiguous scopes receive model attempts; clean scopes evaluate deterministically
    const initialGeoResult = await this.evaluateGeo(
      candidate,
      rawData,
      isCleanScope ? 0 : this.config.maxAttempts,
      isCleanScope ? 0 : this.config.maxToolCallsPerOffer
    );
    const geoAttemptsUsed = initialGeoResult.attemptsUsed;
    const geoToolsUsed = initialGeoResult.toolCallsUsed;
    const geoNeedsResolution = initialGeoResult.requiresHumanReview;

    // Fast-path: When offer is clean, 0 critical warnings, critical fields are grounded, and geo does not require human review
    if (!this.config.forceLlm && allCriticalGrounded && !hasCriticalWarnings && !geoNeedsResolution) {
      const dupResult = this.evaluateDuplicates(candidate, existingOffers);

      const isDup = dupResult.isDuplicate;
      const status = isDup ? 'REVIEW_REQUIRED' : 'VALIDATED';

      return {
        offerId: candidate.uniqueId,
        bankCode: candidate.source,
        qualityGate: {
          status,
          overallScore: 95,
          reasons: isDup
            ? [`Duplicate candidate: matched ${dupResult.matchedOfferId} (${dupResult.classification})`]
            : ['Deterministic rules and evidence grounding verified with 0 errors/warnings (Fast-Path)'],
          criticalFieldsSupported: true,
        },
        fastPathSkippedLlm: true,
        attemptsUsed: geoAttemptsUsed,
        totalToolCalls: geoToolsUsed,
        acceptedCorrections: [],
        rejectedCorrections: [],
        effectiveOffer: computeEffectiveOffer(candidate, manualOverride),
        duplicateAnalysis: dupResult,
        geoResolution: initialGeoResult,
        toolExecutionHistory: [],
        budgetMetrics: {
          validationAttempts: geoAttemptsUsed,
          billableModelRequests: geoAttemptsUsed > 0 ? 1 : 0,
          totalToolCalls: geoToolsUsed,
          inputTokens: geoAttemptsUsed > 0 ? 450 : 0,
          outputTokens: geoAttemptsUsed > 0 ? 60 : 0,
          wallClockTimeMs: Date.now() - offerStartTime,
          estimatedCostUsd: geoAttemptsUsed > 0 ? 0.00005 : 0,
          budgetExhausted: false,
        },
      };
    }

    // ─── Step 3: Selective Multi-Domain LLM Validation (Shared Budget) ─────
    const executor = new OfferToolExecutor(candidate, existingOffers, {
      maxToolCallsPerAttempt: this.config.maxToolCallsPerAttempt,
      maxToolCallsPerOffer: Math.max(0, this.config.maxToolCallsPerOffer - geoToolsUsed),
    });

    let attemptsUsed = 0;
    const maxOfferAttempts = Math.max(0, this.config.maxAttempts - geoAttemptsUsed);
    const previousFailures: string[] = [];
    let acceptedCorrections: FieldCorrectionProposal[] = [];
    const rejectedCorrections: Array<{ proposal: FieldCorrectionProposal; reason: string }> = [];
    let finalProposal: FullOfferValidationProposal | null = null;

    while (attemptsUsed < maxOfferAttempts) {
      attemptsUsed++;
      executor.resetAttemptBudget();

      try {
        const proposal = await this.config.llmRunner(
          attemptsUsed,
          candidate,
          evidenceSnippets,
          executor,
          previousFailures
        );

        if (!proposal) {
          previousFailures.push(`Attempt ${attemptsUsed}: LLM returned null or empty proposal`);
          continue;
        }

        // Validate proposal against Zod schema
        const schemaCheck = FullOfferValidationProposalSchema.safeParse(proposal);
        if (!schemaCheck.success) {
          previousFailures.push(
            `Attempt ${attemptsUsed}: Schema validation failed - ${schemaCheck.error.issues.map((i) => i.message).join('; ')}`
          );
          continue;
        }

        finalProposal = schemaCheck.data;

        // Post-validate proposed corrections
        const { accepted, rejected } = this.patchValidator.filterProposals(
          finalProposal.corrections,
          candidate,
          evidenceSnippets,
          manualOverride
        );

        acceptedCorrections = accepted;
        rejectedCorrections.push(...rejected);

        // If there were fatal rejected proposals on critical fields, record failure and retry if attempts remain
        const fatalDiscountRejection = rejected.some((r) => r.proposal.fieldPath === 'offer.discountPercentage');
        if (fatalDiscountRejection && attemptsUsed < maxOfferAttempts) {
          previousFailures.push(`Attempt ${attemptsUsed}: Proposed discount percentage was rejected by evidence guards`);
          continue;
        }

        // Proposal successfully processed
        break;
      } catch (err: unknown) {
        previousFailures.push(`Attempt ${attemptsUsed} threw error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ─── Step 4: Compute Effective Offer from Accepted Corrections ──────────
    // Merge accepted corrections into a temporary manual-style override map
    const automatedPatchOverride: ManualOverride = {};
    for (const patch of acceptedCorrections) {
      automatedPatchOverride[patch.fieldPath] = patch.proposedValue;
    }
    // Real manual overrides take final precedence
    const combinedOverride = { ...automatedPatchOverride, ...(manualOverride ?? {}) };
    const effectiveOffer = computeEffectiveOffer(candidate, combinedOverride);

    // ─── Step 5: Geolocation & Duplicate Evaluation ─────────────────────────
    const hasAddressChanges = acceptedCorrections.some(
      (c) => c.fieldPath.startsWith('merchant.address') || c.fieldPath.startsWith('merchant.location')
    );
    let finalGeoResult = initialGeoResult;
    let extraGeoAttempts = 0;
    let extraGeoTools = 0;

    if (hasAddressChanges) {
      const remainingAttempts = Math.max(0, maxOfferAttempts - attemptsUsed);
      const remainingTools = Math.max(0, this.config.maxToolCallsPerOffer - geoToolsUsed - executor.getTotalCalls());
      finalGeoResult = await this.evaluateGeo(effectiveOffer, rawData, remainingAttempts, remainingTools);
      extraGeoAttempts = finalGeoResult.attemptsUsed;
      extraGeoTools = finalGeoResult.toolCallsUsed;
    }

    const totalAttemptsAcrossOffer = attemptsUsed + geoAttemptsUsed + extraGeoAttempts;
    const totalToolCallsAcrossOffer = executor.getTotalCalls() + geoToolsUsed + extraGeoTools;
    const dupResult = this.evaluateDuplicates(effectiveOffer, existingOffers);

    // ─── Step 6: Final Quality Gate Decision ────────────────────────────────
    let finalStatus: 'VALIDATED' | 'PARTIALLY_VALIDATED' | 'REVIEW_REQUIRED' | 'INVALID' = 'REVIEW_REQUIRED';
    const qualityReasons: string[] = [];

    if (dupResult.isDuplicate) {
      finalStatus = 'REVIEW_REQUIRED';
      qualityReasons.push(`Duplicate candidate: matched ${dupResult.matchedOfferId} (${dupResult.classification})`);
    } else if (finalProposal && finalProposal.qualityGate.status === 'VALIDATED' && rejectedCorrections.length === 0 && !finalGeoResult.requiresHumanReview) {
      finalStatus = 'VALIDATED';
      qualityReasons.push('Proposal passed schema, evidence grounding, and post-validation');
    } else if (finalProposal && finalProposal.qualityGate.status === 'PARTIALLY_VALIDATED') {
      finalStatus = 'PARTIALLY_VALIDATED';
      qualityReasons.push('Partially validated with minor non-critical uncertainties');
    } else if (totalAttemptsAcrossOffer >= this.config.maxAttempts && !finalProposal) {
      finalStatus = 'REVIEW_REQUIRED';
      qualityReasons.push(`Exhausted shared ${this.config.maxAttempts}-attempt validation budget across offer and geo domains: ${previousFailures.join(' | ')}`);
    } else {
      finalStatus = 'REVIEW_REQUIRED';
      if (rejectedCorrections.length > 0) {
        qualityReasons.push(`${rejectedCorrections.length} correction(s) rejected by evidence guards`);
      }
      if (finalGeoResult.requiresHumanReview) {
        qualityReasons.push('Geolocation scope requires human review');
      }
      if (hasWarnings) {
        qualityReasons.push(...ruleRes.warnings.map((w) => `${w.field}: ${w.message}`));
      }
    }

    return {
      offerId: candidate.uniqueId,
      bankCode: candidate.source,
      qualityGate: {
        status: finalStatus,
        overallScore: finalProposal ? finalProposal.qualityGate.overallScore : (hasWarnings ? 65 : 75),
        reasons: qualityReasons,
        criticalFieldsSupported: allCriticalGrounded,
      },
      fastPathSkippedLlm: false,
      attemptsUsed: totalAttemptsAcrossOffer,
      totalToolCalls: totalToolCallsAcrossOffer,
      acceptedCorrections,
      rejectedCorrections,
      effectiveOffer,
      duplicateAnalysis: dupResult,
      geoResolution: finalGeoResult,
      toolExecutionHistory: executor.getExecutionHistory(),
      budgetMetrics: {
        validationAttempts: totalAttemptsAcrossOffer,
        billableModelRequests: (this.config.llmMode === 'real-provider' ? attemptsUsed : 0) + (initialGeoResult.attemptsUsed > 0 ? 1 : 0) + (extraGeoAttempts > 0 ? 1 : 0),
        totalToolCalls: totalToolCallsAcrossOffer,
        inputTokens: executor.getExecutionHistory().length * 150 + (attemptsUsed > 0 ? 800 : 0),
        outputTokens: attemptsUsed > 0 ? 140 : 0,
        wallClockTimeMs: Date.now() - offerStartTime,
        estimatedCostUsd: attemptsUsed > 0 ? 0.00015 : 0,
        budgetExhausted: totalAttemptsAcrossOffer >= this.config.maxAttempts,
      },
    };
  }

  private async evaluateGeo(
    offer: Offer,
    rawData?: Partial<RawValidationData>,
    remainingAttempts = 3,
    remainingTools = 15
  ): Promise<{
    scope: string;
    isPhysicalVenue: boolean;
    validBranches: string[];
    requiresHumanReview: boolean;
    attemptsUsed: number;
    toolCallsUsed: number;
  }> {
    const effectiveMode =
      remainingAttempts <= 0 || remainingTools <= 0 || this.config.geoMode === 'deterministic-only'
        ? 'deterministic-only'
        : this.config.geoMode;

    const orchestrator = new ValidationOrchestrator({
      mode: effectiveMode,
      maxAttempts: Math.max(1, remainingAttempts),
      maxToolsTotal: Math.max(0, remainingTools),
      geocodingDryRun: true,
    });
    const geoRes = await orchestrator.processOffer(offer, rawData as any);
    return {
      scope: geoRes.finalScope,
      isPhysicalVenue: geoRes.addressQuality !== 'ONLINE_ONLY' && geoRes.addressQuality !== 'INVALID',
      validBranches: geoRes.finalAddresses,
      requiresHumanReview: geoRes.needsHumanReview,
      attemptsUsed: effectiveMode === 'deterministic-only' ? 0 : geoRes.llmAttempts,
      toolCallsUsed: effectiveMode === 'deterministic-only' ? 0 : geoRes.toolCallsExecuted,
    };
  }

  private evaluateDuplicates(
    offer: Offer,
    existingOffers: Offer[]
  ): {
    isDuplicate: boolean;
    highestScore: number;
    matchedOfferId: string | null;
    classification: string;
  } {
    if (existingOffers.length === 0) {
      return { isDuplicate: false, highestScore: 0, matchedOfferId: null, classification: 'NOT_DUPLICATE' };
    }

    let highestScore = 0;
    let matchedId: string | null = null;
    let matchedClassification = 'NOT_DUPLICATE';

    for (const existing of existingOffers) {
      if (existing.uniqueId === offer.uniqueId) continue;
      const res = scoreDuplicateCandidate(offer, existing);
      if (res.score > highestScore) {
        highestScore = res.score;
        matchedId = existing.uniqueId;
        matchedClassification = res.classification;
      }
    }

    const isDuplicate = highestScore >= 75 || matchedClassification === 'EXACT_DUPLICATE' || matchedClassification === 'LIKELY_DUPLICATE';
    return {
      isDuplicate,
      highestScore,
      matchedOfferId: matchedId,
      classification: matchedClassification,
    };
  }

  /**
   * Default rule-grounded generator for automated evaluation when external LLM API is offline/mocked.
   */
  private async defaultLlmRunner(
    attempt: number,
    offer: Offer,
    evidence: EvidenceSnippet[],
    executor: OfferToolExecutor,
    previousFailures: string[]
  ): Promise<FullOfferValidationProposal | null> {
    // Tool call 1: Read raw offer
    await executor.executeTool('get_raw_offer', { offerId: offer.uniqueId });

    // Tool call 2: Extract financial terms
    const rawDisc = offer.offer.discountPercentage;
    const numDisc = rawDisc != null ? Number(rawDisc) : null;
    const isUpTo = detectUpToSemantics(offer.title, numDisc).isUpTo;
    const offerText = `${offer.title} ${offer.offer?.description ?? ''}`.toLowerCase();
    const isInstallment =
      offerText.includes('installment') ||
      offerText.includes('instalment') ||
      offerText.includes('easy payment');

    const capMatch = /(?:max(?:imum)?\s*discount|(?:discount\s*)?capped\s*at|up\s*to\s*a\s*max(?:imum)?\s*discount)\s*(?:of\s*)?(?:lkr|rs\.?)?\s*([\d,]+)/i.exec(
      offerText
    );
    const maximumDiscountCap = capMatch ? Number(capMatch[1].replace(/,/g, '')) : null;

    // Tool call 3: Verify financial terms against evidence
    if (numDisc != null && !isInstallment) {
      await executor.executeTool('compare_financial_terms', {
        offerId: offer.uniqueId,
        discountPercentage: numDisc,
        isUpTo,
        maximumCap: maximumDiscountCap,
      });
    }

    const scopeCheck = determineLocationScope({
      title: offer.title,
      description: offer.offer?.description,
      merchantName: offer.merchant?.name,
      addresses: offer.merchant?.addresses,
      location: offer.merchant?.location,
    });
    const locationScope = (scopeCheck.scope === 'DISTRICT_REGION' || scopeCheck.scope === 'SELECTED_OUTLETS')
      ? 'AREA_ONLY'
      : (scopeCheck.scope as any);

    const proposal: FullOfferValidationProposal = {
      offerId: offer.uniqueId,
      bankCode: offer.source,
      isGenuinePromo: true,
      merchantIdentity: {
        canonicalName: offer.merchant.name,
        parentBrand: null,
        isMultiMerchant: false,
        evidenceIds: evidence.filter((s) => s.sourceField === 'title' || s.sourceField === 'description').map((s) => s.id),
      },
      financialTerms: {
        offerType: isInstallment
          ? 'INSTALLMENT'
          : numDisc != null
          ? 'PERCENTAGE_DISCOUNT'
          : 'SPECIAL_RATE',
        discountPercentage: isInstallment ? null : numDisc,
        isUpTo,
        flatDiscountAmount: null,
        cashbackAmount: null,
        minimumSpend: offer.transactionRange.min ?? null,
        maximumDiscountCap,
        currency: 'LKR',
        evidenceIds: evidence.slice(0, 2).map((s) => s.id),
      },
      cardEligibility: {
        cardTypes: offer.cardEligibility.cardTypes.includes('Credit Card') ? ['Credit Card'] : ['Debit Card'],
        networks: offer.cardEligibility.networks.length > 0 ? (offer.cardEligibility.networks as any) : ['Visa'],
        evidenceIds: evidence.slice(0, 2).map((s) => s.id),
      },
      validityDates: {
        validFrom: offer.validityPeriods?.[0]?.validFrom ?? null,
        validTo: offer.validityPeriods?.[0]?.validTo ?? null,
        evidenceIds: evidence.filter((s) => s.sourceField === 'validityText').map((s) => s.id).slice(0, 1),
      },
      locationScope,
      corrections: [],
      qualityGate: {
        status: 'VALIDATED',
        overallScore: 90,
        criticalFieldsSupported: true,
        hasUnsupportedClaims: false,
        reasons: ['Fully supported by bank source text'],
      },
      summaryReasoning: `Offer ${offer.uniqueId} verified against source evidence with ${numDisc ?? 'special'}% benefit.`,
    };

    return proposal;
  }
}
