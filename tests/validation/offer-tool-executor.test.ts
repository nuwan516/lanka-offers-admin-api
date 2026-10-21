import { OfferToolExecutor } from '@/llm/tools/offer-tool-executor';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';

describe('Offer Tool Executor (Sandbox & Budget Guard)', () => {
  const sampleOffer: Offer = {
    uniqueId: 'hnb_2451',
    source: 'hnb',
    sourceId: '2451',
    sourceUrl: 'https://venus.hnb.lk/api/get_web_card_promo?id=2451',
    title: '20% off on BB, HB and FB basis at Lotus Estate Colombo',
    category: 'Hotel',
    categoryId: 1,
    cardType: 'Credit Card, Debit Card',
    scrapedAt: '2026-10-03T15:03:31.434Z',
    merchant: {
      name: 'Lotus Estate Colombo',
      location: 'Colombo',
      addresses: ['Colombo, Sri Lanka'],
      phone: ['0112581132'],
      email: [],
      website: 'www.joesresorts.com',
      logo: null,
    },
    offer: {
      description: '20% off (from rack rates) on Bed & Breakfast, Half Board, Full Board basis',
      discountPercentage: 20,
      applicableCards: ['Debit Card'],
      bookingRequired: true,
      restrictions: ['Cannot be combined with other offers'],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: {
      min: null,
      max: null,
      currency: 'LKR',
    },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: ['Credit Card', 'Debit Card'],
      networks: ['Visa', 'Mastercard'],
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

  it('retrieves raw offer and evidence snippets safely', async () => {
    const executor = new OfferToolExecutor(sampleOffer);
    const result = await executor.executeTool('get_raw_offer', { offerId: 'hnb_2451' });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.uniqueId).toBe('hnb_2451');
    expect(data.snippets.length).toBeGreaterThan(0);
  });

  it('searches source evidence and returns exact matching passages', async () => {
    const executor = new OfferToolExecutor(sampleOffer);
    const result = await executor.executeTool('search_source_evidence', {
      offerId: 'hnb_2451',
      query: 'lotus estate',
    });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.matchCount).toBeGreaterThan(0);
    expect(data.matches[0].text.toLowerCase()).toContain('lotus estate');
  });

  it('enforces maximum 5 tool calls per attempt budget', async () => {
    const executor = new OfferToolExecutor(sampleOffer, [], { maxToolCallsPerAttempt: 3 });

    expect((await executor.executeTool('normalize_merchant_name', { name: 'Lotus Estate' })).success).toBe(true);
    expect((await executor.executeTool('normalize_merchant_name', { name: 'Lotus Estate' })).success).toBe(true);
    expect((await executor.executeTool('normalize_merchant_name', { name: 'Lotus Estate' })).success).toBe(true);

    // 4th call in this attempt should be blocked by budget
    const fourth = await executor.executeTool('normalize_merchant_name', { name: 'Lotus Estate' });
    expect(fourth.success).toBe(false);
    expect(fourth.error).toContain('limit exceeded for this attempt');
  });

  it('enforces global offer tool budget across attempts', async () => {
    const executor = new OfferToolExecutor(sampleOffer, [], {
      maxToolCallsPerAttempt: 2,
      maxToolCallsPerOffer: 3,
    });

    // Attempt 1: 2 calls
    await executor.executeTool('normalize_merchant_name', { name: 'A' });
    await executor.executeTool('normalize_merchant_name', { name: 'B' });

    // Reset attempt for Attempt 2
    executor.resetAttemptBudget();

    // Call 3 (total 3)
    const third = await executor.executeTool('normalize_merchant_name', { name: 'C' });
    expect(third.success).toBe(true);

    // Call 4 should exceed global budget of 3
    const fourth = await executor.executeTool('normalize_merchant_name', { name: 'D' });
    expect(fourth.success).toBe(false);
    expect(fourth.error).toContain('Global offer tool budget exhausted');
  });

  it('rejects unknown or unlisted tools', async () => {
    const executor = new OfferToolExecutor(sampleOffer);
    const result = await executor.executeTool('run_arbitrary_shell_command', { cmd: 'dir' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown or disallowed tool');
  });
});
