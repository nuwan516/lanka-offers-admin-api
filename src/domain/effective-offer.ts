/**
 * Single authoritative "effective offer" merge helper (Step 9).
 *
 * effective_offer = normalized_offer + manual_overrides
 *
 * `manualOverride` is a flat map of dot-paths to override values (e.g.
 * `{ "merchant.name": "Corrected Name", "offer.discountPercentage": 25 }`)
 * so only explicitly-overridden fields win — everything else keeps the
 * scraped/normalized value untouched. Immutable source metadata
 * (sourceUrl, scrapedAt, rawHtml) is never in the editable allowlist, so
 * it can never be overridden even if present in the override map.
 */
import type { Offer } from '@/core/types/offers';

/** Fields an admin is allowed to correct (Step 5). Dot-paths into `Offer`. */
export const EDITABLE_FIELD_PATHS = [
  'title',
  'category',
  'cardType',
  'merchant.name',
  'merchant.location',
  'merchant.addresses',
  'merchant.phone',
  'merchant.email',
  'merchant.website',
  'offer.description',
  'offer.discountPercentage',
  'offer.applicableCards',
  'offer.restrictions',
  'offer.specialConditions',
  'offer.generalTerms',
  'transactionRange.min',
  'transactionRange.max',
  'cardEligibility.includedCards',
  'cardEligibility.excludedCards',
  'cardEligibility.cardTypes',
  'cardEligibility.networks',
  'cardEligibility.restrictions',
  'validityPeriods',
] as const;

export type EditableFieldPath = typeof EDITABLE_FIELD_PATHS[number];

const EDITABLE_SET = new Set<string>(EDITABLE_FIELD_PATHS);

export type ManualOverride = Record<string, unknown>;

/** Strips any key not on the editable allowlist — defense in depth beyond the API-layer check. */
export function sanitizeManualOverride(override: ManualOverride): ManualOverride {
  const clean: ManualOverride = {};
  for (const [path, value] of Object.entries(override ?? {})) {
    if (EDITABLE_SET.has(path)) clean[path] = value;
  }
  return clean;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cursor[key];
    cursor[key] = (next && typeof next === 'object') ? { ...(next as Record<string, unknown>) } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Merge a normalized candidate offer with sanitized manual overrides.
 * Only paths present in `manualOverride` are changed; everything else is
 * copied from `candidate` as-is (including immutable fields like rawHtml).
 */
export function computeEffectiveOffer(candidate: Offer, manualOverride: ManualOverride | null | undefined): Offer {
  const effective: Offer = JSON.parse(JSON.stringify(candidate));
  if (!manualOverride) return effective;

  const clean = sanitizeManualOverride(manualOverride);
  for (const [path, value] of Object.entries(clean)) {
    setPath(effective as unknown as Record<string, unknown>, path, value);
  }
  return effective;
}
