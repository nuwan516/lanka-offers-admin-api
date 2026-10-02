import {
  scoreDuplicateCandidate, computeValidityOverlapRatio,
  normalizeMerchantForCompare, normalizeTitleForCompare,
} from '@/domain/duplicate-detector';
import { resetDuplicatePolicyConfigCache } from '@/config/duplicate-policy';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001', source: 'hnb', sourceId: '001', sourceUrl: 'https://bank.example/offers/1',
    title: '20% off at Pizza Hut', category: 'Dining', categoryId: 1, cardType: 'Visa Signature',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Pizza Hut', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
    offer: {
      description: '20% off on all orders', discountPercentage: 20, applicableCards: [],
      bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Visa Signature'], networks: ['Visa'], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-09-01', validTo: '2026-09-30', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
    }],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => resetDuplicatePolicyConfigCache());

describe('normalization helpers', () => {
  it('normalizes merchant name variants for comparison only', () => {
    expect(normalizeMerchantForCompare('Pizza Hut')).toBe(normalizeMerchantForCompare('PIZZA HUT'));
    expect(normalizeMerchantForCompare('Pizza Hut')).toBe(normalizeMerchantForCompare('Pizza Hut Sri Lanka'));
  });

  it('keeps meaningful numbers in titles (does not merge 20% with 25%)', () => {
    const a = normalizeTitleForCompare('20% off dining');
    const b = normalizeTitleForCompare('25% off dining');
    expect(a).not.toBe(b);
    expect(a).toContain('20%');
    expect(b).toContain('25%');
  });
});

describe('computeValidityOverlapRatio', () => {
  it('returns 1 for identical ranges', () => {
    const a = makeOffer();
    const b = makeOffer();
    expect(computeValidityOverlapRatio(a, b)).toBe(1);
  });

  it('returns a partial ratio for partially overlapping ranges', () => {
    const a = makeOffer();
    const b = makeOffer({ validityPeriods: [{ ...a.validityPeriods[0], validFrom: '2026-09-15', validTo: '2026-10-15' }] });
    const ratio = computeValidityOverlapRatio(a, b);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });

  it('returns 0 when one side has unknown validity — never treats unknown as equal', () => {
    const a = makeOffer();
    const b = makeOffer({ validityPeriods: [{ ...a.validityPeriods[0], validFrom: null, validTo: null }] });
    expect(computeValidityOverlapRatio(a, b)).toBe(0);
  });

  it('returns 0 for non-overlapping ranges', () => {
    const a = makeOffer();
    const b = makeOffer({ validityPeriods: [{ ...a.validityPeriods[0], validFrom: '2026-01-01', validTo: '2026-01-31' }] });
    expect(computeValidityOverlapRatio(a, b)).toBe(0);
  });
});

describe('scoreDuplicateCandidate', () => {
  it('detects an EXACT_DUPLICATE within the same bank via identical content_hash', () => {
    const a = makeOffer({ uniqueId: 'hnb_001' });
    const b = makeOffer({ uniqueId: 'hnb_002', sourceUrl: 'https://bank.example/offers/2', sourceId: '002' });
    const result = scoreDuplicateCandidate(a, b);
    expect(result.classification).toBe('EXACT_DUPLICATE');
    expect(result.reasons.some((r) => r.includes('content_hash'))).toBe(true);
  });

  it('detects an EXACT_DUPLICATE within the same bank via identical source URL, even with a different content_hash', () => {
    const a = makeOffer({ contentHash: 'hash-a' });
    const b = makeOffer({ contentHash: 'hash-b', sourceId: '002' });
    const result = scoreDuplicateCandidate(a, b);
    expect(result.classification).toBe('EXACT_DUPLICATE');
  });

  it('classifies a highly similar same-bank offer under a different source as LIKELY_DUPLICATE', () => {
    const a = makeOffer({ contentHash: 'hash-a', sourceUrl: 'https://bank.example/offers/1', sourceId: '001' });
    const b = makeOffer({
      contentHash: 'hash-b', sourceUrl: 'https://bank.example/promo/pizza-hut-sept', sourceId: '999',
      title: '20 percent off Pizza Hut', merchant: { ...a.merchant, name: 'Pizza Hut Sri Lanka' },
    });
    const result = scoreDuplicateCandidate(a, b);
    expect(['LIKELY_DUPLICATE', 'EXACT_DUPLICATE']).toContain(result.classification);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it('does NOT auto-classify the same merchant+discount across different banks as a duplicate', () => {
    const hnb = makeOffer({ source: 'hnb', contentHash: 'hash-a' });
    const sampath = makeOffer({ source: 'sampath', uniqueId: 'sampath_001', contentHash: 'hash-b', sourceUrl: 'https://sampath.example/1', sourceId: 's1' });
    const result = scoreDuplicateCandidate(hnb, sampath);
    expect(result.classification).not.toBe('EXACT_DUPLICATE');
    expect(result.classification).not.toBe('LIKELY_DUPLICATE');
    expect(['NOT_DUPLICATE', 'CROSS_BANK_SIMILAR']).toContain(result.classification);
  });

  it('unknown validity on one side does not inflate the score into a duplicate classification', () => {
    const a = makeOffer({ contentHash: 'hash-a', title: 'Some offer', merchant: { ...makeOffer().merchant, name: 'Unrelated Shop' } });
    const b = makeOffer({
      contentHash: 'hash-b', sourceId: '999', sourceUrl: 'https://bank.example/offers/999',
      title: 'Different offer entirely', merchant: { ...makeOffer().merchant, name: 'Another Merchant' },
      validityPeriods: [{ ...a.validityPeriods[0], validFrom: null, validTo: null }],
      cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
      offer: { ...a.offer, discountPercentage: null },
    });
    const result = scoreDuplicateCandidate(a, b);
    expect(result.classification).toBe('NOT_DUPLICATE');
  });

  it('gives full marks for an unrelated offer no bonus points from unknown fields', () => {
    const a = makeOffer({ transactionRange: { min: null, max: null, currency: 'LKR' } });
    const b = makeOffer({ uniqueId: 'x', transactionRange: { min: null, max: null, currency: 'LKR' }, merchant: { ...a.merchant, name: 'Totally Different' }, contentHash: 'other', sourceId: 'x', sourceUrl: 'https://bank.example/x' });
    const result = scoreDuplicateCandidate(a, b);
    // both transactionRange sides null must not silently score as a match
    expect(result.reasons.some((r) => r.includes('transaction range'))).toBe(false);
  });
});
