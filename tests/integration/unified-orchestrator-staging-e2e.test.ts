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
    const pubCheck = await poolAdapter.query(`SELECT db_status, title, merchant_name FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(pubCheck.rows[0].db_status).toBe('PUBLISHED');

    const publicQuery = buildOfferListQuery({ bank });
    const publicResults = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(publicResults.rows.some((r: any) => r.id === upsertRes.id)).toBe(true);

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
      `SELECT db_status, title, merchant_name, manual_override, pending_candidate, pending_change_status FROM offers WHERE id = $1`,
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
