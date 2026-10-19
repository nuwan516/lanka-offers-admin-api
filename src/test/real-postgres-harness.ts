import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import type { PoolClient } from 'pg';

export class RealPostgresHarness {
  public db: PGlite;

  constructor() {
    this.db = new PGlite();
  }

  public async initSchema(): Promise<void> {
    const schemaPath = path.resolve(__dirname, '../../src/infrastructure/db/schema.sql');
    let rawSql = fs.readFileSync(schemaPath, 'utf8');

    // Strip PostGIS and trgm extensions for WASM compatibility while preserving all tables and constraints
    rawSql = rawSql
      .replace(/CREATE EXTENSION IF NOT EXISTS [^;]+;/gi, '')
      .replace(/ALTER TABLE offers ADD COLUMN IF NOT EXISTS geom [^;]+;/gi, '')
      .replace(/CREATE INDEX IF NOT EXISTS idx_offers_geom_gist [^;]+;/gi, '')
      .replace(/CREATE INDEX IF NOT EXISTS idx_offers_title_trgm [^;]+;/gi, '')
      .replace(/CREATE INDEX IF NOT EXISTS idx_offers_merchant_trgm [^;]+;/gi, '');

    await this.db.exec(rawSql);
  }

  public async cleanAllTables(): Promise<void> {
    const tables = [
      'validation_reports',
      'offer_duplicate_candidates',
      'offer_review_history',
      'offer_sync_runs',
      'offers',
      'scrape_runs',
      'scraper_leases',
      'external_api_usage',
      'geo_cache',
      'scheduler_config',
    ];
    for (const table of tables) {
      await this.db.query(`DELETE FROM ${table}`);
    }
  }

  public async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Returns a pg.Pool compatible mock interface wrapping the real PostgreSQL instance
   */
  public getPoolAdapter() {
    const self = this;
    return {
      async query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
        const res = await self.db.query<T>(sql, params as any[]);
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
        const rowCount = isSelect ? res.rows.length : (res.affectedRows ?? res.rows.length);
        return {
          rows: res.rows,
          rowCount,
        };
      },
      async connect(): Promise<PoolClient> {
        return {
          query: async (sql: string, params?: unknown[]) => {
            const res = await self.db.query(sql, params as any[]);
            const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
            const rowCount = isSelect ? res.rows.length : (res.affectedRows ?? res.rows.length);
            return {
              rows: res.rows,
              rowCount,
            };
          },
          release: () => {},
        } as unknown as PoolClient;
      },
    };
  }
}
