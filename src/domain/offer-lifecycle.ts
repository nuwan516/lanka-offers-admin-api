/**
 * Offer operational lifecycle (publication state) — kept separate from
 * per-scrape change classification (see `OfferChangeStatus` below).
 *
 * Reuses the existing `db_status` column (extending its value set) rather
 * than introducing a second, overlapping status column.
 */
export type OfferLifecycleStatus =
  | 'DISCOVERED'
  | 'VALIDATED'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'EXPIRED'
  | 'DISABLED';

export const LIFECYCLE_STATUSES: OfferLifecycleStatus[] = [
  'DISCOVERED', 'VALIDATED', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'PUBLISHED', 'EXPIRED', 'DISABLED',
];

/** Per-scrape change classification — orthogonal to lifecycle status. */
export type OfferChangeStatus = 'NEW' | 'CHANGED' | 'UNCHANGED' | 'EXPIRED' | 'DUPLICATE' | 'FAILED';

export const CHANGE_STATUSES: OfferChangeStatus[] = [
  'NEW', 'CHANGED', 'UNCHANGED', 'EXPIRED', 'DUPLICATE', 'FAILED',
];

/** Admin-facing review actions (Step 6). */
export type OfferReviewAction =
  | 'APPROVE'
  | 'APPROVE_WITH_CORRECTIONS'
  | 'REJECT'
  | 'SEND_BACK'
  | 'DISABLE'
  | 'PUBLISH'
  | 'UNPUBLISH'
  | 'EXPIRE';

/** Allowed lifecycle transitions per action. `null` "from" means "any". */
const TRANSITIONS: Record<OfferReviewAction, { from: OfferLifecycleStatus[] | null; to: OfferLifecycleStatus }> = {
  APPROVE:                  { from: ['DISCOVERED', 'VALIDATED', 'REVIEW_REQUIRED'], to: 'APPROVED' },
  APPROVE_WITH_CORRECTIONS: { from: ['DISCOVERED', 'VALIDATED', 'REVIEW_REQUIRED'], to: 'APPROVED' },
  REJECT:                   { from: ['DISCOVERED', 'VALIDATED', 'REVIEW_REQUIRED', 'APPROVED'], to: 'REJECTED' },
  SEND_BACK:                { from: ['APPROVED', 'REJECTED'], to: 'REVIEW_REQUIRED' },
  DISABLE:                  { from: null, to: 'DISABLED' },
  PUBLISH:                  { from: ['APPROVED'], to: 'PUBLISHED' },
  UNPUBLISH:                { from: ['PUBLISHED'], to: 'REVIEW_REQUIRED' },
  EXPIRE:                   { from: ['DISCOVERED', 'VALIDATED', 'REVIEW_REQUIRED', 'APPROVED', 'PUBLISHED'], to: 'EXPIRED' },
};

export function nextLifecycleStatus(action: OfferReviewAction): OfferLifecycleStatus {
  return TRANSITIONS[action].to;
}

export function isValidTransition(from: OfferLifecycleStatus, action: OfferReviewAction): boolean {
  const rule = TRANSITIONS[action];
  if (!rule) return false;
  if (rule.from === null) return true;
  return rule.from.includes(from);
}

/** Only these lifecycle states may ever be returned by the public consumer API. */
export const PUBLIC_LIFECYCLE_STATUSES: OfferLifecycleStatus[] = ['PUBLISHED'];
