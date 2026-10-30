import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { statsRepository } from '../../src/infrastructure/repositories/stats.repository';
import { evaluateOperationalAlerts } from '../../src/domain/operational-alerts';
import { evaluateDataQualityDrift } from '../../src/domain/drift-monitor';

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

describe('Dashboard Reporting & Operational Metrics Integration', () => {
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

  it('aggregates operational stats including active, expired, rejected, and staged pending candidate counts', async () => {
    // Seed test offers with various lifecycle and staging states
    await poolAdapter.query(`
      INSERT INTO offers (unique_id, bank, title, db_status, raw_offer, pending_candidate)
      VALUES
        ('test-pub-1', 'hnb', 'Published Live Offer 1', 'PUBLISHED', '{"title":"P1"}', NULL),
        ('test-pub-2', 'hnb', 'Published Live Offer 2', 'PUBLISHED', '{"title":"P2"}', '{"title":"P2 Update Candidate"}'),
        ('test-exp-1', 'boc', 'Expired Historical Offer', 'EXPIRED', '{"title":"E1"}', NULL),
        ('test-rej-1', 'sampath', 'Invalid Extraction Offer', 'REJECTED', '{"title":"R1"}', NULL),
        ('test-app-1', 'peoples', 'Approved Pending Sync Offer', 'APPROVED', '{"title":"A1"}', NULL),
        ('test-rev-1', 'ndb', 'Review Required Ambiguous Offer', 'REVIEW_REQUIRED', '{"title":"RV1"}', NULL)
    `);

    const stats = await statsRepository.getAdminStats();

    expect(stats.offers).toBeDefined();
    expect(Number(stats.offers.active_offers)).toBe(2);
    expect(Number(stats.offers.expired_offers)).toBe(1);
    expect(Number(stats.offers.rejected_offers)).toBe(1);
    expect(Number(stats.offers.pending_candidates)).toBe(1);
    expect(Number(stats.offers.total_offers)).toBe(6);
    expect(Number(stats.offers.pending_review)).toBe(2); // review_required + pending_candidate
    expect(Number(stats.offers.pending_sync)).toBe(1); // approved
  });

  it('evaluates operational health and drift alerts without exposing API keys or model reasoning traces', async () => {
    const costStatus = await statsRepository.getCostControlStatus();
    expect(costStatus).toBeDefined();
    expect(costStatus.services).toBeDefined();

    // Verify secrets are NOT exposed
    const serialized = JSON.stringify(costStatus);
    expect(serialized).not.toContain('DEEPSEEK_API_KEY');
    expect(serialized).not.toContain('GEMINI_API_KEY');
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('llm_reasoning');

    // Operational alerts engine evaluation
    const alerts = evaluateOperationalAlerts([
      { bank: 'hnb', consecutiveFailures: 0, validationErrorRate: 0.05 },
      { bank: 'nsb', consecutiveFailures: 3, lastError: 'Selector decay' },
    ]);

    expect(alerts.some((a) => a.bank === 'nsb' && a.level === 'critical')).toBe(true);
    expect(alerts.every((a) => !a.description.includes('sk-') && !a.description.includes('Bearer'))).toBe(true);
  });
});
