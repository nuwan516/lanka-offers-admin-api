import { pool } from '../db/db-client';

export interface ScrapeRunRecord {
  id: string;
  bank: string;
  mode: string;
  status: string;
  triggered_by: string;
  started_at: string;
  finished_at: string | null;
  offers_found: number;
  offers_new: number;
  offers_changed: number;
  offers_unchanged: number;
  errors: number;
  error_message: string | null;
}

export class ScrapeRunRepository {
  public async getRuns(filters?: { bank?: string; status?: string; limit?: number }): Promise<ScrapeRunRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (filters?.bank) {
      conditions.push(`bank = $${i++}`);
      params.push(filters.bank);
    }
    if (filters?.status) {
      conditions.push(`status = $${i++}`);
      params.push(filters.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters?.limit ?? 50, 100);

    const result = await pool.query<ScrapeRunRecord>(
      `SELECT * FROM scrape_runs ${where} ORDER BY started_at DESC LIMIT $${i}`,
      [...params, limit]
    );
    return result.rows;
  }

  public async getRunById(id: string): Promise<ScrapeRunRecord | null> {
    const result = await pool.query<ScrapeRunRecord>('SELECT * FROM scrape_runs WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  public async getOffersForRun(runId: string) {
    const result = await pool.query(
      `SELECT id, unique_id, title, bank, merchant_name, llm_score, rule_passed, db_status, created_at
       FROM offers WHERE scrape_run_id = $1 ORDER BY created_at DESC`,
      [runId]
    );
    return result.rows;
  }

  public async getSyncRuns(limit = 20) {
    const lim = Math.min(limit, 100);
    const rows = await pool.query(`SELECT * FROM offer_sync_runs ORDER BY started_at DESC LIMIT $1`, [lim]);
    return rows.rows;
  }
}

export const scrapeRunRepository = new ScrapeRunRepository();
