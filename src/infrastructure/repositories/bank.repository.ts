import { pool } from '../db/db-client';

export interface BankOverview {
  bank: string;
  total_offers: number;
  active_offers: number;
  avg_llm_score: number | null;
  rule_failures: number;
  geo_count: number;
  last_updated: string | null;
  last_run_status: string | null;
  last_run_at: string | null;
  last_run_found: number;
  last_run_new: number;
  last_run_changed: number;
  last_run_errors: number;
  health_status: 'Healthy' | 'Warning' | 'Failed' | 'Running' | 'Idle';
}

export class BankRepository {
  public async getBanksOverview(): Promise<BankOverview[]> {
    const result = await pool.query<BankOverview>(`
      WITH latest_runs AS (
        SELECT DISTINCT ON (bank)
          bank,
          status AS last_run_status,
          started_at AS last_run_at,
          offers_found AS last_run_found,
          offers_new AS last_run_new,
          offers_changed AS last_run_changed,
          errors AS last_run_errors
        FROM scrape_runs
        ORDER BY bank, started_at DESC
      ),
      bank_offers AS (
        SELECT
          bank,
          COUNT(*) AS total_offers,
          COUNT(*) FILTER (WHERE db_status = 'PUBLISHED') AS active_offers,
          ROUND(AVG(llm_score) FILTER (WHERE llm_score IS NOT NULL)) AS avg_llm_score,
          COUNT(*) FILTER (WHERE rule_passed = false) AS rule_failures,
          COUNT(*) FILTER (WHERE geo_locations IS NOT NULL AND geo_locations != '[]'::jsonb) AS geo_count,
          MAX(updated_at) AS last_updated
        FROM offers
        GROUP BY bank
      )
      SELECT
        COALESCE(b.bank, r.bank) AS bank,
        COALESCE(b.total_offers, 0) AS total_offers,
        COALESCE(b.active_offers, 0) AS active_offers,
        b.avg_llm_score,
        COALESCE(b.rule_failures, 0) AS rule_failures,
        COALESCE(b.geo_count, 0) AS geo_count,
        b.last_updated,
        r.last_run_status,
        r.last_run_at,
        COALESCE(r.last_run_found, 0) AS last_run_found,
        COALESCE(r.last_run_new, 0) AS last_run_new,
        COALESCE(r.last_run_changed, 0) AS last_run_changed,
        COALESCE(r.last_run_errors, 0) AS last_run_errors,
        CASE
          WHEN r.last_run_status = 'failed' OR COALESCE(r.last_run_errors, 0) > 5 THEN 'Failed'
          WHEN r.last_run_status = 'running' THEN 'Running'
          WHEN COALESCE(r.last_run_errors, 0) > 0 OR COALESCE(b.rule_failures, 0) > 0 THEN 'Warning'
          WHEN r.last_run_status = 'completed' THEN 'Healthy'
          ELSE 'Idle'
        END AS health_status
      FROM bank_offers b
      FULL OUTER JOIN latest_runs r ON b.bank = r.bank
      ORDER BY bank
    `);

    return result.rows;
  }
}

export const bankRepository = new BankRepository();
