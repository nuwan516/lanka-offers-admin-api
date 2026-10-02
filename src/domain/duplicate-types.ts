/**
 * Duplicate concepts (Part 1). Kept distinct on purpose:
 *
 *  - EXACT_DUPLICATE: same bank + (same canonical content_hash OR same
 *    normalized source URL/identity). Near-certain — same offer re-seen.
 *  - LIKELY_DUPLICATE: same bank, high weighted similarity, but source
 *    identity differs (e.g. two separate listing URLs for one promotion).
 *  - CROSS_BANK_SIMILAR: high similarity but different banks. NEVER treated
 *    as a duplicate automatically — eligibility/bank context differs, so
 *    these must remain separate offers. Informational only.
 *  - NOT_DUPLICATE: below threshold.
 */
export type DuplicateClassification =
  | 'NOT_DUPLICATE'
  | 'LIKELY_DUPLICATE'
  | 'EXACT_DUPLICATE'
  | 'CROSS_BANK_SIMILAR';

export interface DuplicateScoreResult {
  score: number;
  classification: DuplicateClassification;
  reasons: string[];
}

/** Admin review outcome for a stored candidate pair (Part 6). */
export type DuplicateReviewStatus = 'PENDING' | 'CONFIRMED_DUPLICATE' | 'NOT_DUPLICATE' | 'IGNORED';

export const DUPLICATE_REVIEW_STATUSES: DuplicateReviewStatus[] = [
  'PENDING', 'CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'IGNORED',
];
