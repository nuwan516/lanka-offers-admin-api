import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

const mockClient = { query: jest.fn() };
const mockPool = { query: jest.fn() };

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: mockPool,
  withTransaction: jest.fn((fn: (client: unknown) => unknown) => fn(mockClient)),
}));

import {
  transitionOffer, saveManualCorrection, syncApprovedOffer,
  bulkSyncApprovedOffers, getSyncPreview, WorkflowError,
} from '@/infrastructure/db/offer-workflow-repository';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001', source: 'hnb', sourceId: '001', sourceUrl: null,
    title: 'Demo Offer', category: 'Dining', categoryId: 1, cardType: '',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Demo', location: null, addresses: [], phone: [], email: [], website: null, logo: null },
    offer: { description: '', discountPercentage: 20, applicableCards: [], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-01-01', validTo: '2026-12-31', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
    }],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'offer-1', unique_id: 'hnb_001', bank: 'hnb', db_status: 'REVIEW_REQUIRED',
    change_status: 'NEW', raw_offer: makeOffer(), manual_override: {},
    pending_candidate: null, pending_lifecycle_status: null, pending_change_status: null,
    content_hash: 'a'.repeat(64), geo_locations: [],
    ...overrides,
  };
}

beforeEach(() => { mockClient.query.mockReset(); mockPool.query.mockReset(); });

describe('transitionOffer', () => {
  it('approves a review-required offer and records history', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'REVIEW_REQUIRED' })] }); // SELECT FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history insert

    const result = await transitionOffer('offer-1', 'APPROVE');
    expect(result.fromStatus).toBe('REVIEW_REQUIRED');
    expect(result.toStatus).toBe('APPROVED');

    const historySql = mockClient.query.mock.calls[2][0] as string;
    expect(historySql).toContain('offer_review_history');
  });

  it('rejects an invalid transition (cannot PUBLISH a review-required offer)', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'REVIEW_REQUIRED' })] });
    await expect(transitionOffer('offer-1', 'PUBLISH')).rejects.toThrow(WorkflowError);
  });

  it('a rejected offer cannot be published', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'REJECTED' })] });
    await expect(transitionOffer('offer-1', 'PUBLISH')).rejects.toThrow(WorkflowError);
  });

  it('throws WorkflowError for a missing offer', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    await expect(transitionOffer('missing', 'APPROVE')).rejects.toThrow(WorkflowError);
  });

  it('APPROVE on a staged (already-published) candidate moves pending_lifecycle_status, never the live db_status', async () => {
    const row = makeRow({ db_status: 'PUBLISHED', pending_candidate: makeOffer(), pending_lifecycle_status: 'REVIEW_REQUIRED' });
    mockClient.query.mockResolvedValueOnce({ rows: [row] }); // SELECT FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // pending_lifecycle_status UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await transitionOffer('offer-1', 'APPROVE');

    expect(result.fromStatus).toBe('REVIEW_REQUIRED');
    expect(result.toStatus).toBe('APPROVED');
    const updateSql = mockClient.query.mock.calls[1][0] as string;
    expect(updateSql).toContain('pending_lifecycle_status');
    expect(updateSql).not.toContain('db_status');
  });

  it('REJECT on a staged candidate rejects only the pending update, leaving the published offer live', async () => {
    const row = makeRow({ db_status: 'PUBLISHED', pending_candidate: makeOffer(), pending_lifecycle_status: 'APPROVED' });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const result = await transitionOffer('offer-1', 'REJECT');

    expect(result.toStatus).toBe('REJECTED');
    const updateSql = mockClient.query.mock.calls[1][0] as string;
    expect(updateSql).toContain('pending_lifecycle_status');
    expect(updateSql).not.toContain('db_status');
  });

  it('PUBLISH on an approved staged candidate delegates to the same merge+validate logic as sync, not a bare status flip', async () => {
    const row = makeRow({ db_status: 'PUBLISHED', pending_candidate: makeOffer({ title: 'New Title' }), pending_lifecycle_status: 'APPROVED' });
    mockClient.query.mockResolvedValueOnce({ rows: [row] }); // transitionOffer's own SELECT
    mockClient.query.mockResolvedValueOnce({ rows: [row] }); // syncOneOfferWithClient's SELECT
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // publish UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await transitionOffer('offer-1', 'PUBLISH');

    expect(result.toStatus).toBe('PUBLISHED');
    const publishSql = mockClient.query.mock.calls[2][0] as string;
    const publishParams = mockClient.query.mock.calls[2][1] as unknown[];
    expect(publishSql).toContain(`db_status = 'PUBLISHED'`);
    expect(publishParams[1]).toBe('New Title'); // merged candidate title actually written
  });

  it('PUBLISH refuses (and does not flip status) when the candidate now fails final validation', async () => {
    const badCandidate = makeOffer({ uniqueId: '' });
    const row = makeRow({ db_status: 'PUBLISHED', pending_candidate: badCandidate, pending_lifecycle_status: 'APPROVED' });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // sync_failed history only

    await expect(transitionOffer('offer-1', 'PUBLISH')).rejects.toThrow(WorkflowError);
  });
});

describe('saveManualCorrection', () => {
  it('merges only the sanitized override into manual_override, preserving raw_offer', async () => {
    const row = makeRow();
    mockClient.query.mockResolvedValueOnce({ rows: [row] }); // SELECT FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await saveManualCorrection('offer-1', { 'merchant.name': 'Fixed Name', sourceUrl: 'evil' });

    expect(result.manualOverride).toEqual({ 'merchant.name': 'Fixed Name' }); // sourceUrl stripped
    const updateParams = mockClient.query.mock.calls[1][1] as unknown[];
    expect(JSON.parse(updateParams[1] as string)).toEqual({ 'merchant.name': 'Fixed Name' });
  });
});

describe('syncApprovedOffer', () => {
  it('publishes an APPROVED offer', async () => {
    const row = makeRow({ db_status: 'APPROVED' });
    mockClient.query.mockResolvedValueOnce({ rows: [row] }); // SELECT FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // UPDATE publish
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history

    const result = await syncApprovedOffer('offer-1');
    expect(result.outcome).toBe('published');
    const updateSql = mockClient.query.mock.calls[1][0] as string;
    expect(updateSql).toContain(`db_status = 'PUBLISHED'`);
  });

  it('skips an offer that is not eligible (still REVIEW_REQUIRED)', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'REVIEW_REQUIRED' })] });
    const result = await syncApprovedOffer('offer-1');
    expect(result.outcome).toBe('skipped');
  });

  it('rejected offers are never eligible for sync', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'REJECTED' })] });
    const result = await syncApprovedOffer('offer-1');
    expect(result.outcome).toBe('skipped');
  });

  it('fails (does not publish) when the effective offer fails final validation', async () => {
    const badOffer = makeOffer({ uniqueId: '' }); // triggers a required-field rule error
    const row = makeRow({ db_status: 'APPROVED', raw_offer: badOffer });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // sync_failed history log

    const result = await syncApprovedOffer('offer-1');
    expect(result.outcome).toBe('failed');
    // only the history insert ran — no publish UPDATE
    expect(mockClient.query).toHaveBeenCalledTimes(2);
  });

  it('applies manual overrides onto the published result', async () => {
    const row = makeRow({ db_status: 'APPROVED', manual_override: { title: 'Corrected Title' } });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    await syncApprovedOffer('offer-1');
    const updateParams = mockClient.query.mock.calls[1][1] as unknown[];
    expect(updateParams[1]).toBe('Corrected Title');
  });

  it('publishes an approved update to an already-published offer from its pending_candidate', async () => {
    const candidate = makeOffer({ title: 'New Title' });
    const row = makeRow({
      db_status: 'PUBLISHED', pending_candidate: candidate, pending_lifecycle_status: 'APPROVED',
    });
    mockClient.query.mockResolvedValueOnce({ rows: [row] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const result = await syncApprovedOffer('offer-1');
    expect(result.outcome).toBe('published');
    const updateParams = mockClient.query.mock.calls[1][1] as unknown[];
    expect(updateParams[1]).toBe('New Title');
  });
});

describe('bulkSyncApprovedOffers', () => {
  it('only processes APPROVED (and approved-pending) offers, skipping review/rejected', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] }); // INSERT sync run
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'offer-1', db_status: 'APPROVED' }] }); // eligible query
    mockClient.query.mockResolvedValueOnce({ rows: [makeRow({ db_status: 'APPROVED' })] }); // SELECT FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // publish UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // history
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // final sync_runs UPDATE

    const summary = await bulkSyncApprovedOffers('admin');

    expect(summary.published).toBe(1);
    expect(summary.failed).toBe(0);
    const eligibleSql = mockPool.query.mock.calls[1][0] as string;
    expect(eligibleSql).toContain(`db_status = 'APPROVED'`);
    expect(eligibleSql).not.toContain(`'REVIEW_REQUIRED'`);
    expect(eligibleSql).not.toContain(`'REJECTED'`);
  });

  it('is idempotent — a second run with nothing newly eligible publishes 0', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'run-2' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // nothing eligible this time
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // final update

    const summary = await bulkSyncApprovedOffers('admin');
    expect(summary.published).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe('getSyncPreview', () => {
  it('is read-only (a single SELECT, no writes) and returns the expected shape', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ approved_ready: '3', review_required: '5', rejected: '1', already_published: '20', changed_existing: '2' }],
    });

    const preview = await getSyncPreview();
    expect(preview).toEqual({ approvedReady: 3, reviewRequired: 5, rejected: 1, alreadyPublished: 20, changedExisting: 2 });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const sql = mockPool.query.mock.calls[0][0] as string;
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
  });
});
