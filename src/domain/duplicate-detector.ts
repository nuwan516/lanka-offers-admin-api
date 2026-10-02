/**
 * Deterministic, explainable duplicate scoring (Part 2/3/4/5).
 *
 * No embeddings, no LLM, no fuzzy-search infra. Pure functions only — safe
 * to unit test without a database and cheap enough to run on every
 * NEW/CHANGED offer.
 */
import type { Offer } from '@/core/types/offers';
import { normalizeMerchantName, normalizeWhitespace } from '@/parsing/normalization/offer-normalizer';
import { getDuplicatePolicyConfig } from '@/config/duplicate-policy';
import type { DuplicateClassification, DuplicateScoreResult } from '@/domain/duplicate-types';

// ─── Field normalization (comparison-only — never mutates stored data) ──────

/** Merchant normalization for duplicate comparison only. Reuses the shared
 *  normalizer, plus strips a small, safe set of trailing geography tokens
 *  ("Sri Lanka") so "Pizza Hut" and "Pizza Hut Sri Lanka" can match without
 *  merging genuinely different merchants. */
export function normalizeMerchantForCompare(name: string | null | undefined): string {
  return normalizeMerchantName(name)
    .replace(/\bsri lanka\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Title normalization for comparison only — keeps numbers/%/currency
 *  amounts since those affect offer identity (20% off vs 25% off differ). */
export function normalizeTitleForCompare(title: string | null | undefined): string {
  return normalizeWhitespace(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%.\s]/gu, ' ') // strip punctuation noise, keep letters/numbers/%/.
    .replace(/\s+/g, ' ')
    .trim();
}

function titleWordSet(title: string): Set<string> {
  return new Set(title.split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
}

// ─── Validity overlap (Part 5) ───────────────────────────────────────────────

/**
 * Returns an overlap ratio in [0, 1]. Unknown/missing validity on either
 * side NEVER counts as a match — it returns 0, never 1.
 */
export function computeValidityOverlapRatio(offerA: Offer, offerB: Offer): number {
  const a = offerA.validityPeriods?.[0];
  const b = offerB.validityPeriods?.[0];
  if (!a?.validFrom || !a?.validTo || !b?.validFrom || !b?.validTo) return 0;

  const aFrom = Date.parse(a.validFrom);
  const aTo = Date.parse(a.validTo);
  const bFrom = Date.parse(b.validFrom);
  const bTo = Date.parse(b.validTo);
  if ([aFrom, aTo, bFrom, bTo].some((t) => Number.isNaN(t))) return 0;

  const overlapStart = Math.max(aFrom, bFrom);
  const overlapEnd = Math.min(aTo, bTo);
  if (overlapEnd < overlapStart) return 0; // no overlap at all

  const overlapLen = overlapEnd - overlapStart;
  const unionLen = Math.max(aTo, bTo) - Math.min(aFrom, bFrom);
  if (unionLen <= 0) return overlapLen >= 0 ? 1 : 0; // identical single-day ranges
  return overlapLen / unionLen;
}

// ─── Field comparisons ────────────────────────────────────────────────────────

function discountsMatch(offerA: Offer, offerB: Offer): boolean {
  const a = offerA.offer?.discountPercentage;
  const b = offerB.offer?.discountPercentage;
  if (a === null || a === undefined || a === '' || b === null || b === undefined || b === '') return false;
  return String(a).trim() === String(b).trim();
}

function cardEligibilityOverlapRatio(offerA: Offer, offerB: Offer): number {
  const a = offerA.cardEligibility;
  const b = offerB.cardEligibility;
  const setA = new Set([...(a?.includedCards ?? []), ...(a?.cardTypes ?? []), ...(a?.networks ?? [])].map((s) => s.toLowerCase().trim()).filter(Boolean));
  const setB = new Set([...(b?.includedCards ?? []), ...(b?.cardTypes ?? []), ...(b?.networks ?? [])].map((s) => s.toLowerCase().trim()).filter(Boolean));
  return jaccard(setA, setB);
}

function transactionRangeMatches(offerA: Offer, offerB: Offer): boolean {
  const a = offerA.transactionRange;
  const b = offerB.transactionRange;
  if (a?.min == null || b?.min == null) {
    if (a?.max == null || b?.max == null) return false;
    return a.max === b.max;
  }
  return a.min === b.min && (a.max ?? null) === (b.max ?? null);
}

function locationScopeMatches(offerA: Offer, offerB: Offer): boolean {
  const locA = normalizeWhitespace(offerA.merchant?.location).toLowerCase();
  const locB = normalizeWhitespace(offerB.merchant?.location).toLowerCase();
  if (locA && locB) return locA === locB;

  const addrA = new Set((offerA.merchant?.addresses ?? []).map((s) => normalizeWhitespace(s).toLowerCase()).filter(Boolean));
  const addrB = new Set((offerB.merchant?.addresses ?? []).map((s) => normalizeWhitespace(s).toLowerCase()).filter(Boolean));
  if (addrA.size === 0 || addrB.size === 0) return false;
  return jaccard(addrA, addrB) > 0;
}

// ─── Identity shortcut for EXACT_DUPLICATE ───────────────────────────────────

function sameIdentity(offerA: Offer, offerB: Offer): { same: boolean; reason: string | null } {
  if (offerA.contentHash && offerB.contentHash && offerA.contentHash === offerB.contentHash) {
    return { same: true, reason: 'identical canonical content_hash' };
  }
  const urlA = normalizeSourceUrl(offerA.sourceUrl);
  const urlB = normalizeSourceUrl(offerB.sourceUrl);
  if (urlA && urlB && urlA === urlB) {
    return { same: true, reason: 'identical normalized source URL' };
  }
  if (offerA.sourceId && offerB.sourceId && String(offerA.sourceId) === String(offerB.sourceId)) {
    return { same: true, reason: 'identical stable source ID' };
  }
  return { same: false, reason: null };
}

// ─── Main scorer ──────────────────────────────────────────────────────────────

/**
 * Score two offers for duplication. `offerA`/`offerB` may be from the same
 * bank or different banks — cross-bank pairs are capped at
 * CROSS_BANK_SIMILAR regardless of score, per policy: cross-bank offers are
 * never automatically treated as duplicates.
 */
export function scoreDuplicateCandidate(offerA: Offer, offerB: Offer): DuplicateScoreResult {
  const policy = getDuplicatePolicyConfig();
  const w = policy.weights;
  const sameBank = offerA.source === offerB.source;
  const reasons: string[] = [];
  let score = 0;

  // Merchant
  const merchantA = normalizeMerchantForCompare(offerA.merchant?.name);
  const merchantB = normalizeMerchantForCompare(offerB.merchant?.name);
  if (merchantA && merchantB) {
    if (merchantA === merchantB) {
      score += w.merchant;
      reasons.push(`merchant matches exactly ("${merchantA}") (+${w.merchant})`);
    } else {
      const overlap = jaccard(titleWordSet(merchantA), titleWordSet(merchantB));
      if (overlap > 0) {
        const partial = Math.round(overlap * w.merchant);
        score += partial;
        if (partial > 0) reasons.push(`merchant names partially overlap (+${partial})`);
      }
    }
  }

  // Discount
  if (discountsMatch(offerA, offerB)) {
    score += w.discount;
    reasons.push(`discount value matches (+${w.discount})`);
  }

  // Card eligibility
  const cardOverlap = cardEligibilityOverlapRatio(offerA, offerB);
  if (cardOverlap > 0) {
    const partial = Math.round(cardOverlap * w.cardEligibility);
    if (partial > 0) {
      score += partial;
      reasons.push(`card eligibility overlaps ${Math.round(cardOverlap * 100)}% (+${partial})`);
    }
  }

  // Validity overlap
  const validityOverlap = computeValidityOverlapRatio(offerA, offerB);
  if (validityOverlap > 0) {
    const partial = Math.round(validityOverlap * w.validityOverlap);
    if (partial > 0) {
      score += partial;
      reasons.push(`validity periods overlap ${Math.round(validityOverlap * 100)}% (+${partial})`);
    }
  }

  // Title similarity
  const titleA = normalizeTitleForCompare(offerA.title);
  const titleB = normalizeTitleForCompare(offerB.title);
  if (titleA && titleB) {
    if (titleA === titleB) {
      score += w.titleSimilarity;
      reasons.push(`title matches exactly (+${w.titleSimilarity})`);
    } else {
      const overlap = jaccard(titleWordSet(titleA), titleWordSet(titleB));
      const partial = Math.round(overlap * w.titleSimilarity);
      if (partial > 0) {
        score += partial;
        reasons.push(`title text overlaps ${Math.round(overlap * 100)}% (+${partial})`);
      }
    }
  }

  // Transaction range
  if (transactionRangeMatches(offerA, offerB)) {
    score += w.transactionRange;
    reasons.push(`transaction range matches (+${w.transactionRange})`);
  }

  // Location scope
  if (locationScopeMatches(offerA, offerB)) {
    score += w.locationScope;
    reasons.push(`location scope matches (+${w.locationScope})`);
  }

  score = Math.min(100, Math.round(score));

  const identity = sameIdentity(offerA, offerB);
  let classification: DuplicateClassification;

  if (!sameBank) {
    // Cross-bank pairs are never auto-classified as duplicates, however
    // similar — eligibility/bank context differs (Part 1/12 Case D).
    classification = score >= policy.likelyThreshold ? 'CROSS_BANK_SIMILAR' : 'NOT_DUPLICATE';
    if (classification === 'CROSS_BANK_SIMILAR') {
      reasons.push('different banks — kept separate despite similarity');
    }
  } else if (identity.same) {
    classification = 'EXACT_DUPLICATE';
    reasons.unshift(identity.reason as string);
  } else if (score >= policy.exactThreshold) {
    classification = 'EXACT_DUPLICATE';
  } else if (score >= policy.likelyThreshold) {
    classification = 'LIKELY_DUPLICATE';
  } else {
    classification = 'NOT_DUPLICATE';
  }

  return { score, classification, reasons };
}
