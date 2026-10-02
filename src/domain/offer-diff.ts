/**
 * Reusable three-way diff helper (Part 10/11):
 *
 *   OLD PUBLISHED  vs  NEW SCRAPED CANDIDATE  vs  FINAL EFFECTIVE
 *
 * Deliberately does NOT recompute the merge itself — it takes the already
 * -computed effective offer (from `computeEffectiveOffer`, the single
 * authoritative merge helper) and just reports, per field, what changed
 * and why.
 */
import type { Offer } from '@/core/types/offers';
import { EDITABLE_FIELD_PATHS, type ManualOverride } from '@/domain/effective-offer';

export interface FieldDiffEntry {
  field: string;
  publishedValue: unknown;
  candidateValue: unknown;
  finalValue: unknown;
  /** True when the scraper's candidate differs from the previously published value. */
  candidateChanged: boolean;
  /** True when an admin manual override explicitly touched this field. */
  manuallyOverridden: boolean;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined),
    obj
  );
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * `published` is null when there is no separate previously-published
 * version to compare against (a brand-new offer, or one that was never
 * published) — in that case `candidateChanged` is always false since
 * there's nothing to have changed from.
 */
export function computeThreeWayDiff(
  published: Offer | null,
  candidate: Offer,
  effective: Offer,
  manualOverride: ManualOverride | null | undefined,
  fieldPaths: readonly string[] = EDITABLE_FIELD_PATHS,
  onlyChanged = false
): FieldDiffEntry[] {
  const overriddenPaths = new Set(Object.keys(manualOverride ?? {}));

  const entries = fieldPaths.map((field): FieldDiffEntry => {
    const publishedValue = published ? getPath(published, field) : null;
    const candidateValue = getPath(candidate, field);
    const finalValue = getPath(effective, field);
    const candidateChanged = published ? !valuesEqual(publishedValue, candidateValue) : false;
    return {
      field,
      publishedValue,
      candidateValue,
      finalValue,
      candidateChanged,
      manuallyOverridden: overriddenPaths.has(field),
    };
  });

  if (!onlyChanged) return entries;
  return entries.filter((e) => e.candidateChanged || e.manuallyOverridden);
}
