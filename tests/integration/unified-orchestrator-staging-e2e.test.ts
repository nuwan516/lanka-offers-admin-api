import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { parseHNBDetail } from '../../src/banks/hnb/hnb-parser';
import { PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { ValidationPipeline } from '../../src/parsing/validators/validation-pipeline';
import { UnifiedOfferOrchestrator } from '../../src/parsing/validators/unified-offer-orchestrator';
import { computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';
import {
  createScrapeRun,
  upsertOffer,
  completeScrapeRun,
  type FencingToken,
} from '../../src/infrastructure/db/offer-repository';
import {
  transitionOffer,
  syncApprovedOffer,
  getOfferWorkflow,
  saveManualCorrection,
} from '../../src/infrastructure/db/offer-workflow-repository';
import { buildOfferListQuery } from '../../src/api/offer-query-scope';

let harness: RealPostgresHarness;
let poolAdapter: ReturnType<RealPostgresHarness['getPoolAdapter']>;

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
        const res = await fn(client);
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    closePool: async () => {},
  };
});

describe('E2E Staging & Review: Unified Offer Ingestion with Isolated Database', () => {
  beforeAll(async () => {
    harness = new RealPostgresHarness();
    poolAdapter = harness.getPoolAdapter();
    await harness.initSchema();
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('demonstrates the full 10-step staging, validation, candidate protection, and review path', async () => {
    const bank = 'hnb';
    const leaseToken: FencingToken = { bank, jobId: 'worker-orchestrator-1', leaseGeneration: 1 };

    // Set up active lease in DB
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-orch', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // 1. Scrape raw source fixture
    const rawPromo = {
      id: 'hnb-spa-901',
      title: '25% off at Spa Ceylon with HNB Credit Cards',
      from: '2026-06-01',
      to: '2026-12-31',
      cardType: 'credit',
      content: `<p>Merchant: Spa Ceylon</p>
<p>Get 25% discount on all wellness treatments with HNB Mastercard and Visa Credit Cards.</p>
<p>Minimum spend Rs. 5,000. Maximum discount Rs. 2,500.</p>
<p>Locations: Colombo 03, Kandy, Galle Fort</p>`,
    };

    const offer = parseHNBDetail('spa-901', rawPromo, 'Wellness', 1)!;
    offer.verifiedImage = {
      sourceUrl: 'https://www.hnb.net/images/promotions/spa-ceylon.png',
      storageKey: `${'a'.repeat(64)}.png`,
      contentHash: 'a'.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 1200,
      height: 675,
      verifiedAt: '2026-11-05T00:00:00.000Z',
    };
    offer.imageVerificationStatus = 'VERIFIED';
    offer.contentHash = computeOfferContentHash(offer);

    // 2. Run through production ValidationPipeline with UnifiedOfferOrchestrator
    const pipeline = new ValidationPipeline();
    const report = await pipeline.validateOffer(offer, { rawText: rawPromo.content, sourceUrl: offer.sourceUrl });

    // Verify unified validation report is generated
    expect(report.unifiedValidation).toBeDefined();
    expect(report.unifiedValidation!.qualityGate.criticalFieldsSupported).toBe(true);

    // 3. Staging: Insert newly scraped offer into isolated PostgreSQL
    const runId = await createScrapeRun(bank, 'full', 'production-audit', leaseToken);
    const upsertRes = await upsertOffer(
      offer,
      runId,
      {
        lifecycleStatus: report.unifiedValidation!.qualityGate.status === 'VALIDATED' ? 'APPROVED' : 'REVIEW_REQUIRED',
      },
      leaseToken
    );

    expect(upsertRes.isNew).toBe(true);
    expect(upsertRes.id).toBeDefined();

    // 4. Admin Operator: Publish initial approved offer
    const syncRes = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(syncRes.outcome).toBe('published');

    // Verify offer is now published and visible to public API
    const pubCheck = await poolAdapter.query(
      `SELECT db_status, title, merchant_name, image_storage_key, image_url FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(pubCheck.rows[0].db_status).toBe('PUBLISHED');
    expect(pubCheck.rows[0].image_storage_key).toBe(`${'a'.repeat(64)}.png`);
    expect(pubCheck.rows[0].image_url).toBe(`/api/images/${'a'.repeat(64)}.png`);

    const publicQuery = buildOfferListQuery({ bank });
    const publicResults = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(publicResults.rows.some((r: any) => r.id === upsertRes.id)).toBe(true);

    // A newly verified image is independently versioned. Even with identical
    // business content it is staged and cannot replace the live image until
    // the candidate is approved and synchronized.
    const imageOnlyUpdate = {
      ...offer,
      verifiedImage: {
        ...offer.verifiedImage!,
        sourceUrl: 'https://www.hnb.net/images/promotions/spa-ceylon-v2.png',
        storageKey: `${'b'.repeat(64)}.png`,
        contentHash: 'b'.repeat(64),
      },
    };
    const imageOnlyResult = await upsertOffer(
      imageOnlyUpdate,
      runId,
      { lifecycleStatus: 'REVIEW_REQUIRED' },
      leaseToken
    );
    expect(imageOnlyResult.status).toBe('CHANGED');
    expect(imageOnlyResult.staged).toBe(true);
    const stagedImage = await poolAdapter.query(
      `SELECT image_storage_key, pending_candidate FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(stagedImage.rows[0].image_storage_key).toBe(`${'a'.repeat(64)}.png`);
    expect(stagedImage.rows[0].pending_candidate.verifiedImage.storageKey).toBe(`${'b'.repeat(64)}.png`);
    await transitionOffer(upsertRes.id, 'APPROVE', 'senior-editor', 'Verified replacement image');
    expect((await syncApprovedOffer(upsertRes.id, leaseToken)).outcome).toBe('published');
    const replacedImage = await poolAdapter.query(`SELECT image_storage_key FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(replacedImage.rows[0].image_storage_key).toBe(`${'b'.repeat(64)}.png`);

    // 5. Operator applies a sacred manual override
    await saveManualCorrection(
      upsertRes.id,
      { 'merchant.name': 'Spa Ceylon Luxury Ayurveda' },
      'senior-editor',
      'Branding correction to full trademark'
    );

    // 6. Bank updates promotion on their website (Discount changes to 30%, raw promo title changes)
    const updatedRawPromo = {
      ...rawPromo,
      title: '30% off at Spa Ceylon with HNB Credit Cards',
      content: `<p>Merchant: Spa Ceylon</p>
<p>Get 30% discount on all wellness treatments with HNB Mastercard and Visa Credit Cards.</p>
<p>Minimum spend Rs. 5,000. Maximum discount Rs. 3,000.</p>
<p>Locations: Colombo 03, Kandy, Galle Fort</p>`,
    };
    const updatedOffer = parseHNBDetail('spa-901', updatedRawPromo, 'Wellness', 1)!;
    updatedOffer.contentHash = computeOfferContentHash(updatedOffer);

    // Re-validate candidate through unified orchestrator
    const updateReport = await pipeline.validateOffer(updatedOffer, { rawText: updatedRawPromo.content, sourceUrl: updatedOffer.sourceUrl });
    expect(updateReport.unifiedValidation).toBeDefined();

    // 7. Scraper attempts to upsert the updated offer
    const updateUpsertRes = await upsertOffer(
      updatedOffer,
      runId,
      {
        lifecycleStatus: 'REVIEW_REQUIRED',
      },
      leaseToken
    );

    // CRITICAL INVARIANT: Published offer record remains unchanged; candidate goes to pending_candidate!
    expect(updateUpsertRes.status).toBe('CHANGED');
    expect(updateUpsertRes.staged).toBe(true);

    const liveRecord = await poolAdapter.query(
      `SELECT db_status, title, merchant_name, manual_override, pending_candidate,
              pending_change_status, image_storage_key, image_url
       FROM offers WHERE id = $1`,
      [upsertRes.id]
    );

    // Live public title remains the original 25% until approval!
    expect(liveRecord.rows[0].db_status).toBe('PUBLISHED');
    expect(liveRecord.rows[0].title).toContain('25%');

    // Sacred manual override is preserved!
    expect(liveRecord.rows[0].manual_override['merchant.name']).toBe('Spa Ceylon Luxury Ayurveda');

    // Candidate update is safely sequestered in pending_candidate
    expect(liveRecord.rows[0].pending_change_status).toBe('CHANGED');
    expect(liveRecord.rows[0].pending_candidate.title).toContain('30%');
    expect(liveRecord.rows[0].pending_candidate.verifiedImage).toBeUndefined();
    expect(liveRecord.rows[0].image_storage_key).toBe(`${'b'.repeat(64)}.png`);

    // Approval of a candidate whose image refresh failed must preserve the last
    // known-good published image instead of replacing it with a broken URL.
    await transitionOffer(upsertRes.id, 'APPROVE', 'senior-editor', 'Verified textual update');
    const updateSync = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(updateSync.outcome).toBe('published');
    const afterImageRefreshFailure = await poolAdapter.query(
      `SELECT title, image_storage_key, image_url, pending_candidate FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(afterImageRefreshFailure.rows[0].title).toContain('30%');
    expect(afterImageRefreshFailure.rows[0].image_storage_key).toBe(`${'b'.repeat(64)}.png`);
    expect(afterImageRefreshFailure.rows[0].image_url).toBe(`/api/images/${'b'.repeat(64)}.png`);
    expect(afterImageRefreshFailure.rows[0].pending_candidate).toBeNull();

    // Taking the offer offline hides it without destroying its approved image
    // association; republishing restores the same content-addressed asset.
    await transitionOffer(upsertRes.id, 'UNPUBLISH', 'senior-editor', 'Rollback rehearsal');
    const hiddenDuringRollback = await poolAdapter.query(
      `SELECT * FROM offers ${publicQuery.whereSql}`,
      publicQuery.params
    );
    expect(hiddenDuringRollback.rows.some((row: any) => row.id === upsertRes.id)).toBe(false);
    const offlineImage = await poolAdapter.query(`SELECT image_storage_key FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(offlineImage.rows[0].image_storage_key).toBe(`${'b'.repeat(64)}.png`);
    await transitionOffer(upsertRes.id, 'APPROVE', 'senior-editor', 'Rollback image rechecked');
    await transitionOffer(upsertRes.id, 'PUBLISH', 'senior-editor', 'Rollback rehearsal complete', undefined, undefined, leaseToken);
    const republishedImage = await poolAdapter.query(
      `SELECT db_status, image_storage_key FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(republishedImage.rows[0]).toMatchObject({
      db_status: 'PUBLISHED',
      image_storage_key: `${'b'.repeat(64)}.png`,
    });

    // 8. Rejected offer check: If an invalid offer is scraped, it must be rejected
    const invalidPromo = {
      id: 'hnb-bad-999',
      title: 'Broken Offer',
      from: '2026-12-31',
      to: '2026-01-01',
      cardType: 'credit',
      content: 'Invalid',
    };
    const invalidOffer = parseHNBDetail('bad-999', invalidPromo, 'Scam', 1)!;
    invalidOffer.validityPeriods = [
      {
        validFrom: '2026-12-31',
        validTo: '2026-01-01',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'invalid dates',
      },
    ];
    const invalidReport = await pipeline.validateOffer(invalidOffer);
    expect(invalidReport.passed).toBe(false);

    const invalidUpsert = await upsertOffer(
      invalidOffer,
      runId,
      { lifecycleStatus: 'REJECTED' },
      leaseToken
    );
    expect(invalidUpsert.isNew).toBe(true);

    // 9. Rejected offer must NEVER appear in public API query
    const publicAfterReject = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(publicAfterReject.rows.some((r: any) => r.id === invalidUpsert.id)).toBe(false);

    // 10. Complete scrape run cleanly
    await completeScrapeRun(runId, { found: 2, newCount: 2, changed: 0, unchanged: 0, errors: 0 }, leaseToken);
  });
});
