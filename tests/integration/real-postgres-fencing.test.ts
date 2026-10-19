import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import {
  createScrapeRun,
  upsertOffer,
  completeScrapeRun,
  saveValidationReport,
  assertActiveLease,
  FencingViolationError,
  type FencingToken,
} from '../../src/infrastructure/db/offer-repository';
import { syncApprovedOffer, transitionOffer } from '../../src/infrastructure/db/offer-workflow-repository';
import { detectAndRecordDuplicates, flagOfferAsDuplicate } from '../../src/infrastructure/db/duplicate-repository';
import type { Offer } from '../../src/core/types/offers';
import { parseHNBDetail } from '../../src/banks/hnb/hnb-parser';
import { jobManager } from '../../src/api/services/job-manager';

// Mock the global pool to route through our real isolated PostgreSQL instance
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

function makeTestOffer(id: string, bank = 'hnb', title = 'Test Hotel Offer'): Offer {
  const fixture = {
    id,
    title,
    from: '2026-01-01',
    to: '2026-12-31',
    cardType: 'credit',
    content: `<p>Merchant: Heritance Ahungalla</p>
<p>Offer: 25% off on buffet dining</p>
<p>Period: Valid from 01st January 2026 to 31st December 2026</p>
<p>Eligibility: Visa Signature</p>`,
  };
  const parsed = parseHNBDetail(id, fixture, 'Dining', 1)!;
  parsed.source = bank;
  parsed.uniqueId = `${bank}_${id}`;
  parsed.contentHash = `hash-${id}-v1`;
  return parsed;
}

describe('Priority A: Real PostgreSQL Distributed Fencing at Write Boundaries', () => {
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

  it('verifies atomic lease acquisition and rejects two workers claiming the same bank', async () => {
    const bank = 'hnb';
    const worker1 = 'worker-node-1';
    const worker2 = 'worker-node-2';

    // Worker 1 claims lease
    const claim1 = await poolAdapter.query<{ bank: string; job_id: string; lease_generation: string }>(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, $3, 1, NOW(), NOW(), NOW() + interval '5 minutes')
       RETURNING bank, job_id, lease_generation`,
      [bank, worker1, 'inst-1']
    );

    expect(claim1.rows).toHaveLength(1);
    expect(claim1.rows[0].job_id).toBe(worker1);
    expect(String(claim1.rows[0].lease_generation)).toBe('1');

    // Worker 2 attempts to claim the same bank while Worker 1 is active
    const claim2 = await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, $3, 1, NOW(), NOW(), NOW() + interval '5 minutes')
       ON CONFLICT (bank) DO UPDATE
         SET job_id = EXCLUDED.job_id,
             instance_id = EXCLUDED.instance_id,
             lease_generation = scraper_leases.lease_generation + 1,
             acquired_at = NOW(),
             heartbeat_at = NOW(),
             expires_at = EXCLUDED.expires_at,
             released_at = NULL
         WHERE scraper_leases.expires_at < NOW() OR scraper_leases.released_at IS NOT NULL
       RETURNING bank, job_id, lease_generation`,
      [bank, worker2, 'inst-2']
    );

    // Conflict WHERE condition was not satisfied -> 0 rows returned, claim denied
    expect(claim2.rows).toHaveLength(0);
  });

  it('permits lease takeover when prior lease expires, incrementing fencing generation monotonically', async () => {
    const bank = 'sampath';
    const worker1 = 'worker-sampath-1';
    const worker2 = 'worker-sampath-2';

    // Worker 1 acquires lease
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-1', 1, NOW(), NOW(), NOW() + interval '2 minutes')`,
      [bank, worker1]
    );

    // Worker 1 lease expires
    await poolAdapter.query(`UPDATE scraper_leases SET expires_at = NOW() - interval '1 second' WHERE bank = $1`, [bank]);

    // Worker 2 takes over the expired lease
    const takeover = await poolAdapter.query<{ bank: string; job_id: string; lease_generation: string }>(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-2', 1, NOW(), NOW(), NOW() + interval '5 minutes')
       ON CONFLICT (bank) DO UPDATE
         SET job_id = EXCLUDED.job_id,
             instance_id = EXCLUDED.instance_id,
             lease_generation = scraper_leases.lease_generation + 1,
             acquired_at = NOW(),
             heartbeat_at = NOW(),
             expires_at = EXCLUDED.expires_at,
             released_at = NULL
         WHERE scraper_leases.expires_at < NOW() OR scraper_leases.released_at IS NOT NULL
       RETURNING bank, job_id, lease_generation`,
      [bank, worker2]
    );

    expect(takeover.rows).toHaveLength(1);
    expect(takeover.rows[0].job_id).toBe(worker2);
    expect(String(takeover.rows[0].lease_generation)).toBe('2');
  });

  it('rejects stale worker attempting to create a scrape_run', async () => {
    const bank = 'boc';
    // Active lease is currently generation 2 held by worker-2
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, 'worker-2', 'inst-2', 2, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank]
    );

    const staleToken: FencingToken = { bank, jobId: 'worker-1', leaseGeneration: 1 };

    await expect(
      createScrapeRun(bank, 'full', 'cli', staleToken)
    ).rejects.toThrow(FencingViolationError);

    // Verify no scrape_runs row was created
    const count = await poolAdapter.query(`SELECT COUNT(*)::int as c FROM scrape_runs WHERE bank = $1`, [bank]);
    expect(count.rows[0].c).toBe(0);
  });

  it('rejects stale worker attempting upsertOffer and rolls back transaction atomically', async () => {
    const bank = 'seylan';
    // Active lease is generation 2
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, 'worker-2', 'inst-2', 2, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank]
    );

    const staleToken: FencingToken = { bank, jobId: 'worker-1', leaseGeneration: 1 };
    const offer = makeTestOffer('seylan_001', bank);

    await expect(
      upsertOffer(offer, 'fake-run-id', { lifecycleStatus: 'APPROVED' }, staleToken)
    ).rejects.toThrow(FencingViolationError);

    // Verify offers table remains completely empty (atomic rollback)
    const check = await poolAdapter.query(`SELECT COUNT(*)::int as c FROM offers WHERE bank = $1`, [bank]);
    expect(check.rows[0].c).toBe(0);
  });

  it('prevents stale worker from modifying a PUBLISHED offer candidate staging queue', async () => {
    const bank = 'ndb';
    // Pre-seed an existing PUBLISHED offer in real Postgres
    const initialOffer = makeTestOffer('ndb_001', bank, 'Original Published Title');
    const validTokenGen1: FencingToken = { bank, jobId: 'worker-1', leaseGeneration: 1 };

    // Establish Gen 1 lease
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-1', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, 'worker-1']
    );

    // Create scrape run with Gen 1 lease
    const runId1 = await createScrapeRun(bank, 'full', 'cli', validTokenGen1);

    // Insert and publish initial offer
    const upsertRes = await upsertOffer(initialOffer, runId1, { lifecycleStatus: 'APPROVED' }, validTokenGen1);
    await syncApprovedOffer(upsertRes.id, validTokenGen1);

    // Verify it is PUBLISHED
    const pubCheck = await poolAdapter.query<{ db_status: string; title: string }>(
      `SELECT db_status, title FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(pubCheck.rows[0].db_status).toBe('PUBLISHED');
    expect(pubCheck.rows[0].title).toBe('Original Published Title');

    // Now, lease is taken over by Worker 2 (Generation 2)
    await poolAdapter.query(
      `UPDATE scraper_leases SET job_id = 'worker-2', lease_generation = 2 WHERE bank = $1`,
      [bank]
    );

    // Stale Worker 1 attempts to stage an updated candidate on the published offer
    const modifiedOffer: Offer = {
      ...initialOffer,
      title: 'Stale Worker Rogue Update Title',
      contentHash: 'hash-ndb-001-v2',
    };

    await expect(
      upsertOffer(modifiedOffer, runId1, { lifecycleStatus: 'APPROVED' }, validTokenGen1)
    ).rejects.toThrow(FencingViolationError);

    // Verify published offer title is completely untouched and pending_candidate is NULL
    const postCheck = await poolAdapter.query<{ db_status: string; title: string; pending_candidate: unknown }>(
      `SELECT db_status, title, pending_candidate FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(postCheck.rows[0].title).toBe('Original Published Title');
    expect(postCheck.rows[0].pending_candidate).toBeNull();
  });

  it('prevents an expired or stale lease holder from publishing candidates', async () => {
    const bank = 'dfcc';
    const offer = makeTestOffer('dfcc_001', bank);

    // Seed approved offer
    const validTokenGen1: FencingToken = { bank, jobId: 'worker-1', leaseGeneration: 1 };
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, 'worker-1', 'inst-1', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank]
    );

    const runId1 = await createScrapeRun(bank, 'full', 'cli', validTokenGen1);
    const inserted = await upsertOffer(offer, runId1, { lifecycleStatus: 'APPROVED' }, validTokenGen1);

    // Lease expires or superseded by worker 2
    await poolAdapter.query(
      `UPDATE scraper_leases SET job_id = 'worker-2', lease_generation = 2 WHERE bank = $1`,
      [bank]
    );

    // Worker 1 attempts to publish with stale generation
    await expect(
      syncApprovedOffer(inserted.id, validTokenGen1)
    ).rejects.toThrow(FencingViolationError);

    // Verify row status was NOT published
    const check = await poolAdapter.query<{ db_status: string }>(
      `SELECT db_status FROM offers WHERE id = $1`,
      [inserted.id]
    );
    expect(check.rows[0].db_status).toBe('APPROVED');
  });

  it('prevents an old worker from releasing a newer worker lease in PostgreSQL', async () => {
    const bank = 'combank';
    // Worker 2 holds generation 2
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, 'worker-2', 'inst-2', 2, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank]
    );

    // Old worker 1 attempts to release with generation 1
    const releaseRes = await poolAdapter.query(
      `UPDATE scraper_leases
       SET released_at = NOW()
       WHERE bank = $1 AND job_id = $2 AND lease_generation = $3 AND released_at IS NULL`,
      [bank, 'worker-1', 1]
    );

    // 0 rows affected
    expect(releaseRes.rowCount).toBe(0);

    // Worker 2's lease remains valid, unreleased, and active!
    const activeLease = await poolAdapter.query<{ job_id: string; lease_generation: string; released_at: string | null }>(
      `SELECT job_id, lease_generation, released_at FROM scraper_leases WHERE bank = $1`,
      [bank]
    );
    expect(activeLease.rows[0].job_id).toBe('worker-2');
    expect(String(activeLease.rows[0].lease_generation)).toBe('2');
    expect(activeLease.rows[0].released_at).toBeNull();
  });

  it('allows active valid lease owner to execute full write lifecycle cleanly', async () => {
    const bank = 'peoples';
    const validToken: FencingToken = { bank, jobId: 'worker-peoples-active', leaseGeneration: 1 };

    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-active', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, validToken.jobId]
    );

    // 1. Create scrape run
    const runId = await createScrapeRun(bank, 'full', 'cli', validToken);
    expect(runId).toBeDefined();

    // 2. Upsert offer
    const offer = makeTestOffer('peoples_001', bank);
    const upsertRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, validToken);
    expect(upsertRes.isNew).toBe(true);

    // 3. Duplicate check with active lease
    const dupRes = await detectAndRecordDuplicates(upsertRes.id, offer, bank, validToken);
    expect(dupRes.flagged).toBe(false);

    // 4. Complete scrape run
    const outcome = await completeScrapeRun(runId, {
      found: 1, newCount: 1, changed: 0, unchanged: 0, errors: 0,
    }, validToken);
    expect(outcome.status).toBe('completed');

    // Verify row counts in PostgreSQL
    const offerRow = await poolAdapter.query<{ title: string; bank: string }>(
      `SELECT title, bank FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(offerRow.rows[0].title).toBe(offer.title);
    expect(offerRow.rows[0].bank).toBe(bank);
  });

  it('verifies JobManager.renewDistributedLease extends valid lease and detects lease loss on generation takeover', async () => {
    const bank = 'pabc';
    const worker1 = 'job-pabc-1';
    const worker2 = 'job-pabc-2';

    // 1. Worker 1 acquires Gen 1
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-1', 1, NOW(), NOW(), NOW() + interval '2 minutes')`,
      [bank, worker1]
    );

    // 2. Worker 1 renews lease heartbeat -> succeeds
    const renewed = await jobManager.renewDistributedLease(bank, worker1, 1, 300000);
    expect(renewed).toBe(true);

    // Verify heartbeat_at updated in real Postgres
    const leaseRow = await poolAdapter.query<{ lease_generation: string; heartbeat_at: string }>(
      `SELECT lease_generation, heartbeat_at FROM scraper_leases WHERE bank = $1`,
      [bank]
    );
    expect(String(leaseRow.rows[0].lease_generation)).toBe('1');
    expect(leaseRow.rows[0].heartbeat_at).toBeDefined();

    // 3. Worker 2 takes over lease (Gen 2)
    await poolAdapter.query(
      `UPDATE scraper_leases SET job_id = $2, lease_generation = 2, expires_at = NOW() + interval '5 minutes' WHERE bank = $1`,
      [bank, worker2]
    );

    // 4. Stale Worker 1 attempts heartbeat renewal -> fails closed (returns false)
    const staleRenew = await jobManager.renewDistributedLease(bank, worker1, 1, 300000);
    expect(staleRenew).toBe(false);
  });

  it('verifies JobManager.releaseDistributedLease is ownership-specific and does not release superseded leases', async () => {
    const bank = 'nsb';
    const worker1 = 'job-nsb-1';
    const worker2 = 'job-nsb-2';

    // Worker 2 holds Gen 2
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-2', 2, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, worker2]
    );

    // Stale Worker 1 attempts to release Gen 1
    await jobManager.releaseDistributedLease(bank, worker1, 1);

    // Verify Worker 2 lease is still active and unreleased
    const check1 = await poolAdapter.query<{ job_id: string; lease_generation: string; released_at: string | null }>(
      `SELECT job_id, lease_generation, released_at FROM scraper_leases WHERE bank = $1`,
      [bank]
    );
    expect(check1.rows[0].job_id).toBe(worker2);
    expect(String(check1.rows[0].lease_generation)).toBe('2');
    expect(check1.rows[0].released_at).toBeNull();

    // Active Worker 2 releases Gen 2
    await jobManager.releaseDistributedLease(bank, worker2, 2);

    // Verify Worker 2 lease is now released
    const check2 = await poolAdapter.query<{ released_at: string | null }>(
      `SELECT released_at FROM scraper_leases WHERE bank = $1`,
      [bank]
    );
    expect(check2.rows[0].released_at).not.toBeNull();
  });
});
