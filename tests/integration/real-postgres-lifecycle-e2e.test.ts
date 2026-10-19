import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { parseHNBDetail } from '../../src/banks/hnb/hnb-parser';
import { parseComBankOffer, ComBankRawOffer } from '../../src/banks/combank/combank-parser';
import { OfferValidator } from '../../src/parsing/validators/offer-validator';
import { computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';
import { decideOfferQuality } from '../../src/domain/offer-quality-decision';
import { resolveCanonicalMerchant } from '../../src/domain/merchant-canonicalizer';
import { determineLocationScope } from '../../src/domain/location-scope';
import {
  createScrapeRun,
  upsertOffer,
  completeScrapeRun,
  failScrapeRun,
  type FencingToken,
  FencingViolationError,
} from '../../src/infrastructure/db/offer-repository';
import {
  transitionOffer,
  syncApprovedOffer,
  getOfferWorkflow,
  saveManualCorrection,
} from '../../src/infrastructure/db/offer-workflow-repository';
import {
  detectAndRecordDuplicates,
  flagOfferAsDuplicate,
} from '../../src/infrastructure/db/duplicate-repository';
import { buildOfferListQuery, sanitizePublicOffer } from '../../src/api/offer-query-scope';

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

describe('Priority C: Full End-to-End Offer Ingestion & Publication Lifecycle', () => {
  const validator = new OfferValidator();

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

  it('executes full happy path from source fixture to public consumer API response', async () => {
    const bank = 'hnb';
    const leaseToken: FencingToken = { bank, jobId: 'worker-lifecycle-1', leaseGeneration: 1 };

    // 1. Establish lease in PostgreSQL
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-life', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // 2. Raw Source Fixture
    const sourceFixture = {
      id: 'hnb-jetwing-101',
      title: 'Get 30% Off at Jetwing Hotels with HNB Cards',
      from: '2026-01-01',
      to: '2026-12-31',
      cardType: 'credit',
      content: `<p>Merchant: Jetwing Hotels</p>
<p>Offer: 30% off on room bookings</p>
<p>Period: Valid from 01st January 2026 to 31st December 2026</p>
<p>Eligibility: HNB Visa Signature & Infinite Credit Cards</p>
<p>Locations: Colombo, Galle, Negombo</p>`,
    };

    // 3. Bank Parser
    const parsedOffer = parseHNBDetail('jetwing-101', sourceFixture, 'Travel', 1);
    expect(parsedOffer).not.toBeNull();
    const offer = parsedOffer!;
    offer.source = bank;
    offer.uniqueId = `${bank}_jetwing_101`;

    // 4. Normalization & Content Hashing
    offer.contentHash = computeOfferContentHash(offer);
    expect(offer.contentHash).toHaveLength(64);

    // 5. Merchant & Location Resolution
    // 5. Merchant & Location Resolution
    const canonicalMerchant = resolveCanonicalMerchant(offer.merchant?.name ?? offer.title);
    const scope = determineLocationScope({
      location: offer.merchant?.location,
      title: offer.title,
      merchantName: offer.merchant?.name,
    });
    expect(scope).toBeDefined();

    // 6. Deterministic Validation
    const validation = validator.validate(offer);
    expect(validation.valid).toBe(true);

    // 7. Quality Gate Decision
    const quality = decideOfferQuality({
      ruleValid: validation.valid,
      ruleErrorCount: validation.errors.length,
      ruleWarningCount: validation.warnings.length,
      llmScore: null,
      llmValid: null,
      llmStatus: null,
    });
    expect(['AUTO_APPROVE', 'REVIEW_REQUIRED']).toContain(quality);

    // 8. Database Staging
    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);
    const lifecycleStatus = quality === 'AUTO_APPROVE' ? 'APPROVED' : 'REVIEW_REQUIRED';
    const upsertRes = await upsertOffer(offer, runId, { lifecycleStatus }, leaseToken);
    expect(upsertRes.isNew).toBe(true);
    expect(upsertRes.staged).toBe(false);

    // 9. Verify Staged Record in PostgreSQL
    const stagedRow = await getOfferWorkflow(upsertRes.id);
    expect(stagedRow).not.toBeNull();
    expect(stagedRow!.db_status).toBe(lifecycleStatus);

    // 10. Simulated Human Approval (if REVIEW_REQUIRED) & Transactional Publishing
    if (stagedRow!.db_status === 'REVIEW_REQUIRED') {
      await transitionOffer(upsertRes.id, 'APPROVE', 'lead-reviewer', 'Approved after review');
    }
    const publishRes = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(publishRes.outcome).toBe('published');

    // 11. Complete Scrape Run
    await completeScrapeRun(runId, {
      found: 1, newCount: 1, changed: 0, unchanged: 0, errors: 0,
    }, leaseToken);

    // 12. Public API Query Scope Execution
    const publicQuery = buildOfferListQuery({ bank });
    const publicRows = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(publicRows.rows).toHaveLength(1);

    // 13. Verified Consumer Response Projection
    const consumerOffer = sanitizePublicOffer(publicRows.rows[0]);
    expect(consumerOffer.id).toBe(upsertRes.id);
    expect(consumerOffer.title).toBe(offer.title);
    expect(consumerOffer.db_status).toBe('PUBLISHED');
    expect((consumerOffer as any).manual_override).toBeUndefined();
    expect((consumerOffer as any).pending_candidate).toBeUndefined();
  });

  it('handles unchanged offer with zero redundant database writes', async () => {
    const bank = 'hnb';
    const leaseToken: FencingToken = { bank, jobId: 'worker-unchanged', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-unchanged', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    const fixture = {
      id: 'hnb-keells-1',
      title: '20% off at Keells Super on fresh produce',
      from: '2026-01-01',
      to: '2026-12-31',
      cardType: 'credit',
      content: `<p>Merchant: Keells</p><p>Offer: 20% off</p><p>Period: Valid till 31 Dec 2026</p>`,
    };
    const offer = parseHNBDetail('keells-1', fixture, 'Supermarket', 1)!;
    offer.source = bank;
    offer.uniqueId = 'hnb_keells_1';
    offer.contentHash = computeOfferContentHash(offer);

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // First scrape: creates record
    const firstRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);
    expect(firstRes.isNew).toBe(true);

    // Second scrape: same content hash
    const secondRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);
    expect(secondRes.isUnchanged).toBe(true);
    expect(secondRes.isChanged).toBe(false);
    expect(secondRes.isNew).toBe(false);
  });

  it('stages candidate for published offer preserving manual overrides and live public values', async () => {
    const bank = 'combank';
    const leaseToken: FencingToken = { bank, jobId: 'worker-staging', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-staging', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    const fixture: ComBankRawOffer = {
      listing: {
        title: 'Original Cinnamon Offer',
        categoryLabel: 'Dining',
        discountText: '15% Off',
        discountPercentage: 15,
        isUpTo: false,
        validityRaw: 'Valid until 31st December 2026',
        imageUrl: null,
        detailUrl: 'https://combank.lk/promo-1',
        _categoryId: 1,
      },
      detail: null,
    };

    const offer = parseComBankOffer(fixture)!;
    offer.source = bank;
    offer.uniqueId = 'combank_cinnamon_1';
    offer.contentHash = computeOfferContentHash(offer);

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Initial publish
    const res1 = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);
    await syncApprovedOffer(res1.id, leaseToken);

    // Human operator applies a manual override via saveManualCorrection
    await saveManualCorrection(
      res1.id,
      { title: 'Curated Premium: 15% Off at Cinnamon Grand' },
      'lead-curator',
      'Applied verified brand name'
    );

    // Subsequent scrape arrives with new content (discount changed from 15 to 20)
    const updatedOffer = { ...offer };
    updatedOffer.offer = { ...offer.offer, discountPercentage: 20 };
    updatedOffer.contentHash = 'new-hash-v2';

    // Upsert into published row: must NOT clobber live row; must stage candidate
    const updateRes = await upsertOffer(updatedOffer, runId, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken);
    expect(updateRes.staged).toBe(true);
    expect(updateRes.isChanged).toBe(true);

    // Verify in real Postgres: live title and db_status remain PUBLISHED; candidate is staged
    const row = await getOfferWorkflow(res1.id);
    expect(row!.db_status).toBe('PUBLISHED');
    expect(row!.pending_candidate).not.toBeNull();
    expect(row!.manual_override.title).toBe('Curated Premium: 15% Off at Cinnamon Grand');

    // Verify public API returns the currently published offer, NOT the unreviewed candidate
    const publicQuery = buildOfferListQuery({ bank });
    const publicData = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(publicData.rows).toHaveLength(1);
    expect(publicData.rows[0].discount_percentage).toBe('15'); // 15% remains public until approval
  });

  it('excludes expired offers from public API queries', async () => {
    const bank = 'sampath';
    const leaseToken: FencingToken = { bank, jobId: 'worker-exp', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-exp', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // Seed an expired offer directly in PostgreSQL
    await poolAdapter.query(
      `INSERT INTO offers (unique_id, bank, title, valid_from, valid_to, db_status, raw_offer)
       VALUES ('sampath_exp_1', $1, 'Expired New Year Offer', '2025-01-01', '2025-01-10', 'PUBLISHED', '{}')`,
      [bank]
    );

    // Public API query must filter it out via (valid_to IS NULL OR valid_to >= CURRENT_DATE)
    const publicQuery = buildOfferListQuery({ bank });
    const result = await poolAdapter.query(`SELECT * FROM offers ${publicQuery.whereSql}`, publicQuery.params);
    expect(result.rows).toHaveLength(0);
  });

  it('detects duplicate offers and routes to REVIEW_REQUIRED', async () => {
    const bank = 'hnb';
    const leaseToken: FencingToken = { bank, jobId: 'worker-dup', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-dup', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    const fixture = {
      id: 'hnb-dup-1',
      title: '25% off on buffet at Shangri-La Colombo',
      from: '2026-01-01',
      to: '2026-12-31',
      cardType: 'credit',
      content: `<p>Merchant: Shangri-La Colombo</p><p>Offer: 25% off dining</p>`,
    };
    const offer1 = parseHNBDetail('dup-1', fixture, 'Dining', 1)!;
    offer1.source = bank;
    offer1.uniqueId = 'hnb_shangri_1';

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);
    const res1 = await upsertOffer(offer1, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);

    // Second offer with near-identical title & same merchant
    const offer2 = {
      ...offer1,
      uniqueId: 'hnb_shangri_2',
      title: 'Shangri-La Colombo: 25% discount on buffet',
      contentHash: 'hash-dup-2',
    };

    const res2 = await upsertOffer(offer2, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);

    // Run duplicate detection against PostgreSQL
    const dupResult = await detectAndRecordDuplicates(res2.id, offer2, bank, leaseToken);
    if (dupResult.flagged) {
      await flagOfferAsDuplicate(res2.id, res2.staged, 'system', leaseToken);
    }

    // Verify offer 2 is flagged as DUPLICATE and routed to REVIEW_REQUIRED
    const check = await getOfferWorkflow(res2.id);
    expect(check!.db_status).toBe('REVIEW_REQUIRED');
    expect(check!.change_status).toBe('DUPLICATE');
  });

  it('rejects publication when deterministic validation fails (interrupted publish invariant)', async () => {
    const bank = 'boc';
    const leaseToken: FencingToken = { bank, jobId: 'worker-invalid', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-invalid', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // Offer has invalid inverted validity dates
    const offer = parseHNBDetail('boc-inv-1', {
      id: 'boc-1',
      title: 'Promo with inverted dates',
      from: '2026-12-31',
      to: '2026-01-01',
      cardType: 'credit',
      content: `<p>Offer details</p>`,
    }, 'Dining', 1)!;

    offer.source = bank;
    offer.uniqueId = 'boc_inv_1';
    offer.validityPeriods = [
      {
        ...offer.validityPeriods[0],
        validFrom: '2026-12-31',
        validTo: '2026-01-01',
      },
    ];

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);
    const res = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken);

    // Publishing re-validates the candidate deterministically — must fail and reject
    const syncRes = await syncApprovedOffer(res.id, leaseToken);
    expect(syncRes.outcome).toBe('failed');
    expect(syncRes.reason).toBe('final validation failed');

    // Verify db_status remains APPROVED (not published)
    const check = await getOfferWorkflow(res.id);
    expect(check!.db_status).toBe('APPROVED');
  });

  it('safely handles temporarily unavailable source via failScrapeRun without corrupting existing offers', async () => {
    const bank = 'peoples';
    const leaseToken: FencingToken = { bank, jobId: 'worker-down', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-down', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // Pre-existing published offer
    await poolAdapter.query(
      `INSERT INTO offers (unique_id, bank, title, db_status, raw_offer)
       VALUES ('peoples_active_1', $1, 'Active Community Promo', 'PUBLISHED', '{}')`,
      [bank]
    );

    // Scrape job starts
    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Scrape encounters upstream bank outage
    await failScrapeRun(runId, 'ETIMEDOUT: Connection refused by upstream bank gateway', leaseToken);

    // Verify scrape_runs status is 'failed' with failure classification
    const runCheck = await poolAdapter.query<{ status: string; failure_classification: string }>(
      `SELECT status, failure_classification FROM scrape_runs WHERE id = $1`,
      [runId]
    );
    expect(runCheck.rows[0].status).toBe('failed');
    expect(runCheck.rows[0].failure_classification).toBe('TIMEOUT');

    // Verify existing published offer remains untouched and published
    const offerCheck = await poolAdapter.query<{ db_status: string }>(
      `SELECT db_status FROM offers WHERE unique_id = 'peoples_active_1'`
    );
    expect(offerCheck.rows[0].db_status).toBe('PUBLISHED');
  });
});
