import { OfferValidator } from '@/parsing/validators/offer-validator';
import { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeValidOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: 'https://venus.hnb.lk/offer/1',
    title: '20% off at The Wallawwa',
    category: 'Hotels',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: new Date().toISOString(),
    merchant: {
      name: 'The Wallawwa',
      location: 'Colombo',
      addresses: ['296 Negombo Road, Ja-Ela, Sri Lanka'],
      phone: ['0112234567'],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: 'Enjoy 20% off on dining.',
      discountPercentage: 20,
      applicableCards: ['Credit Card'],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: 5000, max: 50000, currency: 'LKR' },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: ['Credit Card'],
      networks: ['Visa', 'Mastercard'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Valid from 1 January 2026 to 31 December 2026',
      },
    ],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OfferValidator', () => {
  const validator = new OfferValidator();

  it('returns valid=true for a correct offer', () => {
    const result = validator.validate(makeValidOffer());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // Required fields
  it('errors when uniqueId is missing', () => {
    const result = validator.validate(makeValidOffer({ uniqueId: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'uniqueId')).toBe(true);
  });

  it('errors when source is missing', () => {
    const result = validator.validate(makeValidOffer({ source: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'source')).toBe(true);
  });

  it('errors when title is empty', () => {
    const result = validator.validate(makeValidOffer({ title: '   ' }));
    expect(result.valid).toBe(false);
  });

  // Date validation
  it('errors on invalid validFrom date format', () => {
    const offer = makeValidOffer();
    offer.validityPeriods[0].validFrom = '01-01-2026'; // wrong format
    const result = validator.validate(offer);
    expect(result.errors.some((e) => e.field.includes('validFrom'))).toBe(true);
  });

  it('errors when validFrom > validTo', () => {
    const offer = makeValidOffer();
    offer.validityPeriods[0].validFrom = '2026-12-31';
    offer.validityPeriods[0].validTo = '2026-01-01';
    const result = validator.validate(offer);
    expect(result.errors.some((e) => e.field.includes('validityPeriods'))).toBe(true);
  });

  it('errors when every dated period is already expired (quarantine)', () => {
    const offer = makeValidOffer();
    offer.validityPeriods[0].validFrom = '2025-01-01';
    offer.validityPeriods[0].validTo = '2025-06-30';
    const result = validator.validate(offer);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('expired'))).toBe(true);
  });

  it('does not flag expired when at least one period is still active', () => {
    const offer = makeValidOffer();
    offer.validityPeriods.push({
      ...offer.validityPeriods[0],
      validFrom: '2025-01-01',
      validTo: '2025-06-30',
    });
    const result = validator.validate(offer);
    expect(result.errors.some((e) => e.message.includes('expired'))).toBe(false);
  });

  // Discount
  it('warns when discountPercentage > 100', () => {
    const offer = makeValidOffer();
    offer.offer.discountPercentage = 150;
    const result = validator.validate(offer);
    expect(result.warnings.some((w) => w.field === 'offer.discountPercentage')).toBe(true);
  });

  it('does not warn when discountPercentage is null', () => {
    const offer = makeValidOffer();
    offer.offer.discountPercentage = null;
    const result = validator.validate(offer);
    expect(result.warnings.some((w) => w.field === 'offer.discountPercentage')).toBe(false);
  });

  // Merchant location
  it('warns when no merchant address or location', () => {
    const offer = makeValidOffer();
    offer.merchant.addresses = [];
    offer.merchant.location = null;
    const result = validator.validate(offer);
    expect(result.warnings.some((w) => w.field === 'merchant')).toBe(true);
  });

  // Transaction range
  it('errors when transactionRange.min is negative', () => {
    const offer = makeValidOffer();
    offer.transactionRange.min = -100;
    const result = validator.validate(offer);
    expect(result.errors.some((e) => e.field === 'transactionRange.min')).toBe(true);
  });

  // Content hash
  it('warns on malformed contentHash', () => {
    const offer = makeValidOffer({ contentHash: 'not-a-hash' });
    const result = validator.validate(offer);
    expect(result.warnings.some((w) => w.field === 'contentHash')).toBe(true);
  });

  // Batch
  it('validateBatch returns only offers with issues', () => {
    const valid = makeValidOffer();
    const invalid = makeValidOffer({ uniqueId: '' });
    const results = validator.validateBatch([valid, invalid]);
    expect(results).toHaveLength(1);
    expect(results[0].offer.uniqueId).toBe('');
  });
});
