import { UnifiedOfferOrchestrator } from '@/parsing/validators/unified-offer-orchestrator';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';

describe('Unified Offer Validation Orchestrator', () => {
  const cleanOffer: Offer = {
    uniqueId: 'hnb_2451',
    source: 'hnb',
    sourceId: '2451',
    sourceUrl: 'https://venus.hnb.lk/api/get_web_card_promo?id=2451',
    title: '20% off at Lotus Estate Colombo',
    category: 'Hotel',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: '2026-10-03T15:03:31.434Z',
    merchant: {
      name: 'Lotus Estate Colombo',
      location: 'Colombo',
      addresses: ['Colombo, Sri Lanka'],
      phone: ['0112581132'],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: '20% off on Bed & Breakfast, Half Board basis',
      discountPercentage: 20,
      applicableCards: ['Credit Card'],
      bookingRequired: true,
      restrictions: ['Subject to availability'],
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
        validFrom: '2026-10-03',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Till 31st December 2026',
      },
    ],
    contentHash: 'c6f140e79756dcbf0ccaf380687325c4d8fe53418ba2d4650306c1d5698113e2',
  };

  it('runs Fast-Path for clean, grounded offers without calling LLM', async () => {
    let llmCalled = false;
    const orchestrator = new UnifiedOfferOrchestrator({
      llmRunner: async () => {
        llmCalled = true;
        return null;
      },
    });

    const report = await orchestrator.validateOffer(cleanOffer);

    expect(report.fastPathSkippedLlm).toBe(true);
    expect(llmCalled).toBe(false);
    expect(report.attemptsUsed).toBe(0);
    expect(report.qualityGate.status).toBe('VALIDATED');
    expect(report.qualityGate.overallScore).toBeGreaterThanOrEqual(90);
  });

  it('invokes LLM with tools when forceLlm is enabled or offer has warnings', async () => {
    let llmCalled = false;
    const orchestrator = new UnifiedOfferOrchestrator({
      forceLlm: true,
      llmRunner: async (attempt, offer, evidence, executor) => {
        llmCalled = true;
        await executor.executeTool('get_raw_offer', { offerId: offer.uniqueId });
        return {
          offerId: offer.uniqueId,
          bankCode: offer.source,
          isGenuinePromo: true,
          merchantIdentity: {
            canonicalName: 'Lotus Estate Colombo',
            parentBrand: null,
            isMultiMerchant: false,
            evidenceIds: ['ev-title'],
          },
          financialTerms: {
            offerType: 'PERCENTAGE_DISCOUNT',
            discountPercentage: 20,
            isUpTo: false,
            currency: 'LKR',
            evidenceIds: ['ev-desc'],
          },
          cardEligibility: {
            cardTypes: ['Credit Card'],
            networks: ['Visa'],
            evidenceIds: ['ev-title'],
          },
          validityDates: {
            validFrom: '2026-10-03',
            validTo: '2026-12-31',
            evidenceIds: ['ev-validity-1'],
          },
          locationScope: 'EXPLICIT_BRANCH',
          corrections: [],
          qualityGate: {
            status: 'VALIDATED',
            overallScore: 95,
            criticalFieldsSupported: true,
            hasUnsupportedClaims: false,
            reasons: ['Fully supported by evidence'],
          },
          summaryReasoning: 'Validated genuine offer with 20% discount',
        };
      },
    });

    const report = await orchestrator.validateOffer(cleanOffer);

    expect(report.fastPathSkippedLlm).toBe(false);
    expect(llmCalled).toBe(true);
    expect(report.attemptsUsed).toBe(1);
    expect(report.totalToolCalls).toBe(1);
    expect(report.qualityGate.status).toBe('VALIDATED');
  });

  it('enforces maximum 3 attempts and marks REVIEW_REQUIRED when proposals fail', async () => {
    let attemptCount = 0;
    const orchestrator = new UnifiedOfferOrchestrator({
      forceLlm: true,
      llmRunner: async () => {
        attemptCount++;
        // Return null to simulate failure
        return null;
      },
    });

    const report = await orchestrator.validateOffer(cleanOffer);

    expect(attemptCount).toBe(3); // Strict 3 attempts maximum!
    expect(report.attemptsUsed).toBe(3);
    expect(report.qualityGate.status).toBe('REVIEW_REQUIRED');
    expect(report.qualityGate.reasons.some((r) => r.includes('Exhausted') && r.includes('3-attempt'))).toBe(true);
  });

  it('flags duplicate candidates into REVIEW_REQUIRED', async () => {
    const existingOffer: Offer = {
      ...cleanOffer,
      uniqueId: 'hnb_9999',
    };

    const orchestrator = new UnifiedOfferOrchestrator();
    const report = await orchestrator.validateOffer(cleanOffer, [existingOffer]);

    expect(report.duplicateAnalysis?.isDuplicate).toBe(true);
    expect(report.qualityGate.status).toBe('REVIEW_REQUIRED');
    expect(report.qualityGate.reasons.some((r) => r.includes('Duplicate candidate'))).toBe(true);
  });

  it('applies accepted field corrections to effective offer while preserving manual overrides', async () => {
    const orchestrator = new UnifiedOfferOrchestrator({
      forceLlm: true,
      llmRunner: async (attempt, offer) => {
        return {
          offerId: offer.uniqueId,
          bankCode: offer.source,
          isGenuinePromo: true,
          merchantIdentity: {
            canonicalName: 'Lotus Estate Colombo',
            parentBrand: null,
            isMultiMerchant: false,
            evidenceIds: ['ev-title'],
          },
          financialTerms: {
            offerType: 'PERCENTAGE_DISCOUNT',
            discountPercentage: 20,
            isUpTo: false,
            currency: 'LKR',
            evidenceIds: ['ev-desc'],
          },
          cardEligibility: {
            cardTypes: ['Credit Card'],
            networks: ['Visa'],
            evidenceIds: ['ev-title'],
          },
          validityDates: {
            validFrom: '2026-10-03',
            validTo: '2026-12-31',
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
            reasons: ['Validated'],
          },
          summaryReasoning: 'Applied merchant name patch',
        };
      },
    });

    const report = await orchestrator.validateOffer(cleanOffer);

    expect(report.acceptedCorrections.length).toBe(1);
    expect(report.effectiveOffer.merchant.name).toBe('Lotus Estate Colombo');
  });
});
