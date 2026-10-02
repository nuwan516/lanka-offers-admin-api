import { Offer } from '@/core/types/offers';
import {
  LlmValidationResult,
  RawValidationData,
  ValidationResult,
  ValidatorReport,
} from '@/core/types/validation';
import { OfferValidator } from './offer-validator';
import { LlmValidator } from './llm-validator';
import { ConcurrencyPool } from '@/infrastructure/concurrency/concurrency-pool';

export interface ValidationPipelineConfig {
  ruleValidator?: OfferValidator;
  llmValidator?: LlmValidator;
  /** Force LLM validation for every offer when available. */
  forceLlm?: boolean;
  /** Deterministic sample percentage for valid-looking offers, 0-100. */
  sampleRate?: number;
  /** Score below this is treated as failed when LLM ran. */
  minimumLlmScore?: number;
  /**
   * Zero-cost control hook: given an offer, return a previously-persisted
   * LLM validation result if it's still valid for the offer's *current*
   * content_hash + prompt/validator version + provider — or null if the
   * LLM must be (re-)called. Wired up in scrape.ts from a batch DB fetch so
   * this pipeline itself stays DB-agnostic and easy to unit test.
   */
  getReusableLlmValidation?: (offer: Offer) => LlmValidationResult | null;
}

export interface ValidationPipelineReport extends ValidatorReport {
  shouldUseLlm: boolean;
  llmReason: string | null;
  /** True when llmValidation came from a prior run's stored fingerprint, not a fresh call. */
  llmReused: boolean;
}

function hasWeakExtraction(offer: Offer, ruleValidation: ValidationResult): string | null {
  if (!ruleValidation.valid) return 'rule_errors';
  if (ruleValidation.warnings.length > 0) return 'rule_warnings';
  if (!offer.offer.description || offer.offer.description.trim().length < 12) return 'weak_description';
  if (offer.offer.discountPercentage === null || offer.offer.discountPercentage === '') return 'missing_discount';
  if (!offer.merchant.name || offer.merchant.name.trim().length === 0) return 'missing_merchant';
  if (offer.validityPeriods.length === 0) return 'missing_validity';
  if (!offer.rawHtml && !offer.sourceUrl) return 'missing_raw_evidence';
  return null;
}

function deterministicSample(uniqueId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 100) return true;
  let hash = 0;
  for (let i = 0; i < uniqueId.length; i++) {
    hash = Math.imul(31, hash) + uniqueId.charCodeAt(i) | 0;
  }
  return Math.abs(hash) % 100 < sampleRate;
}

export class ValidationPipeline {
  private readonly ruleValidator: OfferValidator;
  private readonly llmValidator: LlmValidator | undefined;
  private readonly forceLlm: boolean;
  private readonly sampleRate: number;
  private readonly minimumLlmScore: number;
  private readonly getReusableLlmValidation?: (offer: Offer) => LlmValidationResult | null;

  constructor(config: ValidationPipelineConfig = {}) {
    this.ruleValidator = config.ruleValidator ?? new OfferValidator();
    this.llmValidator = config.llmValidator;
    this.forceLlm = config.forceLlm ?? false;
    this.sampleRate = config.sampleRate ?? 2;
    this.minimumLlmScore = config.minimumLlmScore ?? 70;
    this.getReusableLlmValidation = config.getReusableLlmValidation;
  }

  async validateOffer(
    offer: Offer,
    rawData?: Partial<RawValidationData> | unknown,
  ): Promise<ValidationPipelineReport> {
    const ruleValidation = this.ruleValidator.validate(offer);
    const weakReason = hasWeakExtraction(offer, ruleValidation);
    const sampled = deterministicSample(offer.uniqueId, this.sampleRate);
    const llmReason = this.forceLlm
      ? 'forced'
      : weakReason ?? (sampled ? 'quality_sample' : null);
    const shouldUseLlm = Boolean(llmReason && this.llmValidator?.isAvailable);

    let llmValidation: LlmValidationResult | null = null;
    let llmReused = false;

    if (shouldUseLlm) {
      const reused = this.getReusableLlmValidation?.(offer) ?? null;
      if (reused) {
        llmValidation = reused;
        llmReused = true;
      } else {
        llmValidation = await this.llmValidator!.validate(offer, rawData);
      }
    }

    return {
      offerId: offer.uniqueId,
      ruleValidation,
      llmValidation,
      shouldUseLlm,
      llmReason,
      llmReused,
      passed: this.computePassed(ruleValidation, llmValidation),
    };
  }

  async validateBatch(
    offers: Offer[],
    rawDataByOfferId: Record<string, Partial<RawValidationData> | unknown> = {},
  ): Promise<ValidationPipelineReport[]> {
    // LLM calls dominate batch time — run them with bounded parallelism.
    // Results keep input order because pool.all resolves positionally.
    const pool = new ConcurrencyPool(4);
    return pool.all(
      offers.map((offer) => () => this.validateOffer(offer, rawDataByOfferId[offer.uniqueId])),
    );
  }

  private computePassed(
    ruleValidation: ValidationResult,
    llmValidation: LlmValidationResult | null,
  ): boolean {
    if (!ruleValidation.valid) return false;
    if (!llmValidation) return true;
    if (!llmValidation.isValidOffer) return false;
    return llmValidation.extractionScore >= this.minimumLlmScore || llmValidation.issues.includes('LLM_VALIDATION_FAILED');
  }
}
