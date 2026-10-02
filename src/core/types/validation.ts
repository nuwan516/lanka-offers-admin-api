// ─── Rule-Based Validation ────────────────────────────────────────────────────

export interface FieldError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  errors: FieldError[];
  warnings: FieldError[];
}

export type LlmProvider = 'openai' | 'gemini' | 'deepseek';

export interface LlmScoreBreakdown {
  identity: number;
  merchant: number;
  offerDetails: number;
  validity: number;
  cardEligibility: number;
  locationAndContact: number;
  mediaAndSource: number;
  noHallucination: number;
}

export type LlmFieldVerdictStatus = 'supported' | 'unsupported' | 'unclear' | 'not_present';

export interface LlmFieldVerdict {
  verdict: LlmFieldVerdictStatus;
  citation: string | null;
  note: string | null;
}

export interface RawValidationData {
  rawHtml: string | null;
  rawText: string | null;
  rawListItem: unknown | null;
  rawDetail: unknown | null;
  sourceUrl: string | null;
}

export interface LlmValidationResult {
  /** Was the offer semantically coherent and valid? */
  isValidOffer: boolean;
  /** LLM-inferred category (may differ from scraper category). */
  inferredCategory: string | null;
  /** Extraction accuracy score 0-100 */
  extractionScore: number;
  /** Confidence 0–1 */
  confidence: number;
  /** A cleaned-up version of the title if it looks malformed. */
  suggestedTitle: string | null;
  /** Weighted score details. Values are 0-100 per section. */
  scoreBreakdown: LlmScoreBreakdown;
  /** Per-field evidence verdicts for important nested Offer fields. */
  fieldVerdicts: Record<string, LlmFieldVerdict>;
  /** Machine-readable issue tokens such as MISSING_VALIDITY or UNSUPPORTED_DISCOUNT. */
  issues: string[];
  /** True when raw source evidence was included in the validation prompt. */
  rawCompared: boolean;
  /** Prompt version for reproducibility. */
  promptVersion: string;
  /** Reasoning text from the LLM (for debugging). */
  reasoning: string;
  /** Provider used for this validation. */
  provider: LlmProvider;
  /** Model used. */
  model: string;
}

export interface ValidatorReport {
  offerId: string;
  ruleValidation: ValidationResult;
  llmValidation: LlmValidationResult | null;
  /** Final pass/fail accounting for both validators. */
  passed: boolean;
}
