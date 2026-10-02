import { ValidationPipeline } from '@/parsing/validators/validation-pipeline';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';
import { LlmValidator } from '@/parsing/validators/llm-validator';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: 'https://venus.hnb.lk/api/get_web_card_promo?id=001',
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
      description: 'Enjoy 20% off on food and beverage.',
      discountPercentage: 20,
      applicableCards: ['Credit Card'],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Credit Card'], networks: [], restrictions: [] },
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
    rawHtml: '<p>20% off at The Wallawwa</p>',
    ...overrides,
  };
}

describe('ValidationPipeline', () => {
  it('passes a clean rule-valid offer without LLM', async () => {
    const pipeline = new ValidationPipeline({ sampleRate: 0 });
    const report = await pipeline.validateOffer(makeOffer());

    expect(report.passed).toBe(true);
    expect(report.shouldUseLlm).toBe(false);
    expect(report.llmValidation).toBeNull();
  });

  it('runs LLM when forced and includes the LLM result in pass/fail', async () => {
    const llmValidator = {
      isAvailable: true,
      validate: jest.fn().mockResolvedValue({
        isValidOffer: true,
        inferredCategory: 'Hotels',
        extractionScore: 82,
        confidence: 0.9,
        suggestedTitle: null,
        scoreBreakdown: {
          identity: 90,
          merchant: 90,
          offerDetails: 80,
          validity: 80,
          cardEligibility: 80,
          locationAndContact: 80,
          mediaAndSource: 80,
          noHallucination: 80,
        },
        fieldVerdicts: {},
        issues: [],
        rawCompared: true,
        promptVersion: 'offer-full-v1',
        reasoning: 'ok',
        provider: 'openai',
        model: 'test',
      }),
    } as unknown as LlmValidator;

    const pipeline = new ValidationPipeline({ llmValidator, forceLlm: true, sampleRate: 0 });
    const report = await pipeline.validateOffer(makeOffer(), { rawText: '20% off at The Wallawwa' });

    expect(report.passed).toBe(true);
    expect(report.shouldUseLlm).toBe(true);
    expect(report.llmReason).toBe('forced');
    expect(report.llmValidation?.extractionScore).toBe(82);
    expect((llmValidator.validate as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('fails when rule validation has errors', async () => {
    const pipeline = new ValidationPipeline({ sampleRate: 0 });
    const report = await pipeline.validateOffer(makeOffer({ uniqueId: '' }));

    expect(report.passed).toBe(false);
    expect(report.ruleValidation.errors.some((e) => e.field === 'uniqueId')).toBe(true);
  });
});
