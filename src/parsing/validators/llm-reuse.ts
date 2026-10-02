/**
 * Pure decision logic for zero-cost LLM validation reuse (Step 4).
 *
 * Given an offer's current content_hash and the fingerprint stored from a
 * prior validation, decide whether that prior result can be reused instead
 * of calling the LLM again. Kept dependency-free (no DB, no network) so it's
 * trivially unit-testable and reusable outside the scrape CLI.
 */

import type { Offer } from '@/core/types/offers';
import type { LlmValidationResult, LlmProvider } from '@/core/types/validation';
import type { StoredLlmFingerprint } from '@/infrastructure/db/offer-repository';
import { EMPTY_SCORE_BREAKDOWN } from '@/parsing/validators/llm-validator';

export interface LlmReusePolicy {
  promptVersion: string;
  validatorVersion: string;
  provider: LlmProvider;
}

/** Fingerprint statuses that represent "no usable result" — retry, don't reuse. */
const NON_REUSABLE_STATUSES = new Set(['review_required', 'skipped_budget']);

export function buildReusableLlmValidation(
  fingerprint: StoredLlmFingerprint | undefined | null,
  offer: Offer,
  policy: LlmReusePolicy,
): LlmValidationResult | null {
  if (!fingerprint) return null;
  if (fingerprint.llmValidatedContentHash !== offer.contentHash) return null;
  if (fingerprint.llmPromptVersion !== policy.promptVersion) return null;
  if (fingerprint.llmValidatorVersion !== policy.validatorVersion) return null;
  if (!fingerprint.llmProvider || fingerprint.llmProvider !== policy.provider) return null;
  if (fingerprint.llmScore === null || fingerprint.llmValid === null) return null;
  if (fingerprint.llmStatus && NON_REUSABLE_STATUSES.has(fingerprint.llmStatus)) return null;

  return {
    isValidOffer: fingerprint.llmValid,
    inferredCategory: null,
    extractionScore: fingerprint.llmScore,
    confidence: 1,
    suggestedTitle: null,
    scoreBreakdown: { ...EMPTY_SCORE_BREAKDOWN },
    fieldVerdicts: {},
    issues: [],
    rawCompared: false,
    promptVersion: fingerprint.llmPromptVersion ?? policy.promptVersion,
    reasoning: 'Reused prior LLM validation (fingerprint match — content unchanged).',
    provider: fingerprint.llmProvider as LlmProvider,
    model: fingerprint.llmModel ?? '',
  };
}
