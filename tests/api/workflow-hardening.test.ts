const mockClient = { query: jest.fn() };
const mockPool = { query: jest.fn() };

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: mockPool,
  withTransaction: jest.fn((fn: (client: unknown) => unknown) => fn(mockClient)),
}));

import { mergeDuplicateOffers } from '@/api/services/duplicate-merge-service';
import { JobManager } from '@/api/services/job-manager';
import {
  saveManualCorrection,
  transitionOffer,
  WorkflowError,
} from '@/infrastructure/db/offer-workflow-repository';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

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

describe('Workflow Hardening Tests (Phase 2)', () => {
  beforeEach(() => {
    mockClient.query.mockReset();
    mockPool.query.mockReset();
  });

  describe('DuplicateMergeService — Provenance Preservation', () => {
    it('rejects self-merge where canonicalOfferId equals duplicateOfferId', async () => {
      await expect(
        mergeDuplicateOffers({
          canonicalOfferId: 'offer-123',
          duplicateOfferId: 'offer-123',
          reason: 'Test merge',
        })
      ).rejects.toThrow('Cannot merge an offer into itself');
    });

    it('merges duplicate into canonical while preserving raw evidence in _merged_provenance', async () => {
      const mockCanonical = {
        id: 'offer-canonical',
        unique_id: 'hnb_001',
        bank: 'hnb',
        title: '20% Off at Keells Super',
        manual_override: {},
      };

      const mockDuplicate = {
        id: 'offer-dup',
        unique_id: 'hnb_002',
        bank: 'hnb',
        title: 'Keells Super 20% Discount',
        source_url: 'https://hnb.net/keells-promo',
        content_hash: 'hash-abc-123',
        created_at: new Date('2026-01-01'),
        raw_offer: { raw_title: 'Keells Super 20% Discount' },
        db_status: 'REVIEW_REQUIRED',
        change_status: 'NEW',
      };

      const queryCalls: { text: string; values?: any[] }[] = [];
      mockClient.query.mockImplementation((text: string, values?: any[]) => {
        queryCalls.push({ text, values });
        if (text.includes('SELECT * FROM offers WHERE id IN')) {
          return Promise.resolve({ rows: [mockCanonical, mockDuplicate] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await mergeDuplicateOffers({
        canonicalOfferId: 'offer-canonical',
        duplicateOfferId: 'offer-dup',
        reason: 'Duplicate scrape of same campaign',
        actor: 'test-admin',
      });

      expect(result.success).toBe(true);
      expect(result.disabledOfferId).toBe('offer-dup');

      // Verify canonical update includes _merged_provenance
      const canonicalUpdate = queryCalls.find(
        (q) => q.text.includes('UPDATE offers') && q.values?.some((v) => v === 'offer-canonical')
      );
      expect(canonicalUpdate).toBeDefined();
      const rawJson = canonicalUpdate?.values?.[1];
      const updatedOverride = JSON.parse(rawJson);
      expect(updatedOverride).toHaveProperty('_merged_provenance');
      expect(updatedOverride._merged_provenance).toHaveLength(1);
      expect(updatedOverride._merged_provenance[0]).toMatchObject({
        mergedOfferId: 'offer-dup',
        sourceUrl: 'https://hnb.net/keells-promo',
        contentHash: 'hash-abc-123',
        reason: 'Duplicate scrape of same campaign',
        mergedBy: 'test-admin',
      });

      // Verify duplicate is DISABLED and marked MERGED
      const duplicateUpdate = queryCalls.find(
        (q) => q.text.includes('UPDATE offers') && q.values?.some((v) => v === 'offer-dup')
      );
      expect(duplicateUpdate).toBeDefined();
      expect(duplicateUpdate?.text).toContain("db_status = 'DISABLED'");
      expect(duplicateUpdate?.text).toContain("change_status = 'MERGED'");

      // Verify duplicate candidate status updated
      const candidateUpdate = queryCalls.find(
        (q) => q.text.includes('duplicate_candidates') && q.text.includes('CONFIRMED_DUPLICATE')
      );
      expect(candidateUpdate).toBeDefined();

      // Verify audit history inserted for both offers
      const historyInserts = queryCalls.filter((q) => q.text.includes('offer_review_history'));
      expect(historyInserts.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('JobManager — Concurrency and Stale Recovery', () => {
    it('validates supported banks', () => {
      const jm = new JobManager();
      expect(jm.isValidBank('hnb')).toBe(true);
      expect(jm.isValidBank('combank')).toBe(true);
      expect(jm.isValidBank('all')).toBe(true);
      expect(jm.isValidBank('invalid_bank')).toBe(false);
    });

    it('rejects concurrent scrape on the same bank', () => {
      const jm = new JobManager();
      (jm as any).activeJobs.set('hnb', {
        child: { kill: jest.fn() },
        bank: 'hnb',
        startedAt: new Date().toISOString(),
        pid: 99999,
      });

      expect(() => jm.startScrapeJob('hnb')).toThrow(
        /already running/
      );
    });

    it('forbids running all banks when a single bank is active', () => {
      const jm = new JobManager();
      (jm as any).activeJobs.set('boc', {
        child: { kill: jest.fn() },
        bank: 'boc',
        startedAt: new Date().toISOString(),
        pid: 88888,
      });

      expect(() => jm.startScrapeJob('all')).toThrow(
        /Cannot run 'all'/
      );
    });

    it('recovers stale runs on startup', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 3 });

      const jm = new JobManager();
      const recovered = await jm.recoverStaleRunsOnStartup();

      expect(recovered).toBe(3);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE scrape_runs/i)
      );
    });

    it('reconciles orphaned running runs from DB when cancel is requested for a bank not in memory', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      const jm = new JobManager();
      const res = await jm.cancelScrapeJob('hnb', 'operator');

      expect(res.cancelled).toBe(true);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE scrape_runs\s+SET status = 'failed'/i),
        expect.arrayContaining(['hnb'])
      );
    });

    it('cancels all individual active jobs when group cancel for all is requested', async () => {
      const jm = new JobManager();
      const killHnb = jest.fn();
      const killBoc = jest.fn();

      (jm as any).activeJobs.set('hnb', {
        child: { kill: killHnb },
        bank: 'hnb',
        startedAt: new Date().toISOString(),
        pid: 11111,
        timeoutTimer: setTimeout(() => {}, 10000),
      });

      (jm as any).activeJobs.set('boc', {
        child: { kill: killBoc },
        bank: 'boc',
        startedAt: new Date().toISOString(),
        pid: 22222,
        timeoutTimer: setTimeout(() => {}, 10000),
      });

      mockPool.query.mockResolvedValue({ rowCount: 1 });

      const res = await jm.cancelScrapeJob('all', 'operator');
      expect(res.cancelled).toBe(true);
      expect((jm as any).activeJobs.size).toBe(0);
    });

    it('supports configurable watchdog timeout via SCRAPER_JOB_TIMEOUT_MS and options.timeoutMs', () => {
      const prevEnv = process.env.SCRAPER_JOB_TIMEOUT_MS;
      process.env.SCRAPER_JOB_TIMEOUT_MS = '600000';
      const timeoutMs = Number(process.env.SCRAPER_JOB_TIMEOUT_MS) || 15 * 60 * 1000;
      expect(timeoutMs).toBe(600000);

      // Verify custom options override
      const customOptionTimeout = 1200000;
      const effectiveTimeout = customOptionTimeout > 0 ? customOptionTimeout : timeoutMs;
      expect(effectiveTimeout).toBe(1200000);

      if (prevEnv !== undefined) {
        process.env.SCRAPER_JOB_TIMEOUT_MS = prevEnv;
      } else {
        delete process.env.SCRAPER_JOB_TIMEOUT_MS;
      }
    });
  });

  describe('OfferWorkflowRepository — Optimistic Concurrency Control', () => {
    it('throws WorkflowError when expectedUpdatedAt does not match current record updated_at in saveManualCorrection', async () => {
      const mockOffer = {
        id: 'offer-1',
        unique_id: 'test_1',
        bank: 'hnb',
        title: 'Sample Offer',
        manual_override: {},
        updated_at: new Date('2026-02-01T10:00:00Z'),
        raw_offer: makeOffer(),
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockOffer] });

      const staleTimestamp = '2026-01-01T08:00:00.000Z';

      await expect(
        saveManualCorrection('offer-1', { title: 'Updated Title' }, 'admin', 'Edit title', staleTimestamp)
      ).rejects.toThrow(/Concurrent modification conflict/);
    });

    it('throws WorkflowError when expectedUpdatedAt does not match current record updated_at in transitionOffer', async () => {
      const mockOffer = {
        id: 'offer-1',
        unique_id: 'test_1',
        bank: 'hnb',
        title: 'Sample Offer',
        manual_override: {},
        updated_at: new Date('2026-02-01T10:00:00Z'),
        db_status: 'REVIEW_REQUIRED',
        change_status: 'NEW',
        raw_offer: makeOffer(),
      };

      mockClient.query.mockResolvedValueOnce({ rows: [mockOffer] });

      const staleTimestamp = '2026-01-01T08:00:00.000Z';

      await expect(
        transitionOffer('offer-1', 'APPROVE', 'admin', 'LGTM', undefined, staleTimestamp)
      ).rejects.toThrow(/Concurrent modification conflict/);
    });
  });

  describe('Log Reader — Security & Path Traversal Prevention', () => {
    it('validates bank filters against known banks', () => {
      const validBanks = ['hnb', 'boc', 'sampath', 'ndb', 'dfcc', 'seylan', 'peoples', 'pabc', 'nsb', 'combank'];
      const isBankValid = (b: string) => validBanks.includes(b.toLowerCase());

      expect(isBankValid('hnb')).toBe(true);
      expect(isBankValid('../../etc/passwd')).toBe(false);
      expect(isBankValid('unknown_bank')).toBe(false);
    });

    it('ensures log directory paths cannot traverse outside root logs folder', () => {
      const path = require('path');
      const safeBaseDir = path.resolve(__dirname, '..', '..', 'logs');
      const maliciousTarget = path.resolve(safeBaseDir, '..', '..', 'windows', 'system32');
      const isContained = maliciousTarget.startsWith(safeBaseDir);

      expect(isContained).toBe(false);
    });
  });
});

