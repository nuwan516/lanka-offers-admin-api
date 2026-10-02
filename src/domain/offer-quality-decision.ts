/**
 * Deterministic quality-gate decision (Step 2).
 *
 * Pure function — no DB/network — so behavior is fully unit-testable and
 * thresholds live in one config location (`src/config/quality-policy.ts`).
 */
import { getQualityPolicyConfig } from '@/config/quality-policy';

export type QualityDecision = 'AUTO_APPROVE' | 'REVIEW_REQUIRED' | 'REJECT';

export interface QualityDecisionInput {
  ruleValid: boolean;
  ruleErrorCount: number;
  ruleWarningCount: number;
  /** null when the LLM never ran (disabled, unavailable, or budget-blocked). */
  llmScore: number | null;
  llmValid: boolean | null;
  /** e.g. 'validated' | 'reused' | 'skipped_budget' | 'review_required' | null (not run). */
  llmStatus: string | null;
  isDuplicate?: boolean;
  /** Non-blocking context — informational only for now. */
  geoStatus?: string | null;
}

const NO_USABLE_LLM_SIGNAL = new Set(['skipped_budget', 'review_required']);

export function decideOfferQuality(input: QualityDecisionInput): QualityDecision {
  const policy = getQualityPolicyConfig();

  // Duplicates are never auto-rejected — they route to human review so a
  // false-positive match can't silently destroy a legitimate offer.
  if (input.isDuplicate) return 'REVIEW_REQUIRED';
  if (!input.ruleValid || input.ruleErrorCount > 0) return 'REVIEW_REQUIRED';

  const hasLlmSignal = input.llmScore !== null && input.llmValid !== null
    && !(input.llmStatus && NO_USABLE_LLM_SIGNAL.has(input.llmStatus));

  if (!hasLlmSignal) {
    if (policy.allowRuleOnlyAutoApprove && input.ruleWarningCount === 0) return 'AUTO_APPROVE';
    return 'REVIEW_REQUIRED';
  }

  const score = input.llmScore as number;

  // A very low score is a strong "this probably isn't a real offer" signal —
  // reject rather than clutter the review queue. Anything above the floor
  // (including llmValid===false at a middling score) goes to human review.
  if (score <= policy.rejectScoreFloor) return 'REJECT';
  if (input.llmValid === false) return 'REVIEW_REQUIRED';

  if (score >= policy.autoApproveScore && input.ruleWarningCount === 0) return 'AUTO_APPROVE';
  return 'REVIEW_REQUIRED';
}
