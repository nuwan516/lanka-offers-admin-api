import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

const mockClient = { query: jest.fn() };
const mockPool = { query: jest.fn() };

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: mockPool,
  withTransaction: jest.fn((fn: (client: unknown) => unknown) => fn(mockClient)),
}));

import {
  detectAndRecordDuplicates, flagOfferAsDuplicate, reviewDuplicateCandidate,
  shouldRunDuplicateDetection, WorkflowError,
} from '@/infrastructure/db/duplicate-repository';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001', source: 'hnb', sourceId: '001', sourceUrl: 'https://bank.example/1',
    title: '20% off Pizza Hut', category: 'Dining', categoryId: 1, cardType: 'Visa',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Pizza Hut', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
    offer: { description: '', discountPercentage: 20, applicableCards: [], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Visa'], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-09-01', validTo: '2026-09-30', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
    }],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => { mockClient.query.mockReset(); mockPool.query.mockReset(); });

describe('shouldRunDuplicateDetection', () => {
  it('runs for NEW and CHANGED, skips UNCHANGED', () => {
    expect(shouldRunDuplicateDetection('NEW')).toBe(true);
    expect(shouldRunDuplicateDetection('CHANGED')).toBe(true);
    expect(shouldRunDuplicateDetection('UNCHANGED')).toBe(false);
  });
});

describe('detectAndRecordDuplicates', () => {
  it('flags an EXACT_DUPLICATE candidate and stores the pair once, sorted by id', async () => {
    const twin = makeOffer({ sourceId: '002', sourceUrl: 'https://bank.example/2' }); // same content_hash -> EXACT_DUPLICATE
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'offer-b', bank: 'hnb', raw_offer: twin, content_hash: twin.contentHash }] }); // candidate lookup
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // pair insert

    const result = await detectAndRecordDuplicates('offer-a', makeOffer(), 'hnb');

    expect(result.flagged).toBe(true);
    expect(result.topCandidate?.classification).toBe('EXACT_DUPLICATE');

    const insertParams = mockPool.query.mock.calls[1][1] as unknown[];
    expect(insertParams[0]).toBe('offer-a'); // 'offer-a' < 'offer-b' lexicographically
    expect(insertParams[1]).toBe('offer-b');
  });

  it('stores the pair the same way regardless of which offer is scored first', async () => {
    const twin = makeOffer({ sourceId: '002', sourceUrl: 'https://bank.example/2' });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'offer-a', bank: 'hnb', raw_offer: makeOffer(), content_hash: makeOffer().contentHash }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await detectAndRecordDuplicates('offer-b', twin, 'hnb');
    const insertParams = mockPool.query.mock.calls[1][1] as unknown[];
    expect(insertParams[0]).toBe('offer-a');
    expect(insertParams[1]).toBe('offer-b');
  });

  it('does not flag when no candidate is similar enough', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'offer-b', bank: 'hnb', raw_offer: makeOffer({ merchant: { ...makeOffer().merchant, name: 'Totally Different' }, title: 'Unrelated', offer: { ...makeOffer().offer, discountPercentage: null }, contentHash: 'zzz', sourceId: 'zzz', sourceUrl: 'https://bank.example/zzz' }), content_hash: 'zzz' }],
    });

    const result = await detectAndRecordDuplicates('offer-a', makeOffer(), 'hnb');
    expect(result.flagged).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // only the lookup — no pair insert
  });

  it('performs no LLM or geo calls — only plain DB reads/writes', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await detectAndRecordDuplicates('offer-a', makeOffer(), 'hnb');
    for (const call of mockPool.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql.toLowerCase()).not.toMatch(/gemini|deepseek|openai|geocod|places/);
    }
  });
});

describe('flagOfferAsDuplicate', () => {
  it('routes a non-staged offer to REVIEW_REQUIRED with change_status=DUPLICATE, preserving the prior change_status', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ change_status: 'CHANGED', pending_change_status: null }] }); // snapshot read
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    await flagOfferAsDuplicate('offer-a', false);

    const sql = mockClient.query.mock.calls[1][0] as string;
    const params = mockClient.query.mock.calls[1][1] as unknown[];
    expect(sql).toContain(`change_status = 'DUPLICATE'`);
    expect(sql).toContain(`db_status = 'REVIEW_REQUIRED'`);
    expect(sql).toContain('pre_duplicate_change_status');
    expect(params[1]).toBe('CHANGED'); // the real prior classification, not a hardcoded guess
  });

  it('routes a staged (already-published) candidate via pending_* columns, never touching the live row', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ change_status: 'NEW', pending_change_status: 'CHANGED' }] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await flagOfferAsDuplicate('offer-a', true);

    const sql = mockClient.query.mock.calls[1][0] as string;
    expect(sql).toContain('pending_change_status');
    expect(sql).toContain('pending_lifecycle_status');
    expect(sql).not.toMatch(/^\s*UPDATE offers SET db_status/);
  });
});

function makeOfferRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'offer-a', db_status: 'REVIEW_REQUIRED', pending_candidate: null,
    rule_passed: true, rule_errors: [], rule_warnings: [],
    llm_score: 95, llm_valid: true, llm_status: 'validated',
    ...overrides,
  };
}

describe('reviewDuplicateCandidate', () => {
  it('CONFIRMED_DUPLICATE rejects a never-published flagged offer (cannot publish) without deleting it', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', offer_id: 'offer-a', status: 'PENDING' }] }); // candidate select
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // candidate status update
    mockClient.query.mockResolvedValueOnce({ rows: [makeOfferRow()] }); // offer select
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // offer UPDATE -> REJECTED
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await reviewDuplicateCandidate('cand-1', 'CONFIRMED_DUPLICATE');

    expect(result.offerNewStatus).toBe('REJECTED');
    const offerUpdateSql = mockClient.query.mock.calls[3][0] as string;
    expect(offerUpdateSql).toContain(`db_status = 'REJECTED'`);
    expect(offerUpdateSql).not.toContain('DELETE');
  });

  it('CONFIRMED_DUPLICATE on a staged change discards the pending candidate but leaves the published offer untouched', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', offer_id: 'offer-a', status: 'PENDING' }] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [makeOfferRow({ db_status: 'PUBLISHED', pending_candidate: makeOffer() })] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // clear pending_candidate
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await reviewDuplicateCandidate('cand-1', 'CONFIRMED_DUPLICATE');

    expect(result.offerNewStatus).toBe('PUBLISHED'); // the published offer itself is untouched
    const updateSql = mockClient.query.mock.calls[3][0] as string;
    expect(updateSql).toContain('pending_candidate = NULL');
    expect(updateSql).not.toContain('db_status');
  });

  it('NOT_DUPLICATE re-enters the normal workflow via decideOfferQuality, restoring the real prior change_status (not always NEW)', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', offer_id: 'offer-a', status: 'PENDING' }] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [makeOfferRow({
      llm_score: 95, llm_valid: true, llm_status: 'validated', rule_passed: true,
      pre_duplicate_change_status: 'CHANGED',
    })] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // offer UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await reviewDuplicateCandidate('cand-1', 'NOT_DUPLICATE');

    expect(result.offerNewStatus).toBe('APPROVED'); // high score + rule pass -> AUTO_APPROVE
    const updateSql = mockClient.query.mock.calls[3][0] as string;
    const updateParams = mockClient.query.mock.calls[3][1] as unknown[];
    expect(updateSql).toContain('change_status = $2');
    expect(updateParams[1]).toBe('CHANGED'); // restored, not hardcoded to NEW
  });

  it('falls back to NEW only when no pre_duplicate_change_status was ever recorded', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', offer_id: 'offer-a', status: 'PENDING' }] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [makeOfferRow({
      llm_score: 95, llm_valid: true, llm_status: 'validated', rule_passed: true,
      pre_duplicate_change_status: null,
    })] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await reviewDuplicateCandidate('cand-1', 'NOT_DUPLICATE');

    const updateParams = mockClient.query.mock.calls[3][1] as unknown[];
    expect(updateParams[1]).toBe('NEW');
  });

  it('IGNORED leaves the offer lifecycle untouched', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', offer_id: 'offer-a', status: 'PENDING' }] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [makeOfferRow({ db_status: 'REVIEW_REQUIRED' })] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history only

    const result = await reviewDuplicateCandidate('cand-1', 'IGNORED');
    expect(result.offerNewStatus).toBe('REVIEW_REQUIRED');
    expect(mockClient.query).toHaveBeenCalledTimes(4); // no extra offers UPDATE beyond the select
  });

  it('throws WorkflowError for a missing candidate', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    await expect(reviewDuplicateCandidate('missing', 'IGNORED')).rejects.toThrow(WorkflowError);
  });
});
