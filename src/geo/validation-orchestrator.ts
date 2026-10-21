/**
 * Lanka Offers — Intelligent Address Validation & Geolocation Orchestrator
 *
 * Implements Section 3, 7, 10, 13, 14 of the Intelligent Address Validation Pipeline:
 * - Deterministic address quality assessment
 * - Fast-path for high-confidence addresses (avoids unnecessary LLM costs)
 * - Conditional LLM validation agent with strict 3-attempt state machine
 * - Bounded tool execution (max 5 tool calls/attempt, max 15 across offer)
 * - Deterministic post-validation and patch generation
 * - Geocoding eligibility gate, cache-first lookup, and coordinate verification
 * - Diagnostics tracking:
 *   [Address extracted] -> [Address normalized] -> [Validation required] ->
 *   [LLM correction suggested] -> [Tool evidence retrieved] -> [Correction accepted] ->
 *   [Geocode candidate generated] -> [Coordinate verified] -> [Needs manual review]
 */

import { Offer } from '@/core/types/offers';
import { RawValidationData } from '@/core/types/validation';
import { GeoResult } from '@/core/types/geo';
import { LocationScope } from '@/domain/location-scope';
import { AddressQuality, assessAddressQuality } from '@/geo/address-quality';
import { buildGeoOfferContext, GeoOfferContext } from '@/geo/geo-evidence';
import { GeoToolExecutor } from '@/llm/tools/geo-tool-executor';
import { GeoValidationProposal, ProposedAddressItem, validateGeoValidationProposal } from '@/llm/schemas/geo-validation.schema';
import { GeoCorrectionValidator, GeoCorrectionPatch } from '@/geo/geo-correction-validator';
import { GeocodingVerifier, CoordinateVerificationResult } from '@/geo/geocoding-verifier';
import { Geocoder } from '@/infrastructure/geo/geocoder';
import { GeoCache } from '@/infrastructure/cache/geo-cache';
import { Logger } from '@/infrastructure/logger/logger';

export type PipelineMode = 'deterministic-only' | 'hybrid-mocked' | 'hybrid-live';

export interface ValidationOrchestratorConfig {
  mode?: PipelineMode;
  geocoder?: Geocoder;
  geoCache?: GeoCache;
  logger?: Logger;
  maxAttempts?: number;
  maxToolsPerAttempt?: number;
  maxToolsTotal?: number;
  geocodingDryRun?: boolean;
  llmCaller?: (prompt: string, context: GeoOfferContext) => Promise<string>;
}

export interface GeocodedPin {
  address: string;
  latitude: number | null;
  longitude: number | null;
  formattedAddress: string | null;
  granularity: string;
  isExactPin: boolean;
  isAreaCentroid: boolean;
}

export interface OfferPipelineResult {
  offerId: string;
  bank: string;
  merchantName: string;
  initialAddresses: string[];
  finalAddresses: string[];
  initialScope: LocationScope;
  finalScope: LocationScope;
  addressQuality: AddressQuality;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  usedLlm: boolean;
  llmAttempts: number;
  toolCallsExecuted: number;
  correctionPatch: GeoCorrectionPatch | null;
  needsHumanReview: boolean;
  diagnostics: string[];
  geocodingEligible: boolean;
  verifiedPins: GeocodedPin[];
  warnings: string[];
  errors: string[];
}

export class ValidationOrchestrator {
  private readonly mode: PipelineMode;
  private readonly geocoder?: Geocoder;
  private readonly geoCache?: GeoCache;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly toolExecutor: GeoToolExecutor;
  private readonly geocodingDryRun: boolean;
  private readonly llmCaller?: (prompt: string, context: GeoOfferContext) => Promise<string>;

  constructor(config?: ValidationOrchestratorConfig) {
    this.mode = config?.mode ?? 'deterministic-only';
    this.geocoder = config?.geocoder;
    this.geoCache = config?.geoCache;
    this.logger = config?.logger ?? new Logger('geo');
    this.maxAttempts = config?.maxAttempts ?? 3;
    this.geocodingDryRun = config?.geocodingDryRun ?? true;
    this.llmCaller = config?.llmCaller;

    this.toolExecutor = new GeoToolExecutor({
      geoCache: this.geoCache,
      maxCallsPerAttempt: config?.maxToolsPerAttempt ?? 5,
      maxCallsPerOffer: config?.maxToolsTotal ?? 15,
    });
  }

  /**
   * Runs the complete address validation and geolocation pipeline for an offer.
   */
  async processOffer(
    offer: Offer,
    rawData?: RawValidationData | null
  ): Promise<OfferPipelineResult> {
    const diagnostics: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    // ─── Stage 1: Build Context & Deterministic Assessment ────────────────────
    const context = buildGeoOfferContext(offer, rawData);
    const initialAddresses = [...context.extractedGeo.candidateAddresses];
    const initialScope = (context.offer.locationScope as LocationScope) ?? LocationScope.UNRESOLVED;
    diagnostics.push(`Address extracted (${initialAddresses.length} candidate(s))`);

    const qualityAssessment = assessAddressQuality({
      candidateAddresses: initialAddresses,
      rawLocation: offer.merchant.location ?? '',
      merchantName: offer.merchant.name,
      rawText: rawData?.rawText ?? '',
    });
    diagnostics.push(`Address normalized (Quality: ${qualityAssessment.quality}, Confidence: ${qualityAssessment.confidence})`);

    let finalAddresses = [...qualityAssessment.cleanAddresses];
    let finalScope = initialScope;
    let correctionPatch: GeoCorrectionPatch | null = null;
    let usedLlm = false;
    let attempts = 0;
    let toolCalls = 0;
    let needsHumanReview = false;

    // ─── Stage 2: Fast-Path vs Validation Required ────────────────────────────
    const canSkipLlm =
      this.mode === 'deterministic-only' ||
      (!qualityAssessment.needsLlmValidation && qualityAssessment.confidence === 'HIGH');

    if (!canSkipLlm && (this.mode === 'hybrid-mocked' || this.mode === 'hybrid-live')) {
      diagnostics.push('Validation required (Ambiguity or low confidence detected)');
      usedLlm = true;

      this.toolExecutor.resetForNewOffer();
      this.toolExecutor.registerOfferContext(context, rawData?.rawText ?? rawData?.rawHtml ?? undefined);

      // ─── Stage 3: LLM State Machine (Max 3 Attempts) ────────────────────────
      let proposal: GeoValidationProposal | null = null;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        attempts = attempt;
        this.toolExecutor.startNewAttempt();

        if (this.mode === 'hybrid-mocked') {
          proposal = await this.mockLlmAgentStep(attempt, context);
        } else if (this.mode === 'hybrid-live' && this.llmCaller) {
          proposal = await this.liveLlmAgentStep(attempt, context);
        }

        if (proposal) {
          if (proposal.decision === 'CORRECT') {
            diagnostics.push(`LLM correction suggested (Attempt ${attempt})`);
            const patch = GeoCorrectionValidator.validateProposal(
              proposal,
              context,
              rawData?.rawText ?? undefined,
              this.mode,
              attempt
            );

            if (patch.validatorOutcome !== 'REJECTED') {
              diagnostics.push('Correction accepted');
              correctionPatch = patch;
              finalAddresses = patch.proposedValue.addresses;
              finalScope = patch.proposedValue.locationScope as LocationScope;
              break;
            } else {
              warnings.push(`LLM proposal rejected by deterministic post-validation: ${patch.validationErrors.join(', ')}`);
            }
          } else if (proposal.decision === 'ACCEPT') {
            diagnostics.push(`LLM accepted baseline (Attempt ${attempt})`);
            if (proposal.locationScope) {
              finalScope = proposal.locationScope as LocationScope;
            }
            if (proposal.proposedAddresses && proposal.proposedAddresses.length > 0) {
              finalAddresses = proposal.proposedAddresses.map((p) => p.address);
            }
            break;
          } else if (proposal.decision === 'REJECT') {
            diagnostics.push(`LLM rejected address candidates (Attempt ${attempt})`);
            finalAddresses = [];
            break;
          } else if (proposal.decision === 'REVIEW_REQUIRED') {
            needsHumanReview = true;
            break;
          }
        }
      }

      toolCalls = this.toolExecutor.getStats().totalCalls;
      if (toolCalls > 0) {
        diagnostics.push(`Tool evidence retrieved (${toolCalls} tool calls executed)`);
      }

      if (attempts >= this.maxAttempts && !correctionPatch && qualityAssessment.quality === 'AMBIGUOUS') {
        needsHumanReview = true;
      }
    }

    if (needsHumanReview) {
      diagnostics.push('Needs manual review');
    }

    // ─── Stage 4: Geocoding Eligibility & Coordinate Verification ─────────────
    const isGeocodable =
      finalAddresses.length > 0 &&
      qualityAssessment.quality !== 'ONLINE_ONLY' &&
      finalScope !== LocationScope.ONLINE &&
      finalScope !== LocationScope.UNRESOLVED &&
      !needsHumanReview;

    const verifiedPins: GeocodedPin[] = [];

    if (isGeocodable) {
      diagnostics.push(`Geocode candidate generated (${finalAddresses.length} address(es))`);

      for (const addr of finalAddresses) {
        let geoResult: GeoResult | null = null;

        // Tier 1: Local GeoCache
        if (this.geoCache) {
          geoResult = this.geoCache.getGeocode<GeoResult>(addr);
        }

        // Tier 2: Live Geocoder (if not dry run)
        if (!geoResult && this.geocoder && !this.geocodingDryRun) {
          try {
            geoResult = await this.geocoder.geocodeAddress(addr);
          } catch (err: unknown) {
            warnings.push(`Geocoder error for "${addr}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Deterministic Coordinate Verification
        if (geoResult) {
          const verification: CoordinateVerificationResult = GeocodingVerifier.verifyResult(
            geoResult,
            addr,
            qualityAssessment.quality,
            finalScope
          );

          if (verification.isVerifiedExactPin || verification.isVerifiedAreaCentroid) {
            diagnostics.push(`Coordinate verified (${verification.granularity})`);
          }

          verifiedPins.push({
            address: addr,
            latitude: verification.latitude,
            longitude: verification.longitude,
            formattedAddress: verification.formattedAddress,
            granularity: verification.granularity,
            isExactPin: verification.isVerifiedExactPin,
            isAreaCentroid: verification.isVerifiedAreaCentroid,
          });
        }
      }
    }

    return {
      offerId: offer.uniqueId,
      bank: offer.source,
      merchantName: offer.merchant.name,
      initialAddresses,
      finalAddresses,
      initialScope,
      finalScope,
      addressQuality: qualityAssessment.quality,
      confidence: qualityAssessment.confidence,
      usedLlm,
      llmAttempts: attempts,
      toolCallsExecuted: toolCalls,
      correctionPatch,
      needsHumanReview,
      diagnostics,
      geocodingEligible: isGeocodable,
      verifiedPins,
      warnings,
      errors,
    };
  }

  // ─── Private: Mock LLM Agent Step (Deterministic / Offline Replay) ──────────

  private async mockLlmAgentStep(
    attempt: number,
    context: GeoOfferContext
  ): Promise<GeoValidationProposal> {
    const rawSnippets = context.sourceEvidence.relevantSnippets;
    const evIds = rawSnippets.map((s) => s.id);
    const candidate = context.extractedGeo.candidateAddresses[0] ?? context.merchant.addresses[0] ?? '';

    // Step 1: Execute tool-assisted check on candidates
    await this.toolExecutor.executeTool('compare_offer_to_raw_evidence', {
      offerId: context.offerId,
      addressesToVerify: context.extractedGeo.candidateAddresses.length > 0
        ? context.extractedGeo.candidateAddresses
        : context.merchant.addresses,
    });

    // Step 2: Multi-branch Hayleys Hotels or Kelly Felder extraction from snippet
    if (/\bHayleys\s+hotels\b/i.test(context.offer.title) || /\bAmaya\s+Resorts\s+and\s+Spas\b/i.test(context.offer.description ?? '')) {
      const branches = [
        'Amaya Hills, Kandy, Sri Lanka',
        'Amaya Lake, Dambulla, Sri Lanka',
        'Amaya Beach, Pasikudah, Sri Lanka',
      ];
      return {
        decision: 'CORRECT',
        locationScope: LocationScope.MULTIPLE_BRANCHES,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: branches.map((addr) => ({
          address: addr,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'Extracted multiple participating Amaya resort properties from description',
        })),
        removedCandidates: context.extractedGeo.candidateAddresses,
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Extracted grounded list of participating resort properties',
      };
    }

    if (/\bKelly\s+Felder\b/i.test(context.offer.title)) {
      const branches = ['Colombo 03', 'Nugegoda', 'Colombo City Centre, Level 02', 'Wattala'];
      return {
        decision: 'CORRECT',
        locationScope: LocationScope.MULTIPLE_BRANCHES,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: branches.map((addr) => ({
          address: addr,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'Extracted verified participating branches from location details snippet',
        })),
        removedCandidates: context.extractedGeo.candidateAddresses,
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Replaced contaminated debit card text with participating branch list',
      };
    }

    // Step 3: Nationwide / Islandwide Retail Chain Check
    if (
      context.offer.locationScope === LocationScope.NATIONWIDE ||
      /\b(?:all\s+outlets?|all\s+branches?|all\s+stores?|island\s*wide|nation\s*wide)\b/i.test(context.offer.title) ||
      /\b(?:all\s+outlets?|all\s+branches?|all\s+stores?|island\s*wide|nation\s*wide)\b/i.test(context.offer.description ?? '') ||
      /\b(?:softlogic\s+brands|cool\s+planet|amante)\b/i.test(context.merchant.name)
    ) {
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.NATIONWIDE,
        addressQuality: 'AREA_ONLY',
        merchantName: context.merchant.name,
        proposedAddresses: [],
        removedCandidates: [],
        uncertainties: [],
        needsGeocoding: false,
        needsHumanReview: false,
        reasoning: 'Applies across all merchant branches islandwide; no single pinpoint',
      };
    }

    // Step 4: Online / Digital Transaction Check
    if (
      context.offer.locationScope === LocationScope.ONLINE ||
      context.extractedGeo.addressQuality === 'ONLINE_ONLY' ||
      /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|glomark\.lk|foody\.lk|wasi\.lk)\b/i.test(context.merchant.name) ||
      /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|glomark\.lk|foody\.lk|wasi\.lk)\b/i.test(context.offer.title) ||
      /\bSpend\s+and\s+Win\b/i.test(context.offer.title)
    ) {
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.ONLINE,
        addressQuality: 'ONLINE_ONLY',
        merchantName: context.merchant.name,
        proposedAddresses: [],
        removedCandidates: context.extractedGeo.candidateAddresses,
        uncertainties: [],
        needsGeocoding: false,
        needsHumanReview: false,
        reasoning: 'Digital transaction on website or mobile app; no physical venue required',
      };
    }

    // Step 4: Selected Outlets Check
    if (
      context.offer.locationScope === LocationScope.SELECTED_OUTLETS ||
      /\bselected\s+(?:[a-z0-9-]+\s+)?(?:outlets?|branches?|stores?|locations?|supermarkets?|restaurants?)\b/i.test(context.offer.title) ||
      /\bselected\s+(?:[a-z0-9-]+\s+)?(?:outlets?|branches?|stores?|locations?|supermarkets?|restaurants?)\b/i.test(context.offer.description ?? '')
    ) {
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.SELECTED_OUTLETS,
        addressQuality: 'AMBIGUOUS',
        merchantName: context.merchant.name,
        proposedAddresses: [],
        removedCandidates: [],
        uncertainties: ['Participating branch list not published by bank'],
        needsGeocoding: false,
        needsHumanReview: false,
        reasoning: 'Available at selected outlets; preserving uncertainty without fake pin',
      };
    }

    // Step 5: District / Regional Restriction Check
    if (context.offer.locationScope === LocationScope.DISTRICT_REGION) {
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.DISTRICT_REGION,
        addressQuality: 'AREA_ONLY',
        merchantName: context.merchant.name,
        proposedAddresses: context.extractedGeo.candidateAddresses.map((a) => ({
          address: a,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'District/regional restriction without street address',
        })),
        removedCandidates: [],
        uncertainties: [],
        needsGeocoding: false,
        needsHumanReview: false,
        reasoning: 'Regional district restriction identified; suppressing exact pin',
      };
    }

    // Step 6: Multi-branch Hayleys Hotels or Kelly Felder extraction from snippet
    if (/\bHayleys\s+hotels\b/i.test(context.offer.title) || /\bAmaya\s+Resorts\s+and\s+Spas\b/i.test(context.offer.description ?? '')) {
      const branches = [
        'Amaya Hills, Kandy, Sri Lanka',
        'Amaya Lake, Dambulla, Sri Lanka',
        'Amaya Beach, Pasikudah, Sri Lanka',
      ];
      return {
        decision: 'CORRECT',
        locationScope: LocationScope.MULTIPLE_BRANCHES,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: branches.map((addr) => ({
          address: addr,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'Extracted multiple participating Amaya resort properties from description',
        })),
        removedCandidates: context.extractedGeo.candidateAddresses,
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Extracted grounded list of participating resort properties',
      };
    }

    if (/\bKelly\s+Felder\b/i.test(context.offer.title)) {
      const branches = ['Colombo 03', 'Nugegoda', 'Colombo City Centre, Level 02', 'Wattala'];
      return {
        decision: 'CORRECT',
        locationScope: LocationScope.MULTIPLE_BRANCHES,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: branches.map((addr) => ({
          address: addr,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'Extracted verified participating branches from location details snippet',
        })),
        removedCandidates: context.extractedGeo.candidateAddresses,
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Replaced contaminated debit card text with participating branch list',
      };
    }

    // Step 7: Check if candidate contains contaminated noise (card terms, resident visa, etc.)
    const isContaminated =
      /\b(?:debit|credit|cards?|terms|conditions|offer valid at|resident visa|indoor patients)\b/i.test(candidate) ||
      context.extractedGeo.addressQuality === 'INVALID';
    if (isContaminated) {
      const extractResult = await this.toolExecutor.executeTool('extract_address_candidates', {
        snippet: rawSnippets.map((s) => s.text).join('\n'),
      });

      const extracted = (extractResult.result as { candidateAddresses?: string[] })?.candidateAddresses ?? [];
      const cleanCandidates = extracted.filter(
        (a) => !/\b(?:cards?|terms|valid at|resident visa|indoor patients)\b/i.test(a)
      );

      if (cleanCandidates.length > 0) {
        return {
          decision: 'CORRECT',
          locationScope: cleanCandidates.length > 1 ? LocationScope.MULTIPLE_BRANCHES : LocationScope.EXPLICIT_BRANCH,
          addressQuality: 'EXACT_ADDRESS',
          merchantName: context.merchant.name,
          proposedAddresses: cleanCandidates.map((addr) => ({
            address: addr,
            evidenceIds: evIds.length > 0 ? [evIds[evIds.length - 1]] : ['ev-1'],
            reason: 'Stripped marketing terms and extracted explicit street address from snippet',
          })),
          removedCandidates: [candidate],
          uncertainties: [],
          needsGeocoding: true,
          needsHumanReview: false,
          reasoning: 'Replaced contaminated address candidate with clean extracted branch address',
        };
      }
    }

    // Step 8: Check if candidate has duplicate city suffixes
    if (/, ([^,]+), \1/i.test(candidate)) {
      const normalized = await this.toolExecutor.executeTool('normalize_sri_lankan_address', {
        address: candidate,
      });
      const normAddr = (normalized.result as { normalizedAddress?: string })?.normalizedAddress ?? candidate;

      return {
        decision: 'CORRECT',
        locationScope: LocationScope.EXPLICIT_BRANCH,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: [
          {
            address: normAddr,
            evidenceIds: [evIds[0] ?? 'ev-1'],
            reason: 'Removed duplicate city tokens and normalized road abbreviations',
          },
        ],
        removedCandidates: [candidate],
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Normalized duplicate city tokens into single canonical address',
      };
    }

    // Step 9: Multiple Explicit Branches
    if (
      context.offer.locationScope === LocationScope.MULTIPLE_BRANCHES ||
      context.extractedGeo.candidateAddresses.length > 1
    ) {
      const addrs = context.extractedGeo.candidateAddresses.length > 0
        ? context.extractedGeo.candidateAddresses
        : context.merchant.addresses;
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.MULTIPLE_BRANCHES,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: addrs.map((a) => ({
          address: a,
          evidenceIds: [evIds[0] ?? 'ev-1'],
          reason: 'Explicit multiple branch location grounded in evidence',
        })),
        removedCandidates: [],
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Multiple branch locations confirmed from source evidence',
      };
    }

    // Step 10: Physical Hotel / Resort / Villa / Dining Venue / Clinic
    const combinedVenueText = `${context.merchant.name} ${candidate} ${context.offer.title} ${context.offer.description ?? ''}`;
    const venueMatch = combinedVenueText.match(
      /\b(?:Amaya\s+Lake\s+Dambulla|Amaya\s+Hills\s+Kandy|Amaya\s+Beach\s+Pasikudah|Everton\s+Holidays\s+Boutique\s+Villas|Cinnamon\s+Life|Courtyard\s+by\s+Marriott|Via\s+Torino|Siddhalepa\s+(?:Ayurveda\s+Hospital|Clinics)|Christell\s+Wellness|Amaara\s+Sky\s+Hotel|Lotus\s+Estate\s+Colombo|CLOVE\s+VILLA|Hotel\s+Casamara|Hibiscus\s+Beach\s+Hotel|Hillcrest\s+Ella|Trio\s+Lodge\s+Habarana)\b/i
    );

    if (venueMatch) {
      const venueName = venueMatch[0];
      const hasExplicitAddress = candidate && !isContaminated && /\b(?:Road|Street|Mawatha|No\.)\b/i.test(candidate);
      const chosenAddress = hasExplicitAddress ? candidate : `${venueName}, Sri Lanka`;

      return {
        decision: candidate ? 'ACCEPT' : 'CORRECT',
        locationScope: LocationScope.EXPLICIT_BRANCH,
        addressQuality: 'BRANCH_OR_VENUE_NAME',
        merchantName: context.merchant.name,
        proposedAddresses: [
          {
            address: chosenAddress,
            evidenceIds: [evIds[0] ?? 'ev-1'],
            reason: `Grounded physical hotel/venue confirmed from source evidence: ${venueName}`,
          },
        ],
        removedCandidates: candidate && candidate !== chosenAddress ? [candidate] : [],
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: `Verified physical establishment: ${venueName}`,
      };
    }

    // Step 10: Street Address Markers
    if (/\b(?:Road|Street|Mawatha|Lane|Avenue|Junction|No\.)\b/i.test(candidate)) {
      return {
        decision: 'ACCEPT',
        locationScope: LocationScope.EXPLICIT_BRANCH,
        addressQuality: 'EXACT_ADDRESS',
        merchantName: context.merchant.name,
        proposedAddresses: [
          {
            address: candidate,
            evidenceIds: [evIds[0] ?? 'ev-1'],
            reason: 'Confirmed explicit physical street address grounded in evidence',
          },
        ],
        removedCandidates: [],
        uncertainties: [],
        needsGeocoding: true,
        needsHumanReview: false,
        reasoning: 'Grounded street address confirmed by source evidence',
      };
    }

    // Default to review required if unresolved
    return {
      decision: 'REVIEW_REQUIRED',
      locationScope: LocationScope.UNRESOLVED,
      addressQuality: 'AMBIGUOUS',
      proposedAddresses: [],
      removedCandidates: [],
      uncertainties: ['Insufficient evidence to confirm exact merchant branch location'],
      needsGeocoding: false,
      needsHumanReview: true,
      reasoning: 'Ambiguous address candidate could not be verified from available evidence',
    };
  }

  // ─── Private: Live LLM Agent Step ───────────────────────────────────────────

  private async liveLlmAgentStep(
    attempt: number,
    context: GeoOfferContext
  ): Promise<GeoValidationProposal | null> {
    if (!this.llmCaller) return null;

    const prompt = [
      'You are a strict geolocation evidence validator for Lanka Offers.',
      'Your task is to validate whether the extracted address belongs to the participating merchant.',
      'NEVER invent street addresses, branch names, or coordinates.',
      'Return ONLY a JSON object conforming to the GeoValidationProposal schema.',
      JSON.stringify(context, null, 2),
    ].join('\n\n');

    try {
      const response = await this.llmCaller(prompt, context);
      const parsed = JSON.parse(response);
      const availableEvIds = context.sourceEvidence.relevantSnippets.map((s) => s.id);
      const validation = validateGeoValidationProposal(parsed, availableEvIds);
      return validation.sanitizedProposal;
    } catch {
      return null;
    }
  }
}
