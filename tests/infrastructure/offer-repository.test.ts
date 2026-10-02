import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

const mockClient = { query: jest.fn() };

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: { query: jest.fn() },
  withTransaction: jest.fn((fn: (client: unknown) => unknown) => fn(mockClient)),
}));

import { upsertOffer, getLlmFingerprints, completeScrapeRun } from '@/infrastructure/db/offer-repository';
import { pool } from '@/infrastructure/db/db-client';

const mockedQuery = mockClient.query;
const mockedPoolQuery = pool.query as unknown as jest.Mock;

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: null,
    title: 'Demo Offer',
    category: 'Dining',
    categoryId: 1,
    cardType: '',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Demo', location: null, addresses: [], phone: [], email: [], website: null, logo: null },
    offer: {
      description: '', discountPercentage: null, applicableCards: [],
      bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-01-01', validTo: '2026-12-31',
        periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null, timeWindow: null, exclusionDays: null,
        blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
      },
    ],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('upsertOffer — staging/review lifecycle', () => {
  beforeEach(() => { mockedQuery.mockReset(); mockedPoolQuery.mockReset(); });

  it('inserts a brand-new offer with the caller-supplied lifecycle status', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] }); // SELECT ... FOR UPDATE -> no existing row
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 'offer-1' }] }); // INSERT

    const result = await upsertOffer(makeOffer(), 'run-1', { lifecycleStatus: 'APPROVED' });

    expect(result.status).toBe('NEW');
    expect(result.isNew).toBe(true);
    expect(result.staged).toBe(false);
    const insertSql = mockedQuery.mock.calls[1][0] as string;
    const insertParams = mockedQuery.mock.calls[1][1] as unknown[];
    expect(insertSql).toContain('INSERT INTO offers');
    expect(insertParams).toContain('APPROVED');
  });

  it('does not write anything when content_hash is unchanged', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 'offer-1', content_hash: 'a'.repeat(64), db_status: 'PUBLISHED' }] });

    const result = await upsertOffer(makeOffer(), 'run-1', { lifecycleStatus: 'APPROVED' });

    expect(result.status).toBe('UNCHANGED');
    expect(result.isUnchanged).toBe(true);
    // Only the SELECT ran — no UPDATE/INSERT.
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('stages a changed candidate instead of overwriting a PUBLISHED offer', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 'offer-1', content_hash: 'old-hash', db_status: 'PUBLISHED' }] });
    mockedQuery.mockResolvedValueOnce({ rows: [] }); // staging UPDATE

    const result = await upsertOffer(makeOffer(), 'run-1', { lifecycleStatus: 'REVIEW_REQUIRED' });

    expect(result.status).toBe('CHANGED');
    expect(result.staged).toBe(true);
    const sql = mockedQuery.mock.calls[1][0] as string;
    expect(sql).toContain('pending_candidate');
    expect(sql).not.toContain('title = $2'); // must not touch the live published columns
  });

  it('overwrites directly when the existing offer was never published', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ id: 'offer-1', content_hash: 'old-hash', db_status: 'REVIEW_REQUIRED' }] });
    mockedQuery.mockResolvedValueOnce({ rows: [] }); // direct UPDATE

    const result = await upsertOffer(makeOffer(), 'run-1', { lifecycleStatus: 'APPROVED' });

    expect(result.status).toBe('CHANGED');
    expect(result.staged).toBe(false);
    const sql = mockedQuery.mock.calls[1][0] as string;
    expect(sql).toContain('title = $2');
    expect(sql).toContain('pending_candidate = NULL');
  });
});

describe('completeScrapeRun anomaly detection', () => {
  beforeEach(() => { mockedPoolQuery.mockReset(); });

  it('completes normally when volumes are steady', async () => {
    mockedPoolQuery
      .mockResolvedValueOnce({ rows: [{ bank: 'hnb' }] }) // bank lookup
      .mockResolvedValueOnce({ rows: [{ offers_found: 50 }] }) // previous run
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await completeScrapeRun('run-1', {
      found: 52, newCount: 2, changed: 5, unchanged: 45, errors: 0,
    });

    expect(res.status).toBe('completed');
    expect(res.anomalyWarning).toBeNull();
    const updateCall = mockedPoolQuery.mock.calls[2];
    expect(updateCall[1][1]).toBe('completed');
  });

  it('flags zero-result runs as warning when previous run had offers', async () => {
    mockedPoolQuery
      .mockResolvedValueOnce({ rows: [{ bank: 'hnb' }] })
      .mockResolvedValueOnce({ rows: [{ offers_found: 60 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await completeScrapeRun('run-2', {
      found: 0, newCount: 0, changed: 0, unchanged: 0, errors: 0,
    });

    expect(res.status).toBe('warning');
    expect(res.anomalyWarning).toContain('Suspicious zero-result');
    expect(res.anomalyWarning).toContain('previous run found 60');
    const updateCall = mockedPoolQuery.mock.calls[2];
    expect(updateCall[1][1]).toBe('warning');
  });

  it('flags sudden volume collapse (>50% drop) as warning', async () => {
    mockedPoolQuery
      .mockResolvedValueOnce({ rows: [{ bank: 'hnb' }] })
      .mockResolvedValueOnce({ rows: [{ offers_found: 100 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await completeScrapeRun('run-3', {
      found: 25, newCount: 0, changed: 5, unchanged: 20, errors: 0,
    });

    expect(res.status).toBe('warning');
    expect(res.anomalyWarning).toContain('volume collapse');
    expect(res.anomalyWarning).toContain('-75%');
  });

  it('flags sudden volume explosion as warning', async () => {
    mockedPoolQuery
      .mockResolvedValueOnce({ rows: [{ bank: 'hnb' }] })
      .mockResolvedValueOnce({ rows: [{ offers_found: 20 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await completeScrapeRun('run-4', {
      found: 80, newCount: 50, changed: 10, unchanged: 20, errors: 0,
    });

    expect(res.status).toBe('warning');
    expect(res.anomalyWarning).toContain('volume surge');
  });
});

describe('getLlmFingerprints', () => {
  it('maps DB rows into a lookup keyed by unique_id', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'offer-1', unique_id: 'hnb_001', content_hash: 'abc',
          llm_validated_content_hash: 'abc', llm_prompt_version: 'offer-full-v1',
          llm_validator_version: 'v1', llm_provider: 'gemini', llm_model: 'gemini-1.5-flash',
          llm_score: 90, llm_valid: true, llm_status: 'validated', llm_validated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const map = await getLlmFingerprints('hnb');
    expect(map.get('hnb_001')?.llmValidatedContentHash).toBe('abc');
    expect(map.get('hnb_001')?.llmValid).toBe(true);
    expect(map.get('missing')).toBeUndefined();
  });
});


