import { LlmValidator } from '@/parsing/validators/llm-validator';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// CostGuard reads/writes usage via the DB repository — keep these unit tests
// network-free and deterministic by mocking that boundary directly.
jest.mock('@/infrastructure/db/offer-repository', () => ({
  getServiceUsage: jest.fn().mockResolvedValue(0),
  recordApiUsage: jest.fn().mockResolvedValue(1),
}));


// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: null,
    title: '20% off at The Wallawwa',
    category: 'Hotels',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: new Date().toISOString(),
    merchant: {
      name: 'The Wallawwa',
      location: 'Colombo',
      addresses: [],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: 'Enjoy 20% off on food and beverage.',
      discountPercentage: 20,
      applicableCards: [],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
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
        rawPeriodText: '',
      },
    ],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LlmValidator', () => {
  it('isAvailable is false when no API key is configured', () => {
    const original = process.env.OPENAI_API_KEY;
    const original2 = process.env.GEMINI_API_KEY;
    const original3 = process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    const validator = new LlmValidator({ apiKey: undefined });
    expect(validator.isAvailable).toBe(false);

    if (original) process.env.OPENAI_API_KEY = original;
    if (original2) process.env.GEMINI_API_KEY = original2;
    if (original3) process.env.DEEPSEEK_API_KEY = original3;
  });

  it('returns null when no API key (graceful no-op)', async () => {
    const validator = new LlmValidator({ apiKey: undefined });
    const result = await validator.validate(makeOffer());
    expect(result).toBeNull();
  });

  it('returns a LlmValidationResult with provider info when API call succeeds', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                isValidOffer: true,
                inferredCategory: 'Hotels',
                extractionScore: 92,
                confidence: 0.95,
                suggestedTitle: null,
                scoreBreakdown: {
                  identity: 100,
                  merchant: 90,
                  offerDetails: 95,
                  validity: 90,
                  cardEligibility: 85,
                  locationAndContact: 80,
                  mediaAndSource: 100,
                  noHallucination: 95,
                },
                fieldVerdicts: {
                  title: { verdict: 'supported', citation: '20% off', note: null },
                  'merchant.name': { verdict: 'supported', citation: 'The Wallawwa', note: null },
                },
                issues: [],
                reasoning: 'The offer is clear and valid.',
              }),
            },
          },
        ],
      },
    });

    const validator = new LlmValidator({ apiKey: 'test-key', provider: 'openai' });
    const result = await validator.validate(makeOffer());

    expect(result).not.toBeNull();
    expect(result?.isValidOffer).toBe(true);
    expect(result?.inferredCategory).toBe('Hotels');
    expect(result?.extractionScore).toBe(92);
    expect(result?.confidence).toBe(0.95);
    expect(result?.scoreBreakdown.offerDetails).toBe(95);
    expect(result?.fieldVerdicts.title.verdict).toBe('supported');
    expect(result?.rawCompared).toBe(false);
    expect(result?.promptVersion).toBe('offer-full-v1');
    expect(result?.provider).toBe('openai');
  });

  it('clips confidence to [0, 1] for out-of-range values', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                isValidOffer: true,
                inferredCategory: null,
                extractionScore: 130,
                confidence: 1.5, // out of range
                suggestedTitle: null,
                scoreBreakdown: {
                  identity: 150,
                  merchant: -1,
                },
                fieldVerdicts: {},
                issues: ['low score'],
                reasoning: 'test',
              }),
            },
          },
        ],
      },
    });

    const validator = new LlmValidator({ apiKey: 'test-key', provider: 'openai' });
    const result = await validator.validate(makeOffer());
    expect(result?.confidence).toBe(1); // clamped
    expect(result?.extractionScore).toBe(100);
    expect(result?.scoreBreakdown.identity).toBe(100);
    expect(result?.scoreBreakdown.merchant).toBe(0);
    expect(result?.issues).toEqual(['LOW_SCORE']);
  });

  it('fails open on API error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

    const validator = new LlmValidator({ apiKey: 'test-key', provider: 'openai' });
    const result = await validator.validate(makeOffer());

    // Should return a result with isValidOffer=true (fail open)
    expect(result).not.toBeNull();
    expect(result?.isValidOffer).toBe(true);
    expect(result?.issues).toContain('LLM_VALIDATION_FAILED');
    expect(result?.reasoning).toContain('LLM validation failed');
  });

  it('passes full offer and raw evidence into the provider prompt', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                isValidOffer: true,
                inferredCategory: 'Hotels',
                extractionScore: 88,
                confidence: 0.8,
                suggestedTitle: null,
                scoreBreakdown: {},
                fieldVerdicts: {},
                issues: [],
                reasoning: 'ok',
              }),
            },
          },
        ],
      },
    });

    const offer = makeOffer({ rawHtml: '<p>20% off at The Wallawwa</p>' });
    const validator = new LlmValidator({ apiKey: 'test-key', provider: 'openai' });
    const result = await validator.validate(offer, { rawText: '20% off at The Wallawwa' });

    const body = mockedAxios.post.mock.calls[0][1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages[1].content;

    expect(prompt).toContain('FULL_EXTRACTED_OFFER_JSON');
    expect(prompt).toContain('"merchant"');
    expect(prompt).toContain('RAW_SOURCE_EVIDENCE_JSON');
    expect(prompt).toContain('20% off at The Wallawwa');
    expect(result?.rawCompared).toBe(true);
  });
});
