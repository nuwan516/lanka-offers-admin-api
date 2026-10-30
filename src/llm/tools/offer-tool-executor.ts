import { Offer } from '@/core/types/offers';
import {
  EvidenceSnippet,
  FullOfferValidationProposal,
  FullOfferValidationProposalSchema,
  ValidationDecision,
  ValidationDecisionSchema,
  toFullOfferValidationProposal,
} from '@/llm/schemas/offer-validation.schema';
import {
  buildOfferEvidenceSnippets,
  verifyEvidenceTokens,
  verifyNumericEvidence,
  verifySemanticNumericEvidence,
  detectUpToSemantics,
} from '@/parsing/validators/offer-evidence';
import { normalizeMerchantName } from '@/parsing/normalization/offer-normalizer';
import { EDITABLE_FIELD_PATHS } from '@/domain/effective-offer';
import { scoreDuplicateCandidate } from '@/domain/duplicate-detector';
import { OfferValidator } from '@/parsing/validators/offer-validator';
import { classifyDetailedOfferQuality } from '@/domain/offer-quality-decision';
import { determineLocationScope } from '@/domain/location-scope';
import { parseOutletList } from '@/parsing/geo/branch-parser';

export interface ToolCallBudget {
  maxToolCallsPerAttempt: number;
  maxToolCallsPerOffer: number;
  timeoutMs: number;
}

export const DEFAULT_OFFER_TOOL_BUDGET: ToolCallBudget = {
  maxToolCallsPerAttempt: 5,
  maxToolCallsPerOffer: 15,
  timeoutMs: 5000,
};

export interface ToolExecutionRecord {
  toolName: string;
  arguments: Record<string, unknown>;
  output: unknown;
  durationMs: number;
  error?: string;
}

export class OfferToolExecutor {
  private readonly offer: Offer;
  private readonly evidenceSnippets: EvidenceSnippet[];
  private readonly existingOffers: Offer[];
  private readonly budget: ToolCallBudget;
  private callsThisAttempt: number = 0;
  private totalCalls: number = 0;
  private readonly executionHistory: ToolExecutionRecord[] = [];
  private submittedProposal: FullOfferValidationProposal | null = null;
  private submittedDecision: ValidationDecision | null = null;

  constructor(
    offer: Offer,
    existingOffers: Offer[] = [],
    budget: Partial<ToolCallBudget> = {}
  ) {
    this.offer = offer;
    this.existingOffers = existingOffers;
    this.evidenceSnippets = buildOfferEvidenceSnippets(offer);
    this.budget = { ...DEFAULT_OFFER_TOOL_BUDGET, ...budget };
  }

  public resetAttemptBudget(): void {
    this.callsThisAttempt = 0;
  }

  public getTotalCalls(): number {
    return this.totalCalls;
  }

  public getExecutionHistory(): ToolExecutionRecord[] {
    return [...this.executionHistory];
  }

  public getSubmittedProposal(): FullOfferValidationProposal | null {
    return this.submittedProposal;
  }

  public getSubmittedDecision(): ValidationDecision | null {
    return this.submittedDecision;
  }

  public getEvidenceSnippets(): EvidenceSnippet[] {
    return this.evidenceSnippets;
  }

  public async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const startTime = Date.now();
    const isSubmission = toolName === 'submit_validation_decision' || toolName === 'submit_offer_validation_proposal';

    // 1. Quota & Budget Enforcement
    if (isSubmission && this.submittedProposal !== null) {
      const err = 'Validation proposal has already been submitted for this session';
      this.recordExecution(toolName, args, null, Date.now() - startTime, err);
      return { success: false, error: err };
    }

    // Submission tools are exempt from the inspection attempt limit
    if (!isSubmission && this.callsThisAttempt >= this.budget.maxToolCallsPerAttempt) {
      const err = `Tool call limit exceeded for this attempt (max ${this.budget.maxToolCallsPerAttempt})`;
      this.recordExecution(toolName, args, null, Date.now() - startTime, err);
      return { success: false, error: err };
    }

    if (this.totalCalls >= this.budget.maxToolCallsPerOffer) {
      const err = `Global offer tool budget exhausted (max ${this.budget.maxToolCallsPerOffer})`;
      this.recordExecution(toolName, args, null, Date.now() - startTime, err);
      return { success: false, error: err };
    }

    if (!isSubmission) {
      this.callsThisAttempt++;
    }
    this.totalCalls++;

    try {
      const result = await this.dispatch(toolName, args);
      this.recordExecution(toolName, args, result, Date.now() - startTime);
      return { success: true, data: result };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.recordExecution(toolName, args, null, Date.now() - startTime, errMsg);
      return { success: false, error: errMsg };
    }
  }

  private recordExecution(
    toolName: string,
    args: Record<string, unknown>,
    output: unknown,
    durationMs: number,
    error?: string
  ): void {
    this.executionHistory.push({
      toolName,
      arguments: args,
      output,
      durationMs,
      error,
    });
  }

  private async dispatch(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      // ─── Source tools ────────────────────────────────────────────────────────
      case 'get_raw_offer': {
        return {
          uniqueId: this.offer.uniqueId,
          source: this.offer.source,
          sourceUrl: this.offer.sourceUrl,
          title: this.offer.title,
          category: this.offer.category,
          cardType: this.offer.cardType,
          merchant: this.offer.merchant,
          offer: this.offer.offer,
          validityPeriods: this.offer.validityPeriods,
          transactionRange: this.offer.transactionRange,
          cardEligibility: this.offer.cardEligibility,
          evidenceCount: this.evidenceSnippets.length,
          snippets: this.evidenceSnippets,
        };
      }

      case 'get_source_section': {
        const allowedSections = ['title', 'description', 'terms', 'validity', 'merchant', 'raw_html'];
        const section = String(args.section ?? '');
        if (!allowedSections.includes(section)) {
          throw new Error(`Invalid section "${section}". Expected one of: ${allowedSections.join(', ')}`);
        }
        const match = this.evidenceSnippets.filter((s) => {
          if (section === 'title') return s.sourceField === 'title';
          if (section === 'description') return s.sourceField === 'description';
          if (section === 'terms') return s.sourceField === 'terms' || s.sourceField === 'specialConditions' || s.sourceField === 'generalTerms';
          if (section === 'validity') return s.sourceField === 'validityText';
          if (section === 'merchant') return s.sourceField === 'merchantLocation' || s.sourceField === 'merchantAddresses';
          if (section === 'raw_html') return s.sourceField === 'rawText' || s.sourceField === 'rawHtml';
          return true;
        });
        return {
          section,
          count: match.length,
          snippets: match.map((s) => ({
            id: s.id,
            sourceField: s.sourceField,
            text: s.text.length > 400 ? s.text.slice(0, 400) + '... [truncated]' : s.text,
          })),
        };
      }

      case 'search_source_evidence': {
        const query = String(args.query ?? '').toLowerCase().trim();
        if (!query) throw new Error('Search query parameter "query" is required');
        const matches = this.evidenceSnippets.filter((s) => s.text.toLowerCase().includes(query));
        return {
          query,
          matchCount: matches.length,
          matches: matches.map((m) => ({ id: m.id, sourceField: m.sourceField, text: m.text })),
        };
      }

      case 'expand_evidence_window': {
        const snippetId = String(args.snippetId ?? '');
        const target = this.evidenceSnippets.find((s) => s.id === snippetId);
        if (!target) return { found: false, error: `Snippet ${snippetId} not found` };
        return {
          found: true,
          snippetId: target.id,
          sourceField: target.sourceField,
          text: target.text,
        };
      }

      // ─── Merchant tools ──────────────────────────────────────────────────────
      case 'normalize_merchant_name': {
        const name = String(args.name ?? '');
        const normalized = normalizeMerchantName(name);
        return { original: name, normalized };
      }

      case 'find_existing_merchants': {
        const query = String(args.query ?? '').toLowerCase().trim();
        const matches = this.existingOffers
          .map((o) => o.merchant?.name)
          .filter(Boolean)
          .filter((name) => name.toLowerCase().includes(query));
        return { query, matches: Array.from(new Set(matches)).slice(0, 5) };
      }

      case 'compare_merchant_identity': {
        const candidateName = String(args.candidateName ?? '');
        const normCandidate = normalizeMerchantName(candidateName);
        const normSource = normalizeMerchantName(this.offer.merchant?.name);
        const tokenMatch = verifyEvidenceTokens(candidateName, this.evidenceSnippets);
        return {
          candidateName,
          normalizedCandidate: normCandidate,
          sourceMerchant: normSource,
          exactMatch: normCandidate === normSource,
          tokenOverlapRatio: tokenMatch.tokenOverlapRatio,
          grounded: tokenMatch.grounded,
        };
      }

      // ─── Financial tools ─────────────────────────────────────────────────────
      case 'extract_financial_terms': {
        const text = String(args.text ?? '');
        const discMatch = /(\d{1,2}(?:\.\d+)?)\s*%/i.exec(text);
        const disc = discMatch ? Number(discMatch[1]) : null;
        const upToCheck = detectUpToSemantics(text, disc);
        const lkrMatch = /(?:lkr|rs\.?)\s*([\d,]+)/i.exec(text);
        const amount = lkrMatch ? Number(lkrMatch[1].replace(/,/g, '')) : null;
        return {
          discountPercentage: disc,
          isUpTo: upToCheck.isUpTo,
          amount,
          rawMatch: discMatch?.[0] ?? lkrMatch?.[0] ?? null,
        };
      }

      case 'compare_financial_terms': {
        const disc = args.discountPercentage != null ? Number(args.discountPercentage) : null;
        const minSpend = args.minimumSpend != null ? Number(args.minimumSpend) : null;
        const cap = args.maximumCap != null ? Number(args.maximumCap) : null;

        const discCheck = disc != null ? verifySemanticNumericEvidence(disc, 'DISCOUNT_PERCENT', this.evidenceSnippets) : null;
        const minCheck = minSpend != null ? verifySemanticNumericEvidence(minSpend, 'MINIMUM_SPEND', this.evidenceSnippets) : null;
        const capCheck = cap != null ? verifySemanticNumericEvidence(cap, 'MAXIMUM_DISCOUNT_CAP', this.evidenceSnippets) : null;

        return {
          discountSupported: discCheck ? discCheck.found : true,
          discountContexts: discCheck?.contexts ?? [],
          minSpendSupported: minCheck ? minCheck.found : true,
          capSupported: capCheck ? capCheck.found : true,
        };
      }

      case 'validate_financial_consistency': {
        const disc = args.discountPercentage != null ? Number(args.discountPercentage) : null;
        const min = args.minimumSpend != null ? Number(args.minimumSpend) : null;
        const cap = args.maximumCap != null ? Number(args.maximumCap) : null;

        const errors: string[] = [];
        if (disc != null && (disc < 0 || disc > 100)) {
          errors.push(`Discount percentage ${disc}% is outside 0-100 range`);
        }
        if (min != null && min < 0) {
          errors.push(`Minimum spend cannot be negative (${min})`);
        }
        if (cap != null && cap < 0) {
          errors.push(`Maximum cap cannot be negative (${cap})`);
        }

        // Installment intent check: 0% discount on installment promotion is invalid
        const text = `${this.offer.title} ${this.offer.offer?.description ?? ''}`.toLowerCase();
        if (disc === 0 && (text.includes('installment') || text.includes('instalment') || text.includes('easy payment'))) {
          errors.push('A 0% installment promotion represents an interest-free payment facility, not a 0% price discount');
        }

        // Note: minimum spend (e.g. LKR 5,000) being greater than maximum discount cap (e.g. LKR 1,500)
        // is completely valid and normal in retail banking promotions. We explicitly do NOT reject this.

        return { valid: errors.length === 0, errors };
      }

      // ─── Eligibility tools ───────────────────────────────────────────────────
      case 'extract_card_eligibility': {
        const text = String(args.text ?? '').toLowerCase();
        const cardTypes: string[] = [];
        if (text.includes('credit')) cardTypes.push('Credit Card');
        if (text.includes('debit')) cardTypes.push('Debit Card');

        const networks: string[] = [];
        if (text.includes('visa')) networks.push('Visa');
        if (text.includes('mastercard') || text.includes('master card')) networks.push('Mastercard');
        if (text.includes('amex') || text.includes('american express')) networks.push('Amex');

        return { cardTypes, networks };
      }

      case 'validate_card_restrictions': {
        const cardTypes = Array.isArray(args.cardTypes) ? args.cardTypes.map(String) : [];
        const networks = Array.isArray(args.networks) ? args.networks.map(String) : [];

        const verifiedTypes = cardTypes.map((ct) => ({
          type: ct,
          grounded: verifyEvidenceTokens(ct, this.evidenceSnippets).grounded,
        }));

        const verifiedNetworks = networks.map((nw) => ({
          network: nw,
          grounded: verifyEvidenceTokens(nw, this.evidenceSnippets).grounded,
        }));

        return { verifiedTypes, verifiedNetworks };
      }

      // ─── Date tools ──────────────────────────────────────────────────────────
      case 'extract_offer_dates': {
        const periodText = String(args.periodText ?? '');
        const dateRegex = /\b(\d{4}-\d{2}-\d{2})\b/g;
        const dates: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = dateRegex.exec(periodText)) !== null) {
          dates.push(m[1]);
        }
        return {
          extractedDates: dates,
          validFrom: dates[0] ?? null,
          validTo: dates[1] ?? dates[0] ?? null,
        };
      }

      case 'validate_date_range': {
        const from = args.validFrom ? String(args.validFrom) : null;
        const to = args.validTo ? String(args.validTo) : null;
        const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

        const errors: string[] = [];
        if (from && !ISO_RE.test(from)) errors.push(`validFrom is not YYYY-MM-DD: ${from}`);
        if (to && !ISO_RE.test(to)) errors.push(`validTo is not YYYY-MM-DD: ${to}`);
        if (from && to && from > to) errors.push(`validFrom (${from}) is after validTo (${to})`);

        return { valid: errors.length === 0, errors };
      }

      case 'find_date_evidence': {
        const dateSnippets = this.evidenceSnippets.filter(
          (s) => s.sourceField === 'validityText' || /\b\d{4}\b/.test(s.text) || /\btill\b|\bfrom\b|\bto\b/i.test(s.text)
        );
        return { count: dateSnippets.length, snippets: dateSnippets };
      }

      // ─── Duplicate tools ─────────────────────────────────────────────────────
      case 'find_similar_offers': {
        const scored = this.existingOffers
          .filter((o) => o.uniqueId !== this.offer.uniqueId)
          .map((existing) => ({
            existingId: existing.uniqueId,
            bank: existing.source,
            title: existing.title,
            ...scoreDuplicateCandidate(this.offer, existing),
          }))
          .filter((res) => res.score >= 30)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        return { candidateCount: scored.length, matches: scored };
      }

      case 'compare_offer_versions': {
        const existingId = String(args.existingOfferId ?? '');
        const existing = this.existingOffers.find((o) => o.uniqueId === existingId);
        if (!existing) return { found: false, error: `Offer ${existingId} not found` };
        const score = scoreDuplicateCandidate(this.offer, existing);
        return {
          found: true,
          existingId: existing.uniqueId,
          score: score.score,
          classification: score.classification,
          reasons: score.reasons,
        };
      }

      case 'classify_duplicate_relationship': {
        const score = Number(args.similarityScore ?? 0);
        const sameBank = Boolean(args.sameBank);
        if (!sameBank) return { classification: score >= 60 ? 'CROSS_BANK_SIMILAR' : 'NOT_DUPLICATE' };
        if (score >= 85) return { classification: 'EXACT_DUPLICATE' };
        if (score >= 65) return { classification: 'LIKELY_DUPLICATE' };
        return { classification: 'NOT_DUPLICATE' };
      }

      // ─── Geographic Scope tools ──────────────────────────────────────────────
      case 'resolve_geographic_scope': {
        const text = String(args.text ?? `${this.offer.title} ${this.offer.offer?.description ?? ''}`);
        const mName = String(args.merchantName ?? this.offer.merchant?.name ?? '');
        const loc = String(args.locationString ?? this.offer.merchant?.location ?? '');
        const res = determineLocationScope({
          title: this.offer.title,
          description: text,
          merchantName: mName,
          location: loc,
          addresses: this.offer.merchant?.addresses,
          terms: [...(this.offer.offer?.generalTerms ?? []), ...(this.offer.offer?.restrictions ?? [])],
        });
        return {
          scope: res.scope,
          venueIdentity: res.venueIdentity,
          addressPrecision: res.addressPrecision,
          coordinateConfidence: res.coordinateConfidence,
          isGeocodableToCoordinates: res.isGeocodableToCoordinates,
          participatingBranches: res.participatingBranches ?? [],
          participatingBranchesCount: res.participatingBranchesCount ?? null,
          rawEvidence: res.rawEvidence,
          explanation: res.explanation,
        };
      }

      case 'extract_participating_branches': {
        const text = String(args.text ?? `${this.offer.offer?.description ?? ''} ${(this.offer.offer?.generalTerms ?? []).join(' ')}`);
        const mName = String(args.merchantName ?? this.offer.merchant?.name ?? '');
        const parsed = parseOutletList(text, mName);
        return {
          branchCount: parsed.length,
          branches: parsed,
          evidence: text.slice(0, 200),
        };
      }

      // ─── Validation tools ────────────────────────────────────────────────────
      case 'validate_offer_schema': {
        const validator = new OfferValidator();
        const res = validator.validate(this.offer);
        return {
          valid: res.valid,
          errorCount: res.errors.length,
          errors: res.errors,
          warningCount: res.warnings.length,
          warnings: res.warnings,
        };
      }

      case 'validate_correction_patch': {
        const fieldPath = String(args.fieldPath ?? '');
        const isAllowlisted = EDITABLE_FIELD_PATHS.includes(fieldPath as any);
        const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : [];
        const missingEvidenceIds = evidenceIds.filter((id) => !this.evidenceSnippets.some((s) => s.id === id));

        return {
          fieldPath,
          isAllowlisted,
          hasEvidence: evidenceIds.length > 0,
          missingEvidenceIds,
          valid: isAllowlisted && evidenceIds.length > 0 && missingEvidenceIds.length === 0,
        };
      }

      case 'evaluate_offer_quality': {
        const validator = new OfferValidator();
        const ruleRes = validator.validate(this.offer);
        const quality = classifyDetailedOfferQuality({
          ruleValid: ruleRes.valid,
          ruleErrorCount: ruleRes.errors.length,
          ruleWarningCount: ruleRes.warnings.length,
          llmScore: null,
          llmValid: null,
          llmStatus: null,
        });
        return { decision: quality.decision, category: quality.category, reasons: quality.reasons };
      }

      case 'submit_offer_validation_proposal': {
        const rawJson = typeof args.proposal === 'string' ? JSON.parse(args.proposal) : args.proposal;
        const parsed = FullOfferValidationProposalSchema.parse(rawJson);
        this.submittedProposal = parsed;
        return { accepted: true, offerId: parsed.offerId, status: parsed.qualityGate.status };
      }

      case 'submit_validation_decision': {
        let rawObj: any = args;
        if (typeof args.decisionData === 'string') {
          try { rawObj = JSON.parse(args.decisionData); } catch {}
        }
        const parsed = ValidationDecisionSchema.parse(rawObj);
        this.submittedDecision = parsed;
        this.submittedProposal = toFullOfferValidationProposal(parsed, this.offer);
        return {
          accepted: true,
          decision: parsed.decision,
          overallScore: parsed.overallScore,
          correctionsCount: parsed.corrections.length,
          unresolvedIssuesCount: parsed.unresolvedIssues.length,
        };
      }

      case 'lookup_merchant_catalog': {
        const query = String(args.query ?? '').toLowerCase().trim();
        if (!query) throw new Error('Merchant search query parameter "query" is required');
        const matches = this.existingOffers
          .map((o) => o.merchant?.name)
          .filter(Boolean)
          .filter((name) => (name as string).toLowerCase().includes(query));
        const normalized = normalizeMerchantName(query);
        return {
          query,
          normalized,
          matches: Array.from(new Set(matches)).slice(0, 5),
        };
      }

      case 'query_bank_rules': {
        const bankCode = String(args.bankCode ?? this.offer.source ?? '').toLowerCase().trim();
        if (!bankCode) throw new Error('Bank code parameter "bankCode" is required');
        const topic = String(args.topic ?? 'all');
        return {
          bankCode,
          topic,
          rules: {
            allowedCardTypes: ['Credit Card', 'Debit Card'],
            supportedNetworks: ['Visa', 'Mastercard', 'Amex'],
            supportsInstallments: true,
            note: 'Debit card eligibility must be explicitly stated in the source text; otherwise assume Credit Card only. 0% installment plans are payment plans, not price discounts.',
          },
        };
      }

      case 'check_potential_duplicate': {
        const simOffers = this.existingOffers.slice(0, 5).map((o) => {
          const score = scoreDuplicateCandidate(this.offer, o);
          return {
            id: o.uniqueId,
            title: o.title,
            merchant: o.merchant?.name,
            score: score.score,
            relationship: score.classification,
          };
        });
        return { count: simOffers.length, candidates: simOffers };
      }

      default:
        throw new Error(`Unknown or disallowed tool: ${toolName}`);
    }
  }
}
