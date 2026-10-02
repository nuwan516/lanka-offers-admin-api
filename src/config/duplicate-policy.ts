/**
 * Single configuration location for deterministic duplicate detection.
 * No embeddings, no LLM, no fuzzy-search infra — just weighted comparison
 * of normalized business fields, with thresholds kept out of the detector
 * code so they can be tuned without touching logic.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface DuplicateScoreWeights {
  merchant: number;
  discount: number;
  cardEligibility: number;
  validityOverlap: number;
  titleSimilarity: number;
  transactionRange: number;
  locationScope: number;
}

export interface DuplicatePolicyConfig {
  weights: DuplicateScoreWeights;
  /** Weighted score at/above this (same bank) classifies as LIKELY_DUPLICATE. */
  likelyThreshold: number;
  /** Weighted score at/above this (same bank) classifies as EXACT_DUPLICATE,
   *  in addition to the identity-based EXACT_DUPLICATE shortcut (same
   *  content_hash or same normalized source URL). */
  exactThreshold: number;
  /** LIKELY_DUPLICATE at/above this score forces the offer to REVIEW_REQUIRED. */
  reviewTriggerThreshold: number;
  /** Cap on how many same-bank rows are pulled for candidate scoring. */
  candidateSearchLimit: number;
  /** Only compare against offers whose validity hasn't been over for longer than this. */
  candidateMaxStaleDays: number;
}

let cached: DuplicatePolicyConfig | null = null;

export function getDuplicatePolicyConfig(): DuplicatePolicyConfig {
  if (!cached) {
    cached = {
      weights: {
        merchant: envNumber('DUPLICATE_WEIGHT_MERCHANT', 30),
        discount: envNumber('DUPLICATE_WEIGHT_DISCOUNT', 20),
        cardEligibility: envNumber('DUPLICATE_WEIGHT_CARD_ELIGIBILITY', 15),
        validityOverlap: envNumber('DUPLICATE_WEIGHT_VALIDITY', 15),
        titleSimilarity: envNumber('DUPLICATE_WEIGHT_TITLE', 10),
        transactionRange: envNumber('DUPLICATE_WEIGHT_TRANSACTION_RANGE', 5),
        locationScope: envNumber('DUPLICATE_WEIGHT_LOCATION', 5),
      },
      likelyThreshold: envNumber('DUPLICATE_LIKELY_THRESHOLD', 60),
      exactThreshold: envNumber('DUPLICATE_EXACT_THRESHOLD', 90),
      reviewTriggerThreshold: envNumber('DUPLICATE_REVIEW_TRIGGER_THRESHOLD', 60),
      candidateSearchLimit: envNumber('DUPLICATE_CANDIDATE_SEARCH_LIMIT', 50),
      candidateMaxStaleDays: envNumber('DUPLICATE_CANDIDATE_MAX_STALE_DAYS', 30),
    };
  }
  return cached;
}

export function resetDuplicatePolicyConfigCache(): void {
  cached = null;
}
