import { pool } from '../db/db-client';

export interface GoldenCaseRecord {
  id: string;
  bank: string;
  offer_id: string | null;
  offer_unique_id: string | null;
  offer_title: string | null;
  field: string;
  expected_value: string;
  raw_snippet: string | null;
  notes: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  title?: string;
  live_unique_id?: string;
}

export class GoldenCasesRepository {
  public async getGoldenCases(filters?: { bank?: string; field?: string; enabled?: boolean }): Promise<GoldenCaseRecord[]> {
    const enabledBool = filters?.enabled !== undefined ? filters.enabled : null;
    const result = await pool.query<GoldenCaseRecord>(
      `SELECT g.*, COALESCE(g.offer_title, o.title) AS title, o.unique_id AS live_unique_id
       FROM parser_golden_cases g
       LEFT JOIN offers o ON (g.offer_id = o.id OR (g.offer_unique_id IS NOT NULL AND g.offer_unique_id = o.unique_id))
       WHERE ($1::TEXT IS NULL OR g.bank = $1)
         AND ($2::TEXT IS NULL OR g.field = $2)
         AND ($3::BOOLEAN IS NULL OR g.enabled = $3)
       ORDER BY g.created_at DESC`,
      [filters?.bank || null, filters?.field || null, enabledBool]
    );
    return result.rows;
  }

  public async getCaseById(id: string): Promise<GoldenCaseRecord | null> {
    const result = await pool.query<GoldenCaseRecord>('SELECT * FROM parser_golden_cases WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  public async resolveOffer(offerId?: string, offerUniqueId?: string) {
    const offerLookup = await pool.query<{ id: string; unique_id: string; title: string }>(
      `SELECT id, unique_id, title FROM offers WHERE ($1::UUID IS NOT NULL AND id = $1) OR ($2::TEXT IS NOT NULL AND unique_id = $2) LIMIT 1`,
      [offerId || null, offerUniqueId || null]
    );
    return offerLookup.rows[0] ?? null;
  }

  public async createGoldenCase(data: {
    bank: string;
    offerId?: string | null;
    offerUniqueId?: string | null;
    offerTitle?: string | null;
    field: string;
    expectedValue: string;
    rawSnippet?: string | null;
    notes?: string | null;
    enabled?: boolean;
  }): Promise<GoldenCaseRecord> {
    const insert = await pool.query<GoldenCaseRecord>(
      `INSERT INTO parser_golden_cases (
         bank, offer_id, offer_unique_id, offer_title, field, expected_value, raw_snippet, notes, enabled
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        data.bank,
        data.offerId ?? null,
        data.offerUniqueId ?? null,
        data.offerTitle ?? null,
        data.field,
        data.expectedValue,
        data.rawSnippet ?? null,
        data.notes ?? null,
        data.enabled ?? true,
      ]
    );
    return insert.rows[0];
  }

  public async updateGoldenCase(id: string, updates: {
    expectedValue?: string;
    notes?: string;
    enabled?: boolean;
    rawSnippet?: string;
    field?: string;
    offerId?: string;
    offerUniqueId?: string;
    offerTitle?: string;
  }): Promise<GoldenCaseRecord | null> {
    const result = await pool.query<GoldenCaseRecord>(
      `UPDATE parser_golden_cases SET
         expected_value  = COALESCE($1, expected_value),
         notes           = COALESCE($2, notes),
         enabled         = COALESCE($3, enabled),
         raw_snippet     = COALESCE($4, raw_snippet),
         field           = COALESCE($5, field),
         offer_id        = COALESCE($6, offer_id),
         offer_unique_id = COALESCE($7, offer_unique_id),
         offer_title     = COALESCE($8, offer_title),
         updated_at      = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        updates.expectedValue ?? null,
        updates.notes ?? null,
        updates.enabled ?? null,
        updates.rawSnippet ?? null,
        updates.field ?? null,
        updates.offerId ?? null,
        updates.offerUniqueId ?? null,
        updates.offerTitle ?? null,
        id,
      ]
    );
    return result.rows[0] ?? null;
  }

  public async deleteGoldenCase(id: string): Promise<string | null> {
    const result = await pool.query('DELETE FROM parser_golden_cases WHERE id = $1 RETURNING id', [id]);
    return result.rows[0]?.id ?? null;
  }

  public async getCasesForExecution(bank?: string, caseId?: string) {
    const cases = await pool.query<GoldenCaseRecord & { live_raw_offer: Record<string, unknown> | null }>(
      `SELECT g.*, o.raw_offer AS live_raw_offer
       FROM parser_golden_cases g
       LEFT JOIN offers o ON (g.offer_id = o.id OR (g.offer_unique_id IS NOT NULL AND g.offer_unique_id = o.unique_id))
       WHERE ($1::UUID IS NOT NULL AND g.id = $1)
          OR ($1::UUID IS NULL AND g.enabled = true AND ($2::TEXT IS NULL OR g.bank = $2))
       ORDER BY g.bank, g.field`,
      [caseId || null, bank || null]
    );
    return cases.rows;
  }
}

export const goldenCasesRepository = new GoldenCasesRepository();
