import { pool } from '../db/db-client';
import { BankParserRule, invalidateBankRulesCache } from '@/banks/bank-rules-loader';

export class BankParserRulesRepository {
  public async getRules(bank?: string): Promise<BankParserRule[]> {
    const rows = bank
      ? await pool.query<BankParserRule>(
          'SELECT * FROM bank_parser_rules WHERE bank = $1 ORDER BY field, priority ASC, created_at',
          [bank]
        )
      : await pool.query<BankParserRule>('SELECT * FROM bank_parser_rules ORDER BY bank, field, priority ASC, created_at');
    return rows.rows;
  }

  public async getRuleById(id: string): Promise<BankParserRule | null> {
    const result = await pool.query<BankParserRule>('SELECT * FROM bank_parser_rules WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  public async createRule(data: {
    bank: string;
    field: string;
    rule_type: string;
    pattern?: string | null;
    flags?: string;
    capture_group?: number;
    notes?: string | null;
    priority?: number;
    source_path?: string | null;
    category?: string | null;
    source_type?: string | null;
    status?: string;
  }): Promise<BankParserRule> {
    const result = await pool.query<BankParserRule>(
      `INSERT INTO bank_parser_rules
         (bank, field, rule_type, pattern, flags, capture_group, notes, is_builtin,
          priority, source_path, category, source_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.bank,
        data.field,
        data.rule_type,
        data.pattern ?? null,
        data.flags ?? 'i',
        data.capture_group ?? 1,
        data.notes ?? null,
        data.priority ?? 100,
        data.source_path ?? null,
        data.category ?? null,
        data.source_type ?? null,
        data.status ?? 'active',
      ]
    );

    invalidateBankRulesCache(data.bank);
    return result.rows[0];
  }

  public async updateRule(id: string, updates: Record<string, any>): Promise<BankParserRule | null> {
    const result = await pool.query<BankParserRule>(
      `UPDATE bank_parser_rules SET
         field         = COALESCE($1, field),
         rule_type     = COALESCE($2, rule_type),
         pattern       = COALESCE($3, pattern),
         flags         = COALESCE($4, flags),
         capture_group = COALESCE($5, capture_group),
         enabled       = COALESCE($6, enabled),
         notes         = COALESCE($7, notes),
         priority      = COALESCE($8, priority),
         source_path   = COALESCE($9, source_path),
         category      = COALESCE($10, category),
         source_type   = COALESCE($11, source_type),
         status        = COALESCE($12, status),
         version       = version + 1,
         updated_at    = NOW()
       WHERE id = $13 RETURNING *`,
      [
        updates.field,
        updates.rule_type,
        updates.pattern,
        updates.flags,
        updates.capture_group,
        updates.enabled,
        updates.notes,
        updates.priority,
        updates.source_path,
        updates.category,
        updates.source_type,
        updates.status,
        id,
      ]
    );

    if (result.rows.length) {
      invalidateBankRulesCache(result.rows[0].bank);
      return result.rows[0];
    }
    return null;
  }

  public async deleteRule(id: string): Promise<string | null> {
    const lookup = await pool.query<{ bank: string }>('SELECT bank FROM bank_parser_rules WHERE id = $1', [id]);
    if (!lookup.rows.length) return null;

    await pool.query('DELETE FROM bank_parser_rules WHERE id = $1', [id]);
    invalidateBankRulesCache(lookup.rows[0].bank);
    return id;
  }

  public async getOffersForTest(bank: string, limit = 20) {
    const result = await pool.query<{ unique_id: string; bank: string; title: string; raw_offer: unknown }>(
      `SELECT unique_id, bank, title, raw_offer FROM offers WHERE bank = $1 AND raw_offer IS NOT NULL ORDER BY updated_at DESC LIMIT $2`,
      [bank, Math.min(limit, 50)]
    );
    return result.rows;
  }

  public async getOffersForBacktest(bank: string, limit = 30) {
    const result = await pool.query<{
      id: string;
      unique_id: string;
      bank: string;
      title: string;
      raw_offer: Record<string, unknown>;
      merchant_name: string | null;
      discount_percentage: string | null;
      card_type: string | null;
      category: string | null;
    }>(
      `SELECT id, unique_id, bank, title, raw_offer, merchant_name, discount_percentage, card_type, category
       FROM offers
       WHERE bank = $1 AND raw_offer IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT $2`,
      [bank, Math.min(limit, 100)]
    );
    return result.rows;
  }

  public async getSampleOffer(bank: string) {
    const result = await pool.query<{
      unique_id: string;
      bank: string;
      title: string;
      raw_offer: Record<string, unknown>;
    }>(
      `SELECT unique_id, bank, title, raw_offer FROM offers WHERE bank = $1 AND raw_offer IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
      [bank]
    );
    return result.rows[0] ?? null;
  }
}

export const bankParserRulesRepository = new BankParserRulesRepository();
