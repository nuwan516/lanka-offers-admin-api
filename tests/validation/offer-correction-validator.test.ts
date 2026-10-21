import { OfferCorrectionValidator } from '@/parsing/validators/offer-correction-validator';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';
import { FieldCorrectionProposal } from '@/llm/schemas/offer-validation.schema';
import { buildOfferEvidenceSnippets } from '@/parsing/validators/offer-evidence';

describe('Offer Correction Validator (Deterministic Guards)', () => {
  const sampleOffer: Offer = {
    uniqueId: 'sampath_101',
    source: 'sampath',
    sourceId: '101',
    sourceUrl: 'https://sampath.lk/promo/101',
    title: '20% off at Odel with Sampath Cards',
    category: 'Shopping',
    categoryId: 2,
    cardType: 'Credit Card',
    scrapedAt: '2026-10-01T00:00:00Z',
    merchant: {
      name: 'Odel',
      location: 'Colombo',
      addresses: ['Alexandra Place, Colombo 07'],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: 'Get 20% discount on clothing with Sampath Mastercard.',
      discountPercentage: 20,
      applicableCards: ['Mastercard'],
      bookingRequired: false,
      restrictions: ['Minimum spend LKR 3,000'],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: 3000, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: ['Credit Card'],
      networks: ['Mastercard'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Till 31st October 2026',
      },
    ],
    contentHash: 'a'.repeat(64),
  };

  const snippets = buildOfferEvidenceSnippets(sampleOffer);
  const validator = new OfferCorrectionValidator();

  it('accepts evidence-grounded discount correction', () => {
    const validProposal: FieldCorrectionProposal = {
      fieldPath: 'offer.discountPercentage',
      originalValue: 15,
      proposedValue: 20,
      evidenceIds: ['ev-title', 'ev-desc'],
      reason: 'Extracted 20% from title and description',
      confidence: 'HIGH',
    };

    const result = validator.validateProposal(validProposal, sampleOffer, snippets);
    expect(result.valid).toBe(true);
    expect(result.rejectionReason).toBeNull();
  });

  it('rejects hallucinated discount value not in evidence', () => {
    const hallucinatedProposal: FieldCorrectionProposal = {
      fieldPath: 'offer.discountPercentage',
      originalValue: 20,
      proposedValue: 50, // 50% does not exist in evidence!
      evidenceIds: ['ev-title', 'ev-desc'],
      reason: 'Model guessed 50%',
      confidence: 'HIGH',
    };

    const result = validator.validateProposal(hallucinatedProposal, sampleOffer, snippets);
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toMatch(/does not (?:physically|semantically) exist/);
  });

  it('rejects inverted dates in validity period', () => {
    const invertedDatesProposal: FieldCorrectionProposal = {
      fieldPath: 'validityPeriods',
      originalValue: sampleOffer.validityPeriods,
      proposedValue: [
        {
          validFrom: '2026-11-01',
          validTo: '2026-10-01', // End before start!
          periodType: 'offer',
          recurrenceType: 'daily',
          rawPeriodText: 'Invalid inverted range',
        },
      ],
      evidenceIds: ['ev-validity-1'],
      reason: 'Typo in dates',
      confidence: 'HIGH',
    };

    const result = validator.validateProposal(invertedDatesProposal, sampleOffer, snippets);
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain('chronologically after validTo');
  });

  it('rejects coordinate injection into addresses (no false location precision)', () => {
    const coordInjection: FieldCorrectionProposal = {
      fieldPath: 'merchant.addresses',
      originalValue: sampleOffer.merchant.addresses,
      proposedValue: ['6.9271, 79.8612'], // Coordinates!
      evidenceIds: ['ev-merchant-loc'],
      reason: 'Injected lat/lng as street address',
      confidence: 'HIGH',
    };

    const result = validator.validateProposal(coordInjection, sampleOffer, snippets);
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain('False location precision');
  });

  it('protects existing sacred manual overrides from automated clobbering', () => {
    const proposal: FieldCorrectionProposal = {
      fieldPath: 'merchant.name',
      originalValue: 'Odel',
      proposedValue: 'Odel Department Store',
      evidenceIds: ['ev-title'],
      reason: 'Auto normalize',
      confidence: 'HIGH',
    };

    const existingManualOverride = {
      'merchant.name': 'ODEL Sri Lanka Flagship',
    };

    const result = validator.validateProposal(proposal, sampleOffer, snippets, existingManualOverride);
    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain('sacred manual override');
  });
});
