/**
 * Lanka Offers — Geo Tool Executor
 *
 * Implements bounded, deterministic execution of the 10 geo tools.
 * Enforces per-tool timeouts, input validation, max-call budgets, and read-only isolation.
 */

import { AddressEngine } from '@/parsing/address/address-engine';
import { normalizeSriLankanAddress } from '@/parsing/address/lk-address-normalizer';
import { determineLocationScope } from '@/domain/location-scope';
import { assessAddressQuality, sanitizeAddressString } from '@/geo/address-quality';
import { GeoOfferContext } from '@/geo/geo-evidence';
import { GeoCache } from '@/infrastructure/cache/geo-cache';
import { validateGeoValidationProposal, GeoValidationProposal } from '@/llm/schemas/geo-validation.schema';

export interface ToolExecutionStats {
  totalCalls: number;
  callsPerTool: Record<string, number>;
  totalExecutionTimeMs: number;
}

export interface GeoToolExecutorConfig {
  geoCache?: GeoCache;
  maxCallsPerAttempt?: number;
  maxCallsPerOffer?: number;
  toolTimeoutMs?: number;
}

export class GeoToolExecutor {
  private readonly addressEngine: AddressEngine;
  private readonly geoCache?: GeoCache;
  private readonly maxCallsPerAttempt: number;
  private readonly maxCallsPerOffer: number;
  private readonly toolTimeoutMs: number;

  private totalOfferCalls = 0;
  private currentAttemptCalls = 0;
  private callsPerTool: Record<string, number> = {};
  private activeContexts: Map<string, GeoOfferContext> = new Map();
  private rawSourceMap: Map<string, string> = new Map();

  constructor(config?: GeoToolExecutorConfig) {
    this.addressEngine = new AddressEngine({ country: 'Sri Lanka' });
    this.geoCache = config?.geoCache;
    this.maxCallsPerAttempt = config?.maxCallsPerAttempt ?? 5;
    this.maxCallsPerOffer = config?.maxCallsPerOffer ?? 15;
    this.toolTimeoutMs = config?.toolTimeoutMs ?? 1000;
  }

  /**
   * Registers active offer context and complete raw source for an offer.
   */
  registerOfferContext(context: GeoOfferContext, completeRawSource?: string): void {
    this.activeContexts.set(context.offerId, context);
    if (completeRawSource) {
      this.rawSourceMap.set(context.offerId, completeRawSource);
    }
  }

  /**
   * Resets attempt-level counters when starting a new LLM attempt.
   */
  startNewAttempt(): void {
    this.currentAttemptCalls = 0;
  }

  /**
   * Resets all counters for a new offer.
   */
  resetForNewOffer(): void {
    this.totalOfferCalls = 0;
    this.currentAttemptCalls = 0;
    this.callsPerTool = {};
    this.activeContexts.clear();
    this.rawSourceMap.clear();
  }

  getStats(): ToolExecutionStats {
    return {
      totalCalls: this.totalOfferCalls,
      callsPerTool: { ...this.callsPerTool },
      totalExecutionTimeMs: 0,
    };
  }

  /**
   * Executes an allowlisted tool call with timeout and quota constraints.
   */
  async executeTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (this.totalOfferCalls >= this.maxCallsPerOffer) {
      return { success: false, error: `Exceeded maximum total tool calls per offer (${this.maxCallsPerOffer})` };
    }

    if (this.currentAttemptCalls >= this.maxCallsPerAttempt) {
      return { success: false, error: `Exceeded maximum tool calls for current attempt (${this.maxCallsPerAttempt})` };
    }

    this.totalOfferCalls++;
    this.currentAttemptCalls++;
    this.callsPerTool[name] = (this.callsPerTool[name] ?? 0) + 1;

    try {
      const toolPromise = this.dispatchTool(name, args);
      const timeoutPromise = new Promise<{ success: boolean; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${this.toolTimeoutMs}ms`)), this.toolTimeoutMs)
      );

      const result = await Promise.race([toolPromise, timeoutPromise]);
      return { success: true, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_raw_offer_evidence':
        return this.toolGetRawOfferEvidence(args);

      case 'extract_address_candidates':
        return this.toolExtractAddressCandidates(args);

      case 'normalize_sri_lankan_address':
        return this.toolNormalizeSriLankanAddress(args);

      case 'classify_location_scope':
        return this.toolClassifyLocationScope(args);

      case 'compare_offer_to_raw_evidence':
        return this.toolCompareOfferToRawEvidence(args);

      case 'validate_branch_list':
        return this.toolValidateBranchList(args);

      case 'lookup_merchant_geo_cache':
        return this.toolLookupMerchantGeoCache(args);

      case 'retrieve_additional_source_context':
        return this.toolRetrieveAdditionalSourceContext(args);

      case 'validate_corrected_offer':
        return this.toolValidateCorrectedOffer(args);

      case 'submit_correction_proposal':
        return this.toolSubmitCorrectionProposal(args);

      default:
        throw new Error(`Unknown or unauthorized tool: "${name}"`);
    }
  }

  // ─── Tool 1: get_raw_offer_evidence ──────────────────────────────────────────

  private toolGetRawOfferEvidence(args: Record<string, unknown>): unknown {
    const offerId = String(args.offerId ?? '');
    const context = this.activeContexts.get(offerId);
    if (!context) {
      return { found: false, message: `No active context registered for offerId: ${offerId}` };
    }

    const maxChars = Math.min(Number(args.maxChars) || 1500, 2000);
    const section = String(args.section ?? 'all').toLowerCase();

    const snippets = context.sourceEvidence.relevantSnippets
      .filter((s) => {
        if (section === 'terms') return s.sourceLocation.includes('terms');
        if (section === 'details') return s.sourceLocation.includes('offer');
        return true;
      })
      .map((s) => ({
        id: s.id,
        location: s.sourceLocation,
        text: s.text.slice(0, maxChars),
      }));

    return {
      offerId,
      bank: context.bank,
      merchantName: context.merchant.name,
      snippets,
      evidenceHash: context.sourceEvidence.evidenceHash,
    };
  }

  // ─── Tool 2: extract_address_candidates ──────────────────────────────────────

  private toolExtractAddressCandidates(args: Record<string, unknown>): unknown {
    const snippet = String(args.snippet ?? '').slice(0, 4000);
    const candidates = this.addressEngine.extract(snippet);
    return {
      count: candidates.length,
      candidateAddresses: candidates,
    };
  }

  // ─── Tool 3: normalize_sri_lankan_address ────────────────────────────────────

  private toolNormalizeSriLankanAddress(args: Record<string, unknown>): unknown {
    const rawAddress = String(args.address ?? '').slice(0, 500);
    const normalized = normalizeSriLankanAddress(rawAddress);
    return {
      rawAddress,
      normalizedAddress: normalized.normalizedAddress,
      precision: normalized.precision,
      district: normalized.district,
      city: normalized.city,
      postalZone: normalized.postalZone,
      isJunction: normalized.isJunction,
    };
  }

  // ─── Tool 4: classify_location_scope ─────────────────────────────────────────

  private toolClassifyLocationScope(args: Record<string, unknown>): unknown {
    const merchantName = String(args.merchantName ?? '');
    const addresses = Array.isArray(args.addresses) ? args.addresses.map(String) : [];
    const rawText = String(args.rawText ?? '');

    const scopeResult = determineLocationScope({
      merchantName,
      addresses,
      description: rawText,
    });

    return {
      scope: scopeResult.scope,
      region: scopeResult.region ?? null,
      explanation: scopeResult.explanation,
      isGeocodableToCoordinates: scopeResult.isGeocodableToCoordinates,
    };
  }

  // ─── Tool 5: compare_offer_to_raw_evidence ───────────────────────────────────

  private toolCompareOfferToRawEvidence(args: Record<string, unknown>): unknown {
    const offerId = String(args.offerId ?? '');
    const toVerify = Array.isArray(args.addressesToVerify) ? args.addressesToVerify.map(String) : [];
    const context = this.activeContexts.get(offerId);

    const fullEvidenceText = [
      ...(context?.sourceEvidence.relevantSnippets.map((s) => s.text) ?? []),
      this.rawSourceMap.get(offerId) ?? '',
    ].join(' ').toLowerCase();

    const results = toVerify.map((addr) => {
      const clean = sanitizeAddressString(addr).toLowerCase();
      // Check full substring match
      const exactMatch = fullEvidenceText.includes(clean);
      if (exactMatch) {
        return { address: addr, supported: true, matchType: 'EXACT_SUBSTRING' };
      }

      // Check key token overlap (words with 4+ characters)
      const tokens = clean.split(/[\s,]+/).filter((t) => t.length >= 4);
      const matchedTokens = tokens.filter((t) => fullEvidenceText.includes(t));
      const tokenRatio = tokens.length > 0 ? matchedTokens.length / tokens.length : 0;

      return {
        address: addr,
        supported: tokenRatio >= 0.6,
        matchType: tokenRatio >= 0.6 ? 'PARTIAL_TOKENS' : 'NOT_SUPPORTED',
        tokenOverlapRatio: Math.round(tokenRatio * 100) / 100,
        unmatchedTokens: tokens.filter((t) => !fullEvidenceText.includes(t)),
      };
    });

    return {
      offerId,
      verificationResults: results,
      allSupported: results.every((r) => r.supported),
    };
  }

  // ─── Tool 6: validate_branch_list ────────────────────────────────────────────

  private toolValidateBranchList(args: Record<string, unknown>): unknown {
    const branches = Array.isArray(args.candidateBranches) ? args.candidateBranches.map(String) : [];
    const merchantName = String(args.merchantName ?? '').toLowerCase().trim();

    const validBranches: string[] = [];
    const rejectedItems: Array<{ branch: string; reason: string }> = [];
    const seen = new Set<string>();

    for (const b of branches) {
      const cleaned = sanitizeAddressString(b);
      if (cleaned.length < 3) {
        rejectedItems.push({ branch: b, reason: 'Too short' });
        continue;
      }

      const quality = assessAddressQuality({ candidateAddresses: [cleaned], merchantName });
      if (quality.quality === 'INVALID') {
        rejectedItems.push({ branch: b, reason: quality.reasons.join(', ') });
        continue;
      }

      // Safe deduplication: check normalized key
      const normKey = cleaned.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(normKey)) {
        rejectedItems.push({ branch: b, reason: 'Duplicate branch' });
        continue;
      }

      seen.add(normKey);
      validBranches.push(cleaned);
    }

    return {
      validBranchCount: validBranches.length,
      validBranches,
      rejectedCount: rejectedItems.length,
      rejectedItems,
    };
  }

  // ─── Tool 7: lookup_merchant_geo_cache ───────────────────────────────────────

  private toolLookupMerchantGeoCache(args: Record<string, unknown>): unknown {
    const query = String(args.query ?? '').trim();
    if (!this.geoCache || !query) {
      return { hit: false, query, message: 'GeoCache not configured or empty query' };
    }

    const cached = this.geoCache.getGeocode<{
      formattedAddress?: string;
      latitude?: number;
      longitude?: number;
      placeId?: string;
    }>(query);

    if (cached) {
      return {
        hit: true,
        query,
        result: {
          formattedAddress: cached.formattedAddress,
          placeId: cached.placeId,
          hasCoordinates: Boolean(cached.latitude && cached.longitude),
        },
      };
    }

    return { hit: false, query };
  }

  // ─── Tool 8: retrieve_additional_source_context ──────────────────────────────

  private toolRetrieveAdditionalSourceContext(args: Record<string, unknown>): unknown {
    const offerId = String(args.offerId ?? '');
    const raw = this.rawSourceMap.get(offerId);
    if (!raw) {
      return { found: false, message: `No additional raw source cached for offer: ${offerId}` };
    }

    const offset = Math.max(0, Number(args.offset) || 0);
    const length = Math.min(Math.max(100, Number(args.length) || 500), 1000);

    const windowText = raw.slice(offset, offset + length);
    return {
      offerId,
      offset,
      length: windowText.length,
      totalSourceLength: raw.length,
      snippet: windowText,
    };
  }

  // ─── Tool 9: validate_corrected_offer ────────────────────────────────────────

  private toolValidateCorrectedOffer(args: Record<string, unknown>): unknown {
    const addresses = Array.isArray(args.candidateAddresses) ? args.candidateAddresses.map(String) : [];
    const merchantName = String(args.merchantName ?? '');

    const quality = assessAddressQuality({
      candidateAddresses: addresses,
      merchantName,
    });

    return {
      quality: quality.quality,
      score: quality.score,
      confidence: quality.confidence,
      isGeocodableToExactPin: quality.isGeocodableToExactPin,
      reasons: quality.reasons,
      invalidPatternsMatched: quality.invalidPatternsMatched,
      cleanAddresses: quality.cleanAddresses,
    };
  }

  // ─── Tool 10: submit_correction_proposal ─────────────────────────────────────

  private toolSubmitCorrectionProposal(args: Record<string, unknown>): unknown {
    // Validates proposal format
    const context = [...this.activeContexts.values()][0];
    const availableEvIds = context?.sourceEvidence.relevantSnippets.map((s) => s.id) ?? [];

    const validation = validateGeoValidationProposal(args, availableEvIds);
    if (!validation.valid) {
      return {
        accepted: false,
        errors: validation.errors,
      };
    }

    return {
      accepted: true,
      proposal: validation.sanitizedProposal,
      timestamp: new Date().toISOString(),
    };
  }
}
