import { computeEffectiveOffer, sanitizeManualOverride } from '@/domain/effective-offer';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

function makeOffer(): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: 'https://bank.example/offer/1',
    title: 'Original Title',
    category: 'Dining',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Original Merchant', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
    offer: {
      description: 'Original description', discountPercentage: 20, applicableCards: [],
      bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-01-01', validTo: '2026-12-31',
        periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null, timeWindow: null, exclusionDays: null,
        blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
      },
    ],
    contentHash: 'a'.repeat(64),
    rawHtml: '<p>original raw evidence</p>',
  };
}

describe('computeEffectiveOffer', () => {
  it('returns the candidate unchanged when there is no override', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, null);
    expect(effective).toEqual(candidate);
  });

  it('overrides only the explicitly specified field', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, { 'offer.discountPercentage': 30 });

    expect(effective.offer.discountPercentage).toBe(30);
    expect(effective.title).toBe(candidate.title);
    expect(effective.merchant.name).toBe(candidate.merchant.name);
  });

  it('overrides a nested merchant field without touching sibling fields', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, { 'merchant.name': 'Corrected Merchant' });

    expect(effective.merchant.name).toBe('Corrected Merchant');
    expect(effective.merchant.location).toBe(candidate.merchant.location);
  });

  it('never mutates the original candidate object', () => {
    const candidate = makeOffer();
    computeEffectiveOffer(candidate, { title: 'Changed' });
    expect(candidate.title).toBe('Original Title');
  });

  it('preserves raw evidence (rawHtml) untouched — it is not editable', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, { rawHtml: 'tampered' } as never);
    expect(effective.rawHtml).toBe(candidate.rawHtml);
  });

  it('ignores an override on an immutable/non-editable field (sourceUrl)', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, { sourceUrl: 'https://evil.example' } as never);
    expect(effective.sourceUrl).toBe(candidate.sourceUrl);
  });
});

describe('sanitizeManualOverride', () => {
  it('strips keys not on the editable allowlist', () => {
    const clean = sanitizeManualOverride({ 'merchant.name': 'X', sourceUrl: 'evil', scrapedAt: 'evil', rawHtml: 'evil' });
    expect(clean).toEqual({ 'merchant.name': 'X' });
  });
});
