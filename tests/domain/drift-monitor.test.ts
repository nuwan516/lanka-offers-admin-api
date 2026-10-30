import { evaluateDataQualityDrift } from '../../src/domain/drift-monitor';
import { Offer, PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';

describe('Data Quality Drift Monitor', () => {
  function makeMockOffer(overrides: Partial<Offer> = {}): Offer {
    const base: Offer = {
      uniqueId: `test-drift-${Math.random().toString(36).slice(2, 6)}`,
      source: 'hnb',
      sourceId: '101',
      sourceUrl: 'https://bank.lk/promo',
      title: 'Valid Promo 20% off',
      category: 'Dining',
      categoryId: 1,
      cardType: 'Credit',
      scrapedAt: new Date().toISOString(),
      merchant: {
        name: 'Test Restaurant',
        location: 'Colombo',
        addresses: ['123 Main St, Colombo 03'],
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
      offer: {
        description: '20% off dining',
        discountPercentage: 20,
        applicableCards: ['Visa'],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
      installmentPlans: [],
      transactionRange: { min: null, max: null, currency: 'LKR' },
      cardEligibility: {
        cardTypes: ['Credit'],
        networks: ['Visa'],
        includedCards: [],
        excludedCards: [],
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
          rawPeriodText: 'Valid all year',
        },
      ],
      contentHash: '',
    };
    const merged = { ...base, ...overrides };
    merged.contentHash = computeOfferContentHash(merged);
    return merged;
  }

  it('detects healthy state when all offers meet quality standards and match baseline', () => {
    const offers = [makeMockOffer(), makeMockOffer()];
    const report = evaluateDataQualityDrift({
      bank: 'hnb',
      offers,
      baseline: { bank: 'hnb', previousOfferCount: 2 },
    });

    expect(report.status).toBe('HEALTHY');
    expect(report.diagnostics).toHaveLength(0);
  });

  it('detects ZERO_OFFER_SCRAPE when scraper yields zero offers', () => {
    const report = evaluateDataQualityDrift({
      bank: 'sampath',
      offers: [],
      baseline: { bank: 'sampath', previousOfferCount: 45 },
    });

    expect(report.status).toBe('DRIFT_DETECTED');
    expect(report.diagnostics.some((d) => d.code === 'ZERO_OFFER_SCRAPE')).toBe(true);
    expect(report.diagnostics[0].severity).toBe('CRITICAL');
  });

  it('detects LARGE_OFFER_COUNT_DROP when offers collapse vs baseline', () => {
    const offers = [makeMockOffer(), makeMockOffer(), makeMockOffer()];
    const report = evaluateDataQualityDrift({
      bank: 'boc',
      offers,
      baseline: { bank: 'boc', previousOfferCount: 30 },
    });

    expect(report.status).toBe('DEGRADED');
    const diag = report.diagnostics.find((d) => d.code === 'LARGE_OFFER_COUNT_DROP');
    expect(diag).toBeDefined();
    expect(diag?.currentValue).toBe('-90%');
  });

  it('detects INVERTED_VALIDITY_DATES when validFrom is after validTo', () => {
    const badOffer = makeMockOffer({
      validityPeriods: [
        {
          validFrom: '2026-12-31',
          validTo: '2026-01-01', // Inverted
          periodType: PeriodType.OFFER,
          recurrenceType: RecurrenceType.DAILY,
          recurrenceDays: null,
          timeWindow: null,
          exclusionDays: null,
          blackoutPeriods: null,
          exclusionNotes: null,
          rawPeriodText: 'Inverted',
        },
      ],
    });

    const report = evaluateDataQualityDrift({
      bank: 'hnb',
      offers: [badOffer],
    });

    expect(report.status).toBe('DRIFT_DETECTED');
    expect(report.diagnostics.some((d) => d.code === 'INVERTED_VALIDITY_DATES')).toBe(true);
  });

  it('detects ADDRESS_CONTAMINATION when addresses contain emails or phones', () => {
    const contaminatedOffer = makeMockOffer({
      merchant: {
        name: 'Centauria Wild',
        location: 'Udawalawa',
        addresses: ['wild@centauriaho, Sri Lanka'], // Email fragment in address
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
    });

    const report = evaluateDataQualityDrift({
      bank: 'hnb',
      offers: [contaminatedOffer],
    });

    expect(report.diagnostics.some((d) => d.code === 'ADDRESS_CONTAMINATION')).toBe(true);
  });

  it('detects HIGH_LLM_CORRECTION_REJECTION_RATE when model proposals fail evidence grounding', () => {
    const offers = Array.from({ length: 10 }, () => makeMockOffer());
    const mockReports: any[] = [
      {
        qualityGate: { status: 'VALIDATED' },
        acceptedCorrections: [{ field: 'merchant.name' }],
        rejectedCorrections: [{ proposal: {} }, { proposal: {} }, { proposal: {} }, { proposal: {} }],
      },
    ];

    const report = evaluateDataQualityDrift({
      bank: 'ndb',
      offers,
      validationReports: mockReports,
    });

    expect(report.diagnostics.some((d) => d.code === 'HIGH_LLM_CORRECTION_REJECTION_RATE')).toBe(true);
  });
});
