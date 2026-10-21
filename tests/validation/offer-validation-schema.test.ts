import {
  FullOfferValidationProposalSchema,
  FieldCorrectionProposalSchema,
  EvidenceSnippetSchema,
  FinancialTermsProposalSchema,
  ValidityDatesProposalSchema,
} from '@/llm/schemas/offer-validation.schema';

describe('Offer Validation Schema (Zod)', () => {
  it('validates a complete, genuine offer proposal', () => {
    const validProposal = {
      offerId: 'hnb_2451',
      bankCode: 'hnb',
      isGenuinePromo: true,
      merchantIdentity: {
        canonicalName: 'Lotus Estate Colombo',
        parentBrand: null,
        isMultiMerchant: false,
        evidenceIds: ['ev-title', 'ev-desc'],
      },
      financialTerms: {
        offerType: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 20,
        isUpTo: false,
        flatDiscountAmount: null,
        cashbackAmount: null,
        minimumSpend: null,
        maximumDiscountCap: null,
        currency: 'LKR',
        evidenceIds: ['ev-desc'],
      },
      cardEligibility: {
        cardTypes: ['Credit Card', 'Debit Card'],
        networks: ['Visa', 'Mastercard'],
        tiers: ['Classic', 'Gold', 'Platinum'],
        evidenceIds: ['ev-terms-1'],
      },
      validityDates: {
        validFrom: '2026-10-03',
        validTo: '2026-12-31',
        isWeekendOnly: false,
        evidenceIds: ['ev-validity-1'],
      },
      locationScope: 'EXPLICIT_BRANCH',
      corrections: [
        {
          fieldPath: 'merchant.name',
          originalValue: 'Lotus Estate',
          proposedValue: 'Lotus Estate Colombo',
          evidenceIds: ['ev-title'],
          reason: 'Full venue branding from title',
          confidence: 'HIGH',
        },
      ],
      qualityGate: {
        status: 'VALIDATED',
        overallScore: 95,
        criticalFieldsSupported: true,
        hasUnsupportedClaims: false,
        reasons: ['All fields grounded in raw text evidence'],
      },
      summaryReasoning: 'Promotion is fully supported by bank source text with 20% discount on rooms.',
    };

    const parsed = FullOfferValidationProposalSchema.safeParse(validProposal);
    expect(parsed.success).toBe(true);
  });

  it('rejects field correction on immutable, non-editable field paths', () => {
    const disallowedPatch = {
      fieldPath: 'rawHtml', // Not in EDITABLE_FIELD_PATHS!
      originalValue: '<p>Old</p>',
      proposedValue: '<p>New injected</p>',
      evidenceIds: ['ev-1'],
      reason: 'Attempting to overwrite raw evidence',
      confidence: 'HIGH',
    };

    const result = FieldCorrectionProposalSchema.safeParse(disallowedPatch);
    expect(result.success).toBe(false);
  });

  it('rejects corrections without evidence citations', () => {
    const noEvidencePatch = {
      fieldPath: 'offer.discountPercentage',
      originalValue: 15,
      proposedValue: 30,
      evidenceIds: [], // Empty!
      reason: 'Invented discount without citation',
      confidence: 'HIGH',
    };

    const result = FieldCorrectionProposalSchema.safeParse(noEvidencePatch);
    expect(result.success).toBe(false);
  });

  it('enforces discount percentage bounds (0-100)', () => {
    const invalidFinancial = {
      offerType: 'PERCENTAGE_DISCOUNT',
      discountPercentage: 150, // Invalid!
      isUpTo: false,
      currency: 'LKR',
      evidenceIds: ['ev-desc'],
    };

    const result = FinancialTermsProposalSchema.safeParse(invalidFinancial);
    expect(result.success).toBe(false);
  });

  it('enforces ISO YYYY-MM-DD date formats', () => {
    const invalidDates = {
      validFrom: '10/03/2026', // Invalid format!
      validTo: '2026-12-31',
      evidenceIds: ['ev-dates'],
    };

    const result = ValidityDatesProposalSchema.safeParse(invalidDates);
    expect(result.success).toBe(false);
  });
});
