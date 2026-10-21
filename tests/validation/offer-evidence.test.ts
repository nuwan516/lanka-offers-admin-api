import {
  buildOfferEvidenceSnippets,
  verifyEvidenceTokens,
  verifyNumericEvidence,
  detectUpToSemantics,
} from '@/parsing/validators/offer-evidence';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';

describe('Offer Evidence Architecture & Grounding', () => {
  const sampleOffer: Offer = {
    uniqueId: 'sampath_101',
    source: 'sampath',
    sourceId: '101',
    sourceUrl: 'https://sampath.lk/promo/101',
    title: 'Up to 30% off at Odel with Sampath Cards',
    category: 'Shopping',
    categoryId: 2,
    cardType: 'Credit Card',
    scrapedAt: '2026-10-01T00:00:00Z',
    merchant: {
      name: 'Odel',
      location: 'Colombo, Kandy, Galle',
      addresses: ['Alexandra Place, Colombo 07'],
      phone: ['0112345678'],
      email: [],
      website: 'www.odel.lk',
      logo: null,
    },
    offer: {
      description: 'Enjoy 30% off on apparel for Sampath Visa Infinite and 20% off for Platinum cards.',
      discountPercentage: 30,
      applicableCards: ['Visa Infinite', 'Platinum'],
      bookingRequired: false,
      restrictions: ['Minimum bill value LKR 5,000 required', 'Maximum discount LKR 10,000 per transaction'],
      specialConditions: ['Valid only on Saturdays and Sundays'],
      generalTerms: ['Standard terms and conditions apply'],
    },
    installmentPlans: [],
    transactionRange: {
      min: 5000,
      max: null,
      currency: 'LKR',
    },
    cardEligibility: {
      includedCards: ['Visa Infinite', 'Platinum'],
      excludedCards: [],
      cardTypes: ['Credit Card'],
      networks: ['Visa'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.SPECIFIC_WEEKDAYS,
        recurrenceDays: ['Saturday', 'Sunday'],
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Valid till 31st October 2026 on weekends only.',
      },
    ],
    contentHash: 'a'.repeat(64),
    rawHtml: '<div>Sample raw HTML</div>',
  };

  it('builds indexed evidence snippets with unique IDs', () => {
    const snippets = buildOfferEvidenceSnippets(sampleOffer);
    expect(snippets.length).toBeGreaterThan(5);

    const ids = snippets.map((s) => s.id);
    expect(ids).toContain('ev-title');
    expect(ids).toContain('ev-desc');
    expect(ids).toContain('ev-rest-1');
    expect(ids).toContain('ev-validity-1');
    expect(ids).toContain('ev-merchant-loc');
  });

  it('verifies grounded tokens from evidence', () => {
    const snippets = buildOfferEvidenceSnippets(sampleOffer);
    const result = verifyEvidenceTokens('apparel for Sampath Visa Infinite cardholders', snippets);
    expect(result.grounded).toBe(true);
    expect(result.tokenOverlapRatio).toBeGreaterThanOrEqual(0.6);
  });

  it('detects ungrounded / hallucinated claims', () => {
    const snippets = buildOfferEvidenceSnippets(sampleOffer);
    const result = verifyEvidenceTokens('Free pizza with Heineken beer buffet dining', snippets);
    expect(result.grounded).toBe(false);
    expect(result.tokenOverlapRatio).toBeLessThan(0.2);
  });

  it('verifies exact numeric presence (discount, min spend, caps)', () => {
    const snippets = buildOfferEvidenceSnippets(sampleOffer);

    // 30% discount exists
    const check30 = verifyNumericEvidence(30, snippets);
    expect(check30.found).toBe(true);

    // 5000 min spend exists
    const check5000 = verifyNumericEvidence(5000, snippets);
    expect(check5000.found).toBe(true);

    // 75% hallucinated discount does NOT exist
    const check75 = verifyNumericEvidence(75, snippets);
    expect(check75.found).toBe(false);
  });

  it('detects "up to" semantics correctly per Invariant #8', () => {
    const titleCheck = detectUpToSemantics(sampleOffer.title, 30);
    expect(titleCheck.isUpTo).toBe(true);

    const flatCheck = detectUpToSemantics('25% off on all items at Keells', 25);
    expect(flatCheck.isUpTo).toBe(false);
  });
});
