/**
 * Single configuration location for the automatic quality decision
 * (Step 2). Thresholds are env-driven so business rules never get
 * hardcoded across multiple files.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
}

export interface QualityPolicyConfig {
  /** LLM score at/above this, with rule-valid + no warnings, auto-approves. */
  autoApproveScore: number;
  /** LLM score below this is treated as a strong reject signal. */
  rejectScoreFloor: number;
  /** When true, an offer with no LLM signal (LLM disabled/unavailable) can still auto-approve on rule pass alone. */
  allowRuleOnlyAutoApprove: boolean;
}

let cached: QualityPolicyConfig | null = null;

export function getQualityPolicyConfig(): QualityPolicyConfig {
  if (!cached) {
    cached = {
      autoApproveScore: envNumber('QUALITY_AUTO_APPROVE_SCORE', 90),
      rejectScoreFloor: envNumber('QUALITY_REJECT_SCORE_FLOOR', 30),
      allowRuleOnlyAutoApprove: envBool('QUALITY_ALLOW_RULE_ONLY_AUTO_APPROVE', false),
    };
  }
  return cached;
}

export function resetQualityPolicyConfigCache(): void {
  cached = null;
}
