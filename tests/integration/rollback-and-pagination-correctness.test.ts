/**
 * Phase 23 — Final Three Correctness Fixes Verification for HNB + BOC Pilot
 *
 * Verifies:
 * 1. Safe Rollback Operations:
 *    - rollbackScrapeRun: Preserves pre-existing published offers, clears candidates,
 *      disables unapproved new offers, and respects later operator decisions.
 *    - rollbackPublicationRun: Reverts published batches to pre-publication state
 *      while preserving offers modified by subsequent operator actions.
 *    - rollbackSingleOffer: Concurrency conflict protection (optimistic locking) and audit logging.
 *    - Idempotency & Reversibility: Repeated rollback requests safely return already_rolled_back.
 * 2. Pagination Correctness:
 *    - Offset pagination under concurrent insertions, modifications, and expirations.
 *    - Validates duplicate elimination via frontend deduplication and reconciliation on refresh.
 * 3. Physical Branch Map Eligibility:
 *    - Nationwide coverage does NOT categorically suppress verified participating branches.
 *    - Exact pins require: participating-outlet evidence, branch identity, verified premise coordinates, published status.
 *    - Uncertain street-level results are kept OUT of exact-premises pins.
 */

import * as crypto from 'crypto';
import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { PublicOfferQueryHarness } from './helpers/public-offer-query-harness';
import { upsertOffer, createScrapeRun, type FencingToken } from '../../src/infrastructure/db/offer-repository';
import {
  transitionOffer,
  syncApprovedOffer,
  bulkSyncApprovedOffers,
  getReviewHistory,
} from '../../src/infrastructure/db/offer-workflow-repository';
import {
  rollbackScrapeRun,
  rollbackPublicationRun,
  rollbackSingleOffer,
} from '../../src/infrastructure/db/rollback-operations';
import { BranchParticipationService } from '../../src/domain/participating-branch';
import { GeocodingVerifier } from '../../src/geo/geocoding-verifier';
import { Offer, PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { LocationScope } from '../../src/domain/location-scope';

let harness: RealPostgresHarness;
let poolAdapter: ReturnType<RealPostgresHarness['getPoolAdapter']>;

// Connect admin/api's db client to the isolated PGlite harness
jest.mock('../../src/infrastructure/db/db-client', () => {
  return {
    get pool() {
      return poolAdapter;
    },
    query: (sql: string, params?: unknown[]) => poolAdapter.query(sql, params),
    getClient: () => poolAdapter.connect(),
    withTransaction: async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
      const client = await poolAdapter.connect();
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

describe('Phase 23: Final Three Correctness Fixes Before HNB + BOC Pilot', () => {
  let offerRepo: PublicOfferQueryHarness;

  beforeAll(async () => {
    harness = new RealPostgresHarness();
    await harness.initSchema();
    poolAdapter = harness.getPoolAdapter();
    offerRepo = new PublicOfferQueryHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('Task 1: Safe Rollback Operations', () => {
    const leaseToken: FencingToken = {
      bank: 'hnb',
      jobId: 'safe-rollback-job',
      leaseGeneration: 1,
    };

    beforeAll(async () => {
      await poolAdapter.query(
        `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
         VALUES ('hnb', $1, 'inst-p23', 1, NOW(), NOW(), NOW() + interval '10 minutes')
         ON CONFLICT (bank) DO UPDATE SET job_id = $1, heartbeat_at = NOW(), expires_at = NOW() + interval '10 minutes'`,
        [leaseToken.jobId]
      );
    });

    it('rolls back a scrape run while preserving existing published offers, pending candidates, and later approvals', async () => {
      // 1. Establish pre-existing published offer from Run 1
      const run1Id = await createScrapeRun('hnb', 'initial-batch-1', 'cli', leaseToken);
      const preExistingOffer: Offer = {
        uniqueId: 'hnb-pre-launch-1',
        source: 'hnb',
        sourceId: 'pre-1',
        sourceUrl: 'https://www.hnb.lk/pre-1',
        title: 'Original Pre-existing Promotion',
        category: 'Dining',
        categoryId: 1,
        cardType: 'Visa Platinum',
        scrapedAt: new Date().toISOString(),
        merchant: { name: 'Pre-existing Merchant', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
        offer: { description: 'Original terms', discountPercentage: 15, applicableCards: ['Visa'], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
        installmentPlans: [],
        transactionRange: { min: null, max: null, currency: 'LKR' },
        cardEligibility: { includedCards: ['Platinum'], excludedCards: [], cardTypes: ['Credit Card'], networks: ['Visa'], restrictions: [] },
        images: { logo: null, gallery: [], images: [] },
        validityPeriods: [{ validFrom: '2026-01-01', validTo: '2026-12-31', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY, recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: 'Valid until 31 Dec 2026' }],
        contentHash: crypto.createHash('sha256').update('pre-1-hash').digest('hex'),
      };

      const preUpsert = await upsertOffer(preExistingOffer, run1Id, { lifecycleStatus: 'APPROVED' }, leaseToken);
      await syncApprovedOffer(preUpsert.id, leaseToken);

      // Verify it is PUBLISHED
      const initialRow = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [preUpsert.id])).rows[0];
      expect(initialRow.db_status).toBe('PUBLISHED');
      expect(initialRow.title).toBe('Original Pre-existing Promotion');

      // 2. Scrape Run 2 runs and touches 3 offers:
      // - Offer A: Rescrapes preExistingOffer with a candidate update
      // - Offer B: Newly discovered offer (remains REVIEW_REQUIRED)
      // - Offer C: Newly discovered offer that gets APPROVED by an operator afterwards
      const run2Id = await createScrapeRun('hnb', 'batch-run-2', 'cli', leaseToken);

      // Offer A candidate update
      const candidateUpdate: Offer = {
        ...preExistingOffer,
        title: 'Corrupted Candidate Update from Run 2',
        contentHash: crypto.createHash('sha256').update('corrupted-cand-hash').digest('hex'),
      };
      await upsertOffer(candidateUpdate, run2Id, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken);

      // Offer B: newly discovered
      const newOfferB: Offer = {
        ...preExistingOffer,
        uniqueId: 'hnb-new-b',
        title: 'New Unapproved Offer B',
        contentHash: crypto.createHash('sha256').update('new-b-hash').digest('hex'),
      };
      const upsertB = await upsertOffer(newOfferB, run2Id, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken);

      // Offer C: newly discovered, then approved by operator
      const newOfferC: Offer = {
        ...preExistingOffer,
        uniqueId: 'hnb-new-c',
        title: 'New Offer C with Subsequent Operator Approval',
        contentHash: crypto.createHash('sha256').update('new-c-hash').digest('hex'),
      };
      const upsertC = await upsertOffer(newOfferC, run2Id, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken);

      // Operator explicitly approves Offer C after the scrape run
      await transitionOffer(upsertC.id, 'APPROVE', 'operator:alice', 'Verified by human operator');

      // 3. EXECUTE SAFE ROLLBACK on Run 2
      const rollbackSummary = await rollbackScrapeRun(run2Id, {
        actor: 'operator:bob',
        reason: 'Scrape Run 2 had corrupted parser rules',
      });

      expect(rollbackSummary.outcome).toBe('rolled_back');
      expect(rollbackSummary.candidatesCleared).toBe(1);
      expect(rollbackSummary.newOffersDisabled).toBe(1); // Offer B disabled
      expect(rollbackSummary.preservedPublished).toBe(1); // Offer A preserved
      expect(rollbackSummary.preservedOperatorActions).toBe(1); // Offer C preserved!

      // 4. Verify Database State:
      // Offer A: Still PUBLISHED, original title intact, candidate cleared
      const rowA = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [preUpsert.id])).rows[0];
      expect(rowA.db_status).toBe('PUBLISHED');
      expect(rowA.title).toBe('Original Pre-existing Promotion');
      expect(rowA.pending_candidate).toBeNull();

      // Offer B: Disabled
      const rowB = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [upsertB.id])).rows[0];
      expect(rowB.db_status).toBe('DISABLED');

      // Offer C: Retains operator's approval (APPROVED) and is NOT disabled
      const rowC = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [upsertC.id])).rows[0];
      expect(rowC.db_status).toBe('APPROVED');

      // 5. Repeated Rollback Request (Idempotency):
      const repeatResult = await rollbackScrapeRun(run2Id);
      expect(repeatResult.outcome).toBe('already_rolled_back');
      expect(repeatResult.totalAffected).toBe(0);

      // 6. Verify Audit History
      const historyA = await getReviewHistory(preUpsert.id);
      expect(historyA.some((h) => h.action === 'rollback_scrape_candidate')).toBe(true);

      const historyB = await getReviewHistory(upsertB.id);
      expect(historyB.some((h) => h.action === 'rollback_scrape_new' && h.to_status === 'DISABLED')).toBe(true);
    });

    it('rolls back a publication sync batch while preserving subsequent operator changes', async () => {
      // 1. Setup 2 approved offers to publish in a sync batch
      const offer1: Offer = {
        uniqueId: 'hnb-sync-test-1',
        source: 'hnb',
        sourceId: 'sync-1',
        sourceUrl: 'https://www.hnb.lk/sync-1',
        title: 'Promotion Published in Batch',
        category: 'Shopping',
        categoryId: 3,
        cardType: 'Visa',
        scrapedAt: new Date().toISOString(),
        merchant: { name: 'Sync Merchant 1', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
        offer: { description: 'Sync terms', discountPercentage: 20, applicableCards: ['Visa'], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
        installmentPlans: [],
        transactionRange: { min: null, max: null, currency: 'LKR' },
        cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Credit Card'], networks: ['Visa'], restrictions: [] },
        images: { logo: null, gallery: [], images: [] },
        validityPeriods: [{ validFrom: '2026-01-01', validTo: '2026-12-31', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY, recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: 'Valid until 31 Dec 2026' }],
        contentHash: crypto.createHash('sha256').update('sync-1-hash').digest('hex'),
      };

      const offer2: Offer = {
        ...offer1,
        uniqueId: 'hnb-sync-test-2',
        title: 'Promotion Published then Operator Disabled',
        contentHash: crypto.createHash('sha256').update('sync-2-hash').digest('hex'),
      };

      const runId = await createScrapeRun('hnb', 'sync-prep', 'cli', leaseToken);
      const res1 = await upsertOffer(offer1, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);
      const res2 = await upsertOffer(offer2, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);

      // Execute bulk sync
      const syncSummary = await bulkSyncApprovedOffers('operator:batch');
      expect(syncSummary.published).toBeGreaterThanOrEqual(2);

      // Verify both are PUBLISHED
      const postSync1 = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [res1.id])).rows[0];
      const postSync2 = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [res2.id])).rows[0];
      expect(postSync1.db_status).toBe('PUBLISHED');
      expect(postSync2.db_status).toBe('PUBLISHED');

      // Operator subsequently takes explicit action on Offer 2: DISABLE with specific reason
      await transitionOffer(res2.id, 'DISABLE', 'operator:charlie', 'Merchant copyright infringement');

      // 2. EXECUTE SAFE PUBLICATION ROLLBACK
      const pubRollback = await rollbackPublicationRun(syncSummary.syncRunId, {
        actor: 'operator:lead',
        reason: 'Sync run included unverified merchant terms',
      });

      expect(pubRollback.outcome).toBe('rolled_back');
      expect(pubRollback.revertedCount).toBeGreaterThanOrEqual(1);
      expect(pubRollback.skippedLaterOperatorActions).toBe(1); // Offer 2 preserved!

      // 3. Verify:
      // Offer 1 reverted from PUBLISHED to APPROVED/REVIEW_REQUIRED
      const revertedOffer1 = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [res1.id])).rows[0];
      expect(revertedOffer1.db_status).not.toBe('PUBLISHED');

      // Offer 2 preserved as DISABLED (operator decision respected!)
      const preservedOffer2 = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [res2.id])).rows[0];
      expect(preservedOffer2.db_status).toBe('DISABLED');

      // 4. Repeated rollback is idempotent
      const repeatPub = await rollbackPublicationRun(syncSummary.syncRunId);
      expect(repeatPub.outcome).toBe('already_rolled_back');
    });

    it('supports single-offer rollback with optimistic concurrency protection', async () => {
      const singleOffer: Offer = {
        uniqueId: 'hnb-single-rollback-1',
        source: 'hnb',
        sourceId: 'single-1',
        sourceUrl: 'https://www.hnb.lk/single-1',
        title: 'Single Offer to Roll Back',
        category: 'Travel',
        categoryId: 4,
        cardType: 'Visa',
        scrapedAt: new Date().toISOString(),
        merchant: { name: 'Travel Merchant', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
        offer: { description: 'Travel terms', discountPercentage: 25, applicableCards: ['Visa'], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
        installmentPlans: [],
        transactionRange: { min: null, max: null, currency: 'LKR' },
        cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Credit Card'], networks: ['Visa'], restrictions: [] },
        images: { logo: null, gallery: [], images: [] },
        validityPeriods: [{ validFrom: '2026-01-01', validTo: '2026-12-31', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY, recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: 'Valid until 31 Dec 2026' }],
        contentHash: crypto.createHash('sha256').update('single-1-hash').digest('hex'),
      };

      const runId = await createScrapeRun('hnb', 'single-prep', 'cli', leaseToken);
      const res = await upsertOffer(singleOffer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);
      await syncApprovedOffer(res.id, leaseToken);

      const publishedRow = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [res.id])).rows[0];
      expect(publishedRow.db_status).toBe('PUBLISHED');

      // 1. Optimistic concurrency conflict test
      const conflictRes = await rollbackSingleOffer(res.id, {
        actor: 'operator:dave',
        reason: 'Testing conflict',
        expectedUpdatedAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      });
      expect(conflictRes.outcome).toBe('conflict');

      // 2. Successful single-offer rollback
      const successRes = await rollbackSingleOffer(res.id, {
        actor: 'operator:dave',
        reason: 'Immediate consumer revocation',
        expectedUpdatedAt: publishedRow.updated_at,
      });

      expect(successRes.outcome).toBe('rolled_back');
      expect(successRes.toStatus).toBe('REVIEW_REQUIRED');

      const finalRow = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [res.id])).rows[0];
      expect(finalRow.db_status).toBe('REVIEW_REQUIRED');
    });
  });

  describe('Task 2: Pagination Correctness Under Concurrent Modifications', () => {
    it('verifies duplicate prevention and missing-record reconciliation between consecutive offset requests', async () => {
      // Seed 30 published offers
      const baseTs = Date.now();
      for (let i = 0; i < 30; i++) {
        await poolAdapter.query(
          `INSERT INTO offers (
            unique_id, bank, source_url, title, category, card_type,
            merchant_name, merchant_location, discount_percentage, valid_from, valid_to,
            db_status, change_status, raw_offer, content_hash, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            `page-test-${i}`, 'boc', 'https://www.boc.lk/page', `Paginated Offer ${i}`,
            'Dining', 'Mastercard', 'Merchant P', 'Colombo', '10', '2026-01-01', '2026-12-31',
            'PUBLISHED', 'NEW', '{}',
            crypto.createHash('sha256').update(`page-test-${i}`).digest('hex'),
            new Date(baseTs - i * 1000).toISOString(),
          ]
        );
      }

      // Step A: Client requests Page 1 (offset: 0, limit: 10)
      const page1 = await offerRepo.findPublishedOffers({ limit: 10, offset: 0 });
      expect(page1.items.length).toBe(10);

      const clientSeenIds = new Set<string>();
      const clientReceivedOffers: string[] = [];
      for (const item of page1.items) {
        if (!clientSeenIds.has(item.id)) {
          clientSeenIds.add(item.id);
          clientReceivedOffers.push(item.id);
        }
      }

      // Step B: Concurrently simulate database activity before Page 2 request:
      // 1. Two new offers inserted with newer timestamps (causes items 9 and 10 to shift into Page 2)
      for (let k = 0; k < 2; k++) {
        await poolAdapter.query(
          `INSERT INTO offers (
            unique_id, bank, source_url, title, category, card_type,
            merchant_name, merchant_location, discount_percentage, valid_from, valid_to,
            db_status, change_status, raw_offer, content_hash, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            `concurrent-insert-${k}`, 'boc', 'https://www.boc.lk/new', `Concurrent Insert ${k}`,
            'Dining', 'Mastercard', 'Merchant New', 'Colombo', '10', '2026-01-01', '2026-12-31',
            'PUBLISHED', 'NEW', '{}',
            crypto.createHash('sha256').update(`new-${k}`).digest('hex'),
            new Date(baseTs + (k + 1) * 1000).toISOString(),
          ]
        );
      }

      // 2. An offer in Page 2 is expired
      await poolAdapter.query(
        `UPDATE offers SET valid_to = '2024-01-01', updated_at = NOW() WHERE unique_id = 'page-test-15'`
      );

      // Step C: Client requests Page 2 (offset: 10, limit: 10)
      const page2 = await offerRepo.findPublishedOffers({ limit: 10, offset: 10 });
      expect(page2.items.length).toBe(10);

      let duplicateCaught = 0;
      for (const item of page2.items) {
        if (clientSeenIds.has(item.id)) {
          duplicateCaught++;
        } else {
          clientSeenIds.add(item.id);
          clientReceivedOffers.push(item.id);
        }
      }

      // Because 2 new items shifted the list down by 2 rows, offset 10 contains 2 items
      // that were already at the bottom of Page 1. Client-side deduplication caught both!
      expect(duplicateCaught).toBe(2);

      // Consumer feed maintains 100% unique items (zero duplicate cards)
      expect(new Set(clientReceivedOffers).size).toBe(clientReceivedOffers.length);

      // Expired item (page-test-15) is completely absent
      expect(clientReceivedOffers.some((id) => id.includes('page-test-15'))).toBe(false);

      // Step D: Lightweight Reconciliation / Refresh Verification
      // When user pulls to refresh or changes tab, offset resets to 0:
      const refreshPage = await offerRepo.findPublishedOffers({ limit: 20, offset: 0 });
      expect(refreshPage.items.length).toBe(20);
      // The newest inserted offers appear immediately at the top
      expect(refreshPage.items[0].unique_id).toBe('concurrent-insert-1');
      expect(refreshPage.items[1].unique_id).toBe('concurrent-insert-0');
    });
  });

  describe('Task 3: Physical Branch Map Eligibility', () => {
    it('does NOT categorically suppress verified branches solely because promotion has NATIONWIDE coverage', () => {
      // Promotion has NATIONWIDE scope, but explicitly lists participating branches
      const nationwideBranches = BranchParticipationService.extractParticipatingBranches({
        merchantName: 'Cargills Food City',
        title: '20% Off Islandwide Promotion',
        description: 'Valid at the following participating branches: 1. Kollupitiya (Galle Road, Colombo 03), 2. Kandy City Centre (Dalada Veediya)',
        locationScope: LocationScope.NATIONWIDE,
      });

      expect(nationwideBranches.length).toBe(2);
      expect(nationwideBranches[0].participationStatus).toBe('SOURCE_VERIFIED');

      // Verify Premise Coordinates for Kollupitiya branch under NATIONWIDE promotion scope
      const verifiedPremise = GeocodingVerifier.verifyResult(
        {
          searchAddress: 'Galle Road, Colombo 03',
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
          latitude: 6.9080,
          longitude: 79.8510,
          formattedAddress: 'Cargills Food City, Galle Road, Colombo 00300, Sri Lanka',
          success: true,
          types: ['establishment', 'grocery_or_supermarket', 'store'],
        },
        'Galle Road, Colombo 03',
        'EXACT_ADDRESS',
        LocationScope.NATIONWIDE // NATIONWIDE scope!
      );

      // PROVED: Verified branches under NATIONWIDE are NOT suppressed!
      expect(verifiedPremise.isVerifiedExactPin).toBe(true);
      expect(verifiedPremise.granularity).toBe('EXACT_PREMISE');
      expect(verifiedPremise.confidenceScore).toBeGreaterThanOrEqual(0.7);
    });

    it('keeps uncertain street-level results OUT of exact-premises pins', () => {
      // Query resolved to a street/road (types: ['route']), not an establishment or premise
      const streetLevelResult = GeocodingVerifier.verifyResult(
        {
          searchAddress: 'Kandy Road, Kiribathgoda',
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
          latitude: 6.9780,
          longitude: 79.9280,
          formattedAddress: 'Kandy Road, Kiribathgoda, Sri Lanka',
          success: true,
          types: ['route'], // Street level only!
        },
        'Kandy Road, Kiribathgoda',
        'EXACT_ADDRESS',
        LocationScope.SELECTED_OUTLETS
      );

      // PROVED: Uncertain street-level results receive isVerifiedExactPin = false
      expect(streetLevelResult.isVerifiedExactPin).toBe(false);
      expect(streetLevelResult.granularity).toBe('STREET_LEVEL');
      expect(streetLevelResult.rejectionReason).toContain('Uncertain street-level result only');
    });

    it('rejects country centroids and generic area centroids', () => {
      // Country centroid
      const countryResult = GeocodingVerifier.verifyResult(
        {
          searchAddress: 'All Island Outlets',
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
          latitude: 7.8731,
          longitude: 80.7718,
          formattedAddress: 'Sri Lanka',
          success: true,
          types: ['country', 'political'],
        },
        'All Island Outlets',
        'AREA_ONLY',
        LocationScope.NATIONWIDE
      );
      expect(countryResult.isVerifiedExactPin).toBe(false);
      expect(countryResult.granularity).toBe('COUNTRY_CENTROID');

      // Locality centroid
      const localityResult = GeocodingVerifier.verifyResult(
        {
          searchAddress: 'Galle Outlets',
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
          latitude: 6.0535,
          longitude: 80.2210,
          formattedAddress: 'Galle, Sri Lanka',
          success: true,
          types: ['locality', 'political'],
        },
        'Galle Outlets',
        'AREA_ONLY',
        LocationScope.SELECTED_OUTLETS
      );
      expect(localityResult.isVerifiedExactPin).toBe(false);
      expect(localityResult.granularity).toBe('AREA_CENTROID');
    });
  });
});
