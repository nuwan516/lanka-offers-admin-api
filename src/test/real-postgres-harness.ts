import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';
import type { PoolClient, QueryResultRow } from 'pg';

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
      .replace(/CREATE INDEX IF NOT EXISTS idx_offers_merchant_trgm [^;]+;/gi, '')
      // offer_branches.geom + GIST require PostGIS — lat/lng-only stand-in for PGlite
      .replace(/CREATE INDEX IF NOT EXISTS idx_offer_branches_geom_gist[^;]+;/gi, '')
      .replace(/geom\s+geography\(Point,\s*4326\)\s+NOT NULL,/gi, 'geom TEXT,')
      // Skip JSONB→PostGIS backfill + offers.geom projection (needs PostGIS functions)
      .replace(
        /-- Idempotent backfill from geo_locations JSONB[\s\S]*?AND o\.geom IS NULL;/gi,
        '-- skipped offer_branches / offers.geom backfill (no PostGIS in PGlite)\n'
      );

    await this.db.exec(rawSql);
  }

  public async cleanAllTables(): Promise<void> {
    const tables = [
      'validation_reports',
      'offer_duplicate_candidates',
      'offer_review_history',
      'offer_sync_runs',
      'offer_branches',
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
    const { db } = this;
    return {
      async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
        const res = await db.query<T>(sql, params as Parameters<PGlite['query']>[1]);
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
            const res = await db.query(sql, params as Parameters<PGlite['query']>[1]);
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
