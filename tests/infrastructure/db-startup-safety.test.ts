/**
 * Startup Database DDL Safety Regression Tests (Batch F / Phase 11)
 *
 * Verifies that application restarts in production mode (or with AUTO_MIGRATE!=true)
 * never execute privileged schema migrations (CREATE TABLE, ALTER TABLE, CREATE EXTENSION)
 * during normal service initialization.
 */

import { initDatabaseSchemas } from '../../src/infrastructure/db/db-init';
import { pool } from '../../src/infrastructure/db/db-client';

jest.mock('../../src/infrastructure/db/db-client', () => {
  const mockQuery = jest.fn();
  return {
    pool: {
      query: mockQuery,
    },
  };
});

jest.mock('../../src/infrastructure/repositories/rule-config.repository', () => ({
  ruleConfigRepository: {
    initRuleConfigs: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('Startup Database DDL Safety (Batch F)', () => {
  const origEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...origEnv };
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('skips privileged DDL on production startup when AUTO_MIGRATE is not true', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AUTO_MIGRATE;
    delete process.env.SKIP_STARTUP_MIGRATIONS;

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ count: '3' }],
    });

    await initDatabaseSchemas();

    // Verify exactly ONE query was executed: the read-only information_schema check
    expect(pool.query).toHaveBeenCalledTimes(1);
    const querySql = (pool.query as jest.Mock).mock.calls[0][0];
    expect(querySql).toContain('information_schema.tables');

    // Verify NO privileged DDL statements were executed
    expect(querySql).not.toContain('CREATE EXTENSION');
    expect(querySql).not.toContain('ALTER TABLE');
    expect(querySql).not.toContain('CREATE TABLE');
  });

  it('skips privileged DDL by default outside production too, so a dev .env pointing at a real database is never migrated by booting', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTO_MIGRATE;
    delete process.env.SKIP_STARTUP_MIGRATIONS;

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '3' }] });

    await initDatabaseSchemas();

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect((pool.query as jest.Mock).mock.calls[0][0]).toContain('information_schema.tables');
  });

  it('SKIP_STARTUP_MIGRATIONS=true wins even when AUTO_MIGRATE=true', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTO_MIGRATE = 'true';
    process.env.SKIP_STARTUP_MIGRATIONS = 'true';

    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ count: '3' }] });

    await initDatabaseSchemas();

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('skips privileged DDL when SKIP_STARTUP_MIGRATIONS=true regardless of NODE_ENV', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SKIP_STARTUP_MIGRATIONS = 'true';

    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ count: '3' }],
    });

    await initDatabaseSchemas();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const querySql = (pool.query as jest.Mock).mock.calls[0][0];
    expect(querySql).toContain('information_schema.tables');
  });

  it('allows schema migrations when AUTO_MIGRATE=true in non-production or privileged mode', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTO_MIGRATE = 'true';
    delete process.env.SKIP_STARTUP_MIGRATIONS;

    (pool.query as jest.Mock).mockResolvedValue({
      rows: [{ count: '0' }],
    });

    await initDatabaseSchemas();

    // Multiple queries executed including DDL
    expect((pool.query as jest.Mock).mock.calls.length).toBeGreaterThan(5);
    const allSql = (pool.query as jest.Mock).mock.calls.map((c: any) => c[0]).join(' ');
    expect(allSql).toContain('CREATE EXTENSION');
    expect(allSql).toContain('ALTER TABLE');
  });
});
