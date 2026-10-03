import { pool } from '../db/db-client';
import { CustomRule } from './rule-config.repository';

export class ValidationRepository {
  public async getValidationReports(passed?: boolean, limit = 50) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (passed !== undefined) {
      conditions.push(`passed = $${i++}`);
      params.push(passed);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const lim = Math.min(limit, 100);

    const result = await pool.query(
      `SELECT vr.*, o.title, o.bank, o.merchant_name
       FROM validation_reports vr
       JOIN offers o ON o.id = vr.offer_id
       ${where}
       ORDER BY vr.created_at DESC
       LIMIT $${i}`,
      [...params, lim]
    );
    return result.rows;
  }

  public async getBacktestReport() {
    const [errorStats, warnStats, bankStats, summary] = await Promise.all([
      pool.query(`
        SELECT e->>'field' AS field, e->>'message' AS message, COUNT(*) AS hit_count
        FROM offers, jsonb_array_elements(COALESCE(rule_errors, '[]'::jsonb)) AS e
        GROUP BY e->>'field', e->>'message' ORDER BY hit_count DESC
      `),
      pool.query(`
        SELECT w->>'field' AS field, w->>'message' AS message, COUNT(*) AS hit_count
        FROM offers, jsonb_array_elements(COALESCE(rule_warnings, '[]'::jsonb)) AS w
        GROUP BY w->>'field', w->>'message' ORDER BY hit_count DESC
      `),
      pool.query(`
        SELECT bank, COUNT(*) AS total,
          COUNT(*) FILTER (WHERE rule_passed = true) AS passed,
          COUNT(*) FILTER (WHERE rule_passed = false) AS failed
        FROM offers GROUP BY bank ORDER BY bank
      `),
      pool.query(`
        SELECT COUNT(*) AS total,
          COUNT(*) FILTER (WHERE rule_passed = true) AS passed,
          COUNT(*) FILTER (WHERE rule_passed = false) AS failed
        FROM offers
      `),
    ]);

    return {
      errors: errorStats.rows,
      warnings: warnStats.rows,
      byBank: bankStats.rows,
      summary: summary.rows[0],
    };
  }

  public async getOffersForRevalidation(bank?: string, offerId?: string) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let pIdx = 1;

    if (bank) {
      conditions.push(`bank = $${pIdx++}`);
      params.push(bank);
    }
    if (offerId) {
      conditions.push(`(id::text = $${pIdx} OR unique_id = $${pIdx})`);
      params.push(offerId);
      pIdx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await pool.query<{ id: string; bank: string; raw_offer: Record<string, unknown> }>(
      `SELECT id, bank, raw_offer FROM offers ${where} LIMIT 5000`,
      params
    );
    return rows.rows;
  }

  public async getAllEnabledRules(): Promise<CustomRule[]> {
    const result = await pool.query<CustomRule>(
      'SELECT * FROM custom_rules WHERE enabled = true ORDER BY is_builtin DESC, created_at'
    );
    return result.rows.map((r: any) => ({ ...r, config: r.config ?? {} }));
  }

  public async updateOfferValidationResults(
    offerId: string,
    rulePassed: boolean,
    ruleErrors: unknown[],
    ruleWarnings: unknown[]
  ): Promise<void> {
    await pool.query(
      `UPDATE offers SET rule_passed = $1, rule_errors = $2, rule_warnings = $3, updated_at = NOW() WHERE id = $4`,
      [rulePassed, JSON.stringify(ruleErrors), JSON.stringify(ruleWarnings), offerId]
    );
  }
}

export const validationRepository = new ValidationRepository();
