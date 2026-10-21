import { ValidationOrchestrator } from '@/geo/validation-orchestrator';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';
import { LocationScope } from '@/domain/location-scope';

function createMockOffer(overrides?: Partial<Offer>): Offer {
  return {
    uniqueId: 'mock-1',
    source: 'hnb',
    sourceId: 'src-1',
    sourceUrl: 'https://hnb.lk/promotions/test',
    title: 'Special promotion',
    category: 'dining',
    categoryId: 1,
    cardType: 'Credit',
    scrapedAt: new Date().toISOString(),
    contentHash: 'hash1',
    merchant: {
      name: 'Test Merchant',
      location: null,
      addresses: [],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: 'Test description',
      discountPercentage: 15,
      applicableCards: ['Visa Platinum'],
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
      cardTypes: ['Credit Card'],
      networks: ['Visa'],
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
        rawPeriodText: 'Valid until 31 Dec 2026',
      },
    ],
    ...overrides,
  };
}

describe('Intelligent Address Validation Orchestrator', () => {
  it('fast-paths high-confidence EXACT_ADDRESS offers without invoking LLM', async () => {
    const orchestrator = new ValidationOrchestrator({
      mode: 'hybrid-mocked',
      geocodingDryRun: true,
    });

    const offer = createMockOffer({
      merchant: {
        name: 'Galle Face Hotel',
        location: 'Colombo',
        addresses: ['No. 2, Galle Road, Colombo 03, Sri Lanka'],
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
    });

    const result = await orchestrator.processOffer(offer);

    expect(result.addressQuality).toBe('EXACT_ADDRESS');
    expect(result.confidence).toBe('HIGH');
    expect(result.usedLlm).toBe(false); // Fast path!
    expect(result.finalAddresses).toEqual(['No. 2, Galle Road, Colombo 03, Sri Lanka']);
    expect(result.diagnostics).toContain('Address normalized (Quality: EXACT_ADDRESS, Confidence: HIGH)');
  });

  it('triggers LLM agent on contaminated candidates and applies grounded correction', async () => {
    const orchestrator = new ValidationOrchestrator({
      mode: 'hybrid-mocked',
      geocodingDryRun: true,
    });

    const offer = createMockOffer({
      merchant: {
        name: 'The Ocean Seafood',
        location: 'Colombo',
        addresses: ['Both Debit and Credit Cards'], // Contaminated candidate!
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
      offer: {
        description: 'Enjoy 20% off at our restaurant. Address: No. 15, Marine Drive, Colombo 03',
        discountPercentage: 20,
        applicableCards: [],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
    });

    const result = await orchestrator.processOffer(offer);

    expect(result.usedLlm).toBe(true);
    expect(result.correctionPatch).not.toBeNull();
    expect(result.correctionPatch?.validatorOutcome).toBe('ACCEPTED');
    expect(result.finalAddresses[0]).toContain('Marine Drive, Colombo 03');
    expect(result.diagnostics).toContain('Correction accepted');
  });

  it('correctly tags unresolvable offers as needing human review', async () => {
    const orchestrator = new ValidationOrchestrator({
      mode: 'hybrid-mocked',
      geocodingDryRun: true,
    });

    const offer = createMockOffer({
      merchant: {
        name: 'Generic Store',
        location: null,
        addresses: ['Some Vague Fragment'],
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
      offer: {
        description: 'Vague promo without location or address information',
        discountPercentage: 10,
        applicableCards: [],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
    });

    const result = await orchestrator.processOffer(offer);

    expect(result.needsHumanReview).toBe(true);
    expect(result.diagnostics).toContain('Needs manual review');
  });
});
