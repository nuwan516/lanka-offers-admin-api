import * as crypto from 'crypto';
import { Offer } from '@/core/types/offers';

export interface StableOfferIdInput {
  source: string;
  sourceId?: string | number | null;
  sourceUrl?: string | null;
  merchantName?: string | null;
  title?: string | null;
  category?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface DedupeResult<T extends Offer> {
  offers: T[];
  duplicatesRemoved: number;
  duplicateIds: string[];
}

export function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function slugify(value: string | null | undefined, maxLength = 30): string {
  const slug = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/, '');
  return slug || 'offer';
}

export function normalizeMerchantName(name: string | null | undefined): string {
  return normalizeWhitespace(name)
    .replace(/\b(?:pvt|private)\s+ltd\b\.?/gi, '')
    .replace(/\bplc\b\.?/gi, '')
    .replace(/\b(?:restaurant|restaurants)\b/gi, '')
    .replace(/\bjewellers\b/gi, 'Jeweller')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stableHash(parts: Array<string | number | null | undefined>, length = 12): string {
  const input = parts
    .map((part) => normalizeWhitespace(part == null ? '' : String(part)).toLowerCase())
    .filter(Boolean)
    .join('|');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

// ─── Canonical business-content hash ───────────────────────────────────────
//
// `contentHash` is the version signature for an offer's *business content*.
// It must stay stable across re-scrapes that change nothing meaningful
// (HTML re-formatting, whitespace, field re-ordering) and must change when
// anything a user would actually notice changes: merchant, benefit,
// discount, card eligibility, transaction limits, validity window,
// installment terms, or important restrictions/terms.
//
// `unique_id` remains identity; `contentHash` is the content version.

function sortedList(values: Array<string | null | undefined>): string {
  return values
    .map((v) => normalizeWhitespace(v).toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

function numOrNull(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

export function computeOfferContentHash(offer: Offer): string {
  const cardEligibility = offer.cardEligibility ?? {
    includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [],
  };

  const validitySignature = (offer.validityPeriods ?? [])
    .map((v) =>
      [
        v.validFrom ?? '',
        v.validTo ?? '',
        v.periodType ?? '',
        v.recurrenceType ?? '',
        sortedList(v.recurrenceDays ?? []),
        v.timeWindow ? `${v.timeWindow.from}-${v.timeWindow.to}` : '',
        sortedList(v.exclusionDays ?? []),
        (v.blackoutPeriods ?? []).map((b) => `${b.from}~${b.to}`).sort().join(';'),
        normalizeWhitespace(v.exclusionNotes).toLowerCase(),
      ].join(':'),
    )
    .sort()
    .join('|');

  const installmentSignature = (offer.installmentPlans ?? [])
    .map((p) => `${p.months}m@${p.interestRate}%`)
    .sort()
    .join(',');

  const termsSignature = sortedList([
    ...(offer.offer?.restrictions ?? []),
    ...(offer.offer?.specialConditions ?? []),
    ...(offer.offer?.generalTerms ?? []),
  ]);

  const locationSignature = sortedList([
    offer.merchant?.location,
    ...(offer.merchant?.addresses ?? []),
  ]);

  const parts: Array<string | number | null | undefined> = [
    normalizeMerchantName(offer.merchant?.name),
    normalizeWhitespace(offer.title),
    normalizeWhitespace(offer.offer?.description),
    numOrNull(offer.offer?.discountPercentage),
    sortedList(cardEligibility.includedCards),
    sortedList(cardEligibility.excludedCards),
    sortedList(cardEligibility.cardTypes),
    sortedList(cardEligibility.networks),
    sortedList(cardEligibility.restrictions),
    numOrNull(offer.transactionRange?.min),
    numOrNull(offer.transactionRange?.max),
    validitySignature,
    installmentSignature,
    termsSignature,
    locationSignature,
  ];

  return crypto.createHash('sha256').update(parts.map((p) => p ?? '').join('||')).digest('hex');
}

export function stableOfferId(input: StableOfferIdInput): string {
  const source = slugify(input.source, 16);

  if (input.sourceId) {
    return `${source}_${slugify(String(input.sourceId), 48)}`;
  }

  if (input.sourceUrl) {
    const url = input.sourceUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
    const urlSlug = slugify(url.split('/').filter(Boolean).at(-1), 30);
    return `${source}_${stableHash([source, url], 12)}_${urlSlug}`;
  }

  const merchant = normalizeMerchantName(input.merchantName);
  const hash = stableHash([
    source,
    merchant,
    input.title,
    input.category,
    input.address,
    input.phone,
  ]);

  return `${source}_${hash}_${slugify(merchant || input.title || input.category)}`;
}

export function dedupeOffers<T extends Offer>(offers: T[]): DedupeResult<T> {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const deduped: T[] = [];

  for (const offer of offers) {
    if (seen.has(offer.uniqueId)) {
      duplicateIds.push(offer.uniqueId);
      continue;
    }
    seen.add(offer.uniqueId);
    deduped.push(offer);
  }

  return {
    offers: deduped,
    duplicatesRemoved: duplicateIds.length,
    duplicateIds,
  };
}
