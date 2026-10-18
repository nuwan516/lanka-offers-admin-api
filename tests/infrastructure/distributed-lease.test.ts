/**
 * Distributed Scraper Leases & Fencing Token Lifecycle Tests (Batch A)
 *
 * Verifies:
 * - Atomic lease acquisition across distributed workers.
 * - Monotonically increasing fencing generation tokens.
 * - Heartbeat renewal extending expiration.
 * - Stale worker write rejection (fencing token check).
 * - Old owner cannot release a newer owner's lease.
 * - Expired leases are safely reclaimable by newer workers.
 */

interface MockLeaseRow {
  bank: string;
  job_id: string;
  instance_id: string;
  lease_generation: number;
  acquired_at: Date;
  heartbeat_at: Date;
  expires_at: Date;
  released_at: Date | null;
}

const leaseStore = new Map<string, MockLeaseRow>();

const mockPool = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // 1. Acquire Lease: INSERT INTO scraper_leases ... ON CONFLICT (bank) DO UPDATE ...
    if (s.includes('INSERT INTO scraper_leases')) {
      const [bank, jobId, instanceId, timeoutMs] = params as [string, string, string, number];
      const now = new Date();
      const existing = leaseStore.get(bank);

      if (!existing) {
        const newRow: MockLeaseRow = {
          bank,
          job_id: jobId,
          instance_id: instanceId,
          lease_generation: 1,
          acquired_at: now,
          heartbeat_at: now,
          expires_at: new Date(now.getTime() + timeoutMs),
          released_at: null,
        };
        leaseStore.set(bank, newRow);
        return {
          rowCount: 1,
          rows: [{ bank, job_id: jobId, lease_generation: '1' }],
        };
      }

      // Check if existing lease is expired or released
      const isExpired = existing.expires_at.getTime() < now.getTime();
      const isReleased = existing.released_at !== null;

      if (isExpired || isReleased) {
        existing.job_id = jobId;
        existing.instance_id = instanceId;
        existing.lease_generation += 1;
        existing.acquired_at = now;
        existing.heartbeat_at = now;
        existing.expires_at = new Date(now.getTime() + timeoutMs);
        existing.released_at = null;
        return {
          rowCount: 1,
          rows: [{ bank, job_id: jobId, lease_generation: String(existing.lease_generation) }],
        };
      }

      // Active unexpired lease held by another worker!
      return { rowCount: 0, rows: [] };
    }

    // 2. Renew Lease (Heartbeat): UPDATE scraper_leases SET expires_at = ...
    if (s.includes('UPDATE scraper_leases') && s.includes('expires_at = NOW()')) {
      const [bank, jobId, leaseGen, extMs] = params as [string, string, number, number];
      const now = new Date();
      const row = leaseStore.get(bank);

      if (row && row.job_id === jobId && row.lease_generation === leaseGen && row.released_at === null) {
        row.heartbeat_at = now;
        row.expires_at = new Date(now.getTime() + extMs);
        return {
          rowCount: 1,
          rows: [{ lease_generation: String(row.lease_generation) }],
        };
      }
      return { rowCount: 0, rows: [] };
    }

    // 3. Release Lease: UPDATE scraper_leases SET released_at = NOW() WHERE bank = $1 AND job_id = $2 ...
    if (s.includes('UPDATE scraper_leases') && s.includes('released_at = NOW()')) {
      const bank = params[0] as string;
      const jobId = params[1] as string;
      const leaseGen = params[2] as number | undefined;
      const row = leaseStore.get(bank);

      if (row && row.job_id === jobId && row.released_at === null) {
        if (leaseGen === undefined || row.lease_generation === leaseGen) {
          row.released_at = new Date();
          return { rowCount: 1, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    }

    // 4. Lock Check: SELECT job_id, instance_id, expires_at FROM scraper_leases ...
    if (s.includes('SELECT job_id, instance_id, expires_at FROM scraper_leases')) {
      const bank = params[0] as string;
      const now = new Date();
      const row = leaseStore.get(bank);

      if (row && row.released_at === null && row.expires_at.getTime() >= now.getTime()) {
        return {
          rowCount: 1,
          rows: [{ job_id: row.job_id, instance_id: row.instance_id, expires_at: row.expires_at }],
        };
      }
      return { rowCount: 0, rows: [] };
    }

    // 5. Verify Fencing: SELECT lease_generation FROM scraper_leases ...
    if (s.includes('SELECT lease_generation FROM scraper_leases')) {
      const [bank, jobId, leaseGen] = params as [string, string, number];
      const now = new Date();
      const row = leaseStore.get(bank);

      if (
        row &&
        row.job_id === jobId &&
        row.lease_generation === leaseGen &&
        row.released_at === null &&
        row.expires_at.getTime() >= now.getTime()
      ) {
        return {
          rowCount: 1,
          rows: [{ lease_generation: String(row.lease_generation) }],
        };
      }
      return { rowCount: 0, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  }),
};

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: mockPool,
}));

import { jobManager } from '@/api/services/job-manager';

describe('Distributed Scraper Leases & Fencing Lifecycle (Batch A)', () => {
  const bank = 'test_bank_fencing';

  beforeEach(() => {
    leaseStore.clear();
    mockPool.query.mockClear();
  });

  it('atomically acquires a new lease with initial generation token (A1)', async () => {
    const res = await jobManager.acquireDistributedLease(bank, 'job-worker-1', 60000);
    expect(res.acquired).toBe(true);
    expect(res.leaseGeneration).toBe(1);

    const isLocked = await jobManager.isBankLockedInDatabase(bank);
    expect(isLocked).toBe(true);
  });

  it('rejects concurrent acquisition while an unexpired lease is held (A1)', async () => {
    // Worker 1 acquires
    const worker1 = await jobManager.acquireDistributedLease(bank, 'job-worker-1', 60000);
    expect(worker1.acquired).toBe(true);

    // Worker 2 attempts to acquire same bank while lease is active
    const worker2 = await jobManager.acquireDistributedLease(bank, 'job-worker-2', 60000);
    expect(worker2.acquired).toBe(false);
  });

  it('extends expiration on periodic heartbeat renewal (A1)', async () => {
    const worker1 = await jobManager.acquireDistributedLease(bank, 'job-worker-1', 5000);
    expect(worker1.acquired).toBe(true);

    const renewSuccess = await jobManager.renewDistributedLease(
      bank,
      'job-worker-1',
      worker1.leaseGeneration,
      60000
    );
    expect(renewSuccess).toBe(true);
  });

  it('prevents an old worker with a stale generation token from releasing a newer owner lease (A2)', async () => {
    // Worker 1 acquires gen 1
    const worker1 = await jobManager.acquireDistributedLease(bank, 'job-worker-1', 60000);
    expect(worker1.acquired).toBe(true);

    // Release worker 1's lease
    await jobManager.releaseDistributedLease(bank, 'job-worker-1', worker1.leaseGeneration);

    // Worker 2 acquires, obtaining gen 2
    const worker2 = await jobManager.acquireDistributedLease(bank, 'job-worker-2', 60000);
    expect(worker2.acquired).toBe(true);
    expect(worker2.leaseGeneration).toBe(2);

    // Stale Worker 1 wakes up and attempts to release with old gen 1
    await jobManager.releaseDistributedLease(bank, 'job-worker-1', worker1.leaseGeneration);

    // Worker 2's lease MUST still be active and locked in the database!
    const isStillLocked = await jobManager.isBankLockedInDatabase(bank);
    expect(isStillLocked).toBe(true);

    // Clean up worker 2
    await jobManager.releaseDistributedLease(bank, 'job-worker-2', worker2.leaseGeneration);
  });

  it('verifies fencing token validity at sensitive write boundaries (A2)', async () => {
    const worker = await jobManager.acquireDistributedLease(bank, 'job-worker-valid', 60000);

    // Valid fencing token check passes
    const isValid = await jobManager.verifyLeaseFencing(bank, 'job-worker-valid', worker.leaseGeneration);
    expect(isValid).toBe(true);

    // Stale/incorrect fencing token fails closed
    const isStaleValid = await jobManager.verifyLeaseFencing(bank, 'job-worker-valid', worker.leaseGeneration - 1);
    expect(isStaleValid).toBe(false);

    // Mismatched job ID fails closed
    const isMismatchedJob = await jobManager.verifyLeaseFencing(bank, 'job-stale-imposter', worker.leaseGeneration);
    expect(isMismatchedJob).toBe(false);

    await jobManager.releaseDistributedLease(bank, 'job-worker-valid', worker.leaseGeneration);
  });

  it('allows reclaim of expired lease and increments fencing generation (A3)', async () => {
    // Acquire with negative expiration to simulate immediate expiration
    const worker1 = await jobManager.acquireDistributedLease(bank, 'job-worker-expiring', -1000);
    expect(worker1.acquired).toBe(true);
    expect(worker1.leaseGeneration).toBe(1);

    // Worker 2 acquires the expired lease
    const worker2 = await jobManager.acquireDistributedLease(bank, 'job-worker-reclaimer', 60000);
    expect(worker2.acquired).toBe(true);
    expect(worker2.leaseGeneration).toBe(2);

    await jobManager.releaseDistributedLease(bank, 'job-worker-reclaimer', worker2.leaseGeneration);
  });
});
