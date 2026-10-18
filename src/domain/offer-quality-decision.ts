/**
 * Deterministic quality-gate decision (Step 2).
 *
 * Pure function — no DB/network — so behavior is fully unit-testable and
 * thresholds live in one config location (`src/config/quality-policy.ts`).
 */
import { getQualityPolicyConfig } from '@/config/quality-policy';

export type QualityDecision = 'AUTO_APPROVE' | 'REVIEW_REQUIRED' | 'REJECT';

export type ExtendedQualityCategory =
  | 'VALID_HIGH_CONFIDENCE'
  | 'VALID_WITH_WARNINGS'
  | 'REVIEW_REQUIRED'
  | 'INVALID'
  | 'DUPLICATE_CANDIDATE'
  | 'SOURCE_INCOMPLETE';

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
  isSourceIncomplete?: boolean;
  /** Non-blocking context — informational only for now. */
  geoStatus?: string | null;
}

export interface DetailedQualityAssessment {
  decision: QualityDecision;
  category: ExtendedQualityCategory;
  reasons: string[];
}

const NO_USABLE_LLM_SIGNAL = new Set(['skipped_budget', 'review_required']);

export function classifyDetailedOfferQuality(input: QualityDecisionInput): DetailedQualityAssessment {
  const policy = getQualityPolicyConfig();
  const reasons: string[] = [];

  // 1. Source incomplete
  if (input.isSourceIncomplete) {
    reasons.push('Source payload is incomplete or missing essential promotion attributes');
    return { decision: 'REVIEW_REQUIRED', category: 'SOURCE_INCOMPLETE', reasons };
  }

  // 2. Duplicate candidate
  if (input.isDuplicate) {
    reasons.push('Candidate matched an existing offer with high similarity; routed to manual review');
    return { decision: 'REVIEW_REQUIRED', category: 'DUPLICATE_CANDIDATE', reasons };
  }

  // 3. Rule validation failure
  if (!input.ruleValid || input.ruleErrorCount > 0) {
    reasons.push(`Deterministic parser rule validation failed with ${input.ruleErrorCount} error(s)`);
    return { decision: 'REVIEW_REQUIRED', category: 'INVALID', reasons };
  }

  const hasLlmSignal = input.llmScore !== null && input.llmValid !== null
    && !(input.llmStatus && NO_USABLE_LLM_SIGNAL.has(input.llmStatus));

  if (!hasLlmSignal) {
    if (policy.allowRuleOnlyAutoApprove && input.ruleWarningCount === 0) {
      reasons.push('Rule-only validation passed with 0 errors and 0 warnings (policy allows auto-approve)');
      return { decision: 'AUTO_APPROVE', category: 'VALID_HIGH_CONFIDENCE', reasons };
    }
    reasons.push(
      input.ruleWarningCount > 0
        ? `Passed rules with ${input.ruleWarningCount} warning(s) but lacks LLM verification`
        : 'Rule-valid but awaiting LLM verification or manual sign-off'
    );
    return {
      decision: 'REVIEW_REQUIRED',
      category: input.ruleWarningCount > 0 ? 'VALID_WITH_WARNINGS' : 'REVIEW_REQUIRED',
      reasons,
    };
  }

  const score = input.llmScore as number;

  // 4. Reject floor
  if (score <= policy.rejectScoreFloor) {
    reasons.push(`Semantic LLM extraction score (${score}/100) is at or below rejection floor (${policy.rejectScoreFloor})`);
    return { decision: 'REJECT', category: 'INVALID', reasons };
  }

  // 5. LLM marked invalid
  if (input.llmValid === false) {
    reasons.push('LLM semantic validator flagged potential contradictions or invalid promotion structure');
    return { decision: 'REVIEW_REQUIRED', category: 'REVIEW_REQUIRED', reasons };
  }

  // 6. Warnings present
  if (input.ruleWarningCount > 0) {
    reasons.push(`LLM score is high (${score}/100) but offer triggered ${input.ruleWarningCount} validation warning(s)`);
    return { decision: 'REVIEW_REQUIRED', category: 'VALID_WITH_WARNINGS', reasons };
  }

  // 7. Auto-approve score reached
  if (score >= policy.autoApproveScore) {
    reasons.push(`High confidence: 0 rule errors/warnings and LLM score (${score}/100) meets auto-approve threshold (${policy.autoApproveScore})`);
    return { decision: 'AUTO_APPROVE', category: 'VALID_HIGH_CONFIDENCE', reasons };
  }

  reasons.push(`LLM score (${score}/100) is above floor but below auto-approve threshold (${policy.autoApproveScore})`);
  return { decision: 'REVIEW_REQUIRED', category: 'REVIEW_REQUIRED', reasons };
}

export function decideOfferQuality(input: QualityDecisionInput): QualityDecision {
  return classifyDetailedOfferQuality(input).decision;
}
