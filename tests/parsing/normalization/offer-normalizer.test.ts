import {
  dedupeOffers,
  normalizeMerchantName,
  slugify,
  stableOfferId,
  computeOfferContentHash,
} from '@/parsing/normalization/offer-normalizer';
import type { Offer } from '@/core/types/offers';

function makeOffer(uniqueId: string): Offer {
  return {
    uniqueId,
    source: 'hnb',
    sourceId: uniqueId,
    sourceUrl: null,
    title: 'Demo Offer',
    category: 'Dining',
    categoryId: 1,
    cardType: '',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: {
      name: 'Demo',
      location: null,
      addresses: [],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: '',
      discountPercentage: null,
      applicableCards: [],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: [],
      networks: [],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [],
    contentHash: 'a'.repeat(64),
  };
}

describe('offer-normalizer', () => {
  it('slugifies text consistently', () => {
    expect(slugify('  VISA Offers & More!  ')).toBe('visa-offers-and-more');
  });

  it('normalizes merchant suffix noise', () => {
    expect(normalizeMerchantName('Demo Restaurant Pvt Ltd PLC')).toBe('Demo');
    expect(normalizeMerchantName('Raja Jewellers')).toBe('Raja Jeweller');
  });

  it('prefers sourceId for stable offer ids', () => {
    expect(stableOfferId({ source: 'hnb', sourceId: '123' })).toBe('hnb_123');
  });

  it('uses stable URL hash without query strings', () => {
    const first = stableOfferId({ source: 'boc', sourceUrl: 'https://example.com/offers/demo-product?x=1' });
    const second = stableOfferId({ source: 'boc', sourceUrl: 'https://example.com/offers/demo-product?x=2' });
    expect(first).toBe(second);
    expect(first).toContain('demo-product');
  });

  it('dedupes offers by uniqueId preserving first occurrence', () => {
    const first = makeOffer('same');
    const second = makeOffer('same');
    const third = makeOffer('other');
    const result = dedupeOffers([first, second, third]);

    expect(result.offers).toEqual([first, third]);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.duplicateIds).toEqual(['same']);
  });
});

describe('computeOfferContentHash', () => {
  it('is stable for identical business content', () => {
    const a = makeOffer('x');
    const b = makeOffer('x');
    expect(computeOfferContentHash(a)).toBe(computeOfferContentHash(b));
  });

  it('ignores irrelevant HTML/whitespace formatting differences', () => {
    const a = makeOffer('x');
    const b = makeOffer('x');
    b.title = '  Demo   Offer  ';
    b.offer.description = 'Line one\n\n   Line   two  ';
    a.offer.description = 'Line one Line two';
    expect(computeOfferContentHash(a)).toBe(computeOfferContentHash(b));
  });

  it('ignores array ordering (card eligibility, addresses)', () => {
    const a = makeOffer('x');
    a.cardEligibility.includedCards = ['Visa', 'Mastercard'];
    a.merchant.addresses = ['123 Main St', '456 Side St'];
    const b = makeOffer('x');
    b.cardEligibility.includedCards = ['Mastercard', 'Visa'];
    b.merchant.addresses = ['456 Side St', '123 Main St'];
    expect(computeOfferContentHash(a)).toBe(computeOfferContentHash(b));
  });

  it('changes when the discount changes', () => {
    const a = makeOffer('x');
    a.offer.discountPercentage = 10;
    const b = makeOffer('x');
    b.offer.discountPercentage = 20;
    expect(computeOfferContentHash(a)).not.toBe(computeOfferContentHash(b));
  });

  it('changes when card eligibility changes', () => {
    const a = makeOffer('x');
    const b = makeOffer('x');
    b.cardEligibility.includedCards = ['Visa'];
    expect(computeOfferContentHash(a)).not.toBe(computeOfferContentHash(b));
  });

  it('changes when the validity window changes', () => {
    const a = makeOffer('x');
    const b = makeOffer('x');
    b.validityPeriods = [
      {
        validFrom: '2026-01-01',
        validTo: '2026-06-30',
        periodType: a.validityPeriods[0]?.periodType ?? ('offer' as never),
        recurrenceType: 'daily' as never,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: '',
      },
    ];
    expect(computeOfferContentHash(a)).not.toBe(computeOfferContentHash(b));
  });

  it('changes when transaction min/max changes', () => {
    const a = makeOffer('x');
    a.transactionRange = { min: 1000, max: null, currency: 'LKR' };
    const b = makeOffer('x');
    b.transactionRange = { min: 2000, max: null, currency: 'LKR' };
    expect(computeOfferContentHash(a)).not.toBe(computeOfferContentHash(b));
  });

  it('is unaffected by unique_id / identity fields', () => {
    const a = makeOffer('offer-1');
    const b = makeOffer('offer-2');
    expect(computeOfferContentHash(a)).toBe(computeOfferContentHash(b));
  });
});
