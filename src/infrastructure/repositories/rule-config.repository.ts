import { pool } from '../db/db-client';

export interface CustomRule {
  id: string;
  name: string;
  description: string | null;
  group_name: string;
  severity: 'error' | 'warning';
  enabled: boolean;
  field_path: string;
  operator: string;
  config: Record<string, unknown>;
  notes: string | null;
  is_builtin: boolean;
  builtin_id: string | null;
  banks: string[] | null;
  created_at?: string;
  updated_at?: string;
}

export const VALIDATION_RULES = [
  { id: 'required_uniqueId',      field: 'uniqueId',                    description: 'uniqueId is required',                                          severity: 'error',   group: 'Required fields' },
  { id: 'required_source',        field: 'source',                      description: 'source is required',                                            severity: 'error',   group: 'Required fields' },
  { id: 'required_title',         field: 'title',                       description: 'title is required and non-empty',                               severity: 'error',   group: 'Required fields' },
  { id: 'required_scrapedAt',     field: 'scrapedAt',                   description: 'scrapedAt is required',                                         severity: 'error',   group: 'Required fields' },
  { id: 'date_validFrom_format',  field: 'validityPeriods[].validFrom', description: 'validFrom must be YYYY-MM-DD format',                           severity: 'error',   group: 'Dates' },
  { id: 'date_validTo_format',    field: 'validityPeriods[].validTo',   description: 'validTo must be YYYY-MM-DD format',                             severity: 'error',   group: 'Dates' },
  { id: 'date_range_order',       field: 'validityPeriods[]',           description: 'validFrom must not be after validTo',                           severity: 'warning', group: 'Dates' },
  { id: 'offer_expired',          field: 'validityPeriods',             description: 'Offer must not be fully expired (all validTo dates in the past)',severity: 'error',   group: 'Dates' },
  { id: 'discount_range',         field: 'offer.discountPercentage',    description: 'Discount percentage must be in 0–100 range',                    severity: 'warning', group: 'Offer quality' },
  { id: 'merchant_name',          field: 'merchant.name',               description: 'Merchant name must not be empty',                               severity: 'warning', group: 'Merchant' },
  { id: 'merchant_location',      field: 'merchant',                    description: 'Merchant must have a location or at least one address',         severity: 'warning', group: 'Merchant' },
  { id: 'transaction_min',        field: 'transactionRange.min',        description: 'Transaction minimum cannot be negative',                        severity: 'error',   group: 'Transaction range' },
  { id: 'transaction_max',        field: 'transactionRange.max',        description: 'Transaction maximum cannot be negative',                        severity: 'error',   group: 'Transaction range' },
  { id: 'transaction_range_order',field: 'transactionRange',            description: 'Transaction min must not exceed transaction max',               severity: 'warning', group: 'Transaction range' },
  { id: 'content_hash',           field: 'contentHash',                 description: 'contentHash must be a 64-character sha256 hex string',          severity: 'warning', group: 'Integrity' },
  { id: 'category_present',       field: 'category',                    description: 'category must not be empty',                                    severity: 'warning', group: 'Offer quality' },
];

export function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    const m = part.match(/^(\w+)\[(\d+)\]$/);
    if (m) {
      current = (current as any)[m[1]]?.[parseInt(m[2], 10)];
    } else {
      current = (current as any)[part];
    }
  }
  return current;
}

export function evalCustomRule(rule: CustomRule, offer: Record<string, unknown>): { passed: boolean; message?: string } {
  const v = getValueAtPath(offer, rule.field_path);
  const c = rule.config as any;
  const label = rule.field_path;
  switch (rule.operator) {
    case 'required':
      if (v === null || v === undefined) return { passed: false, message: `${label} is required` };
      break;
    case 'not_empty':
      if (!v || String(v).trim().length === 0) return { passed: false, message: `${label} must not be empty` };
      break;
    case 'min':
      if (v !== null && v !== undefined && Number(v) < c.min) return { passed: false, message: `${label} must be ≥ ${c.min} (got: ${v})` };
      break;
    case 'max':
      if (v !== null && v !== undefined && Number(v) > c.max) return { passed: false, message: `${label} must be ≤ ${c.max} (got: ${v})` };
      break;
    case 'between':
      if (v !== null && v !== undefined && (Number(v) < c.min || Number(v) > c.max)) return { passed: false, message: `${label} must be between ${c.min} and ${c.max} (got: ${v})` };
      break;
    case 'matches':
      if (v !== null && v !== undefined && !new RegExp(c.pattern).test(String(v))) return { passed: false, message: `${label} must match /${c.pattern}/ (got: ${v})` };
      break;
    case 'min_length':
      if (String(v ?? '').length < c.length) return { passed: false, message: `${label} must be ≥ ${c.length} chars (got: ${String(v ?? '').length})` };
      break;
    case 'max_length':
      if (String(v ?? '').length > c.length) return { passed: false, message: `${label} exceeds ${c.length} chars` };
      break;
    case 'not_expired': {
      if (v) {
        const today = new Date().toISOString().split('T')[0];
        if (String(v) < today) return { passed: false, message: `${label} is expired: ${v}` };
      }
      break;
    }
    case 'lte_field': {
      const other = getValueAtPath(offer, c.other_field);
      if (v !== null && v !== undefined && other !== null && other !== undefined) {
        if (String(v) > String(other)) return { passed: false, message: `${label} (${v}) must be ≤ ${c.other_field} (${other})` };
      }
      break;
    }
    case 'gte_field': {
      const other = getValueAtPath(offer, c.other_field);
      if (v !== null && v !== undefined && other !== null && other !== undefined) {
        if (String(v) < String(other)) return { passed: false, message: `${label} (${v}) must be ≥ ${c.other_field} (${other})` };
      }
      break;
    }
    case 'array_any_not_expired': {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        const hasValid = arr.some((item: any) => {
          const d = item?.[c.date_field];
          return d && String(d) >= today;
        });
        if (!hasValid) return { passed: false, message: `All ${label}[].${c.date_field} dates are in the past — offer is fully expired` };
      }
      break;
    }
    case 'has_value': {
      const fields: string[] = Array.isArray(c.fields) ? c.fields : [];
      const found = fields.some(f => {
        const fv = getValueAtPath(offer, f);
        return fv !== null && fv !== undefined && String(fv).trim().length > 0;
      });
      if (!found) return { passed: false, message: `At least one of [${fields.join(', ')}] must have a value` };
      break;
    }
  }
  return { passed: true };
}

const DATE_BANKS = ['hnb', 'boc', 'sampath', 'peoples', 'seylan', 'dfcc', 'combank'];
const TX_BANKS = ['hnb', 'boc', 'sampath', 'peoples', 'ndb', 'seylan', 'dfcc', 'combank'];
const LOC_BANKS = ['hnb', 'boc', 'sampath', 'peoples', 'ndb', 'seylan', 'dfcc', 'combank'];

const BUILTIN_RULE_SEED = [
  { builtin_id: 'required_uniqueId', banks: null, name: 'Unique ID required', description: 'uniqueId must be present', group_name: 'Required fields', severity: 'error', field_path: 'uniqueId', operator: 'required', config: {} },
  { builtin_id: 'required_source', banks: null, name: 'Source required', description: 'source must be present', group_name: 'Required fields', severity: 'error', field_path: 'source', operator: 'required', config: {} },
  { builtin_id: 'required_title', banks: null, name: 'Title non-empty', description: 'title must be non-empty', group_name: 'Required fields', severity: 'error', field_path: 'title', operator: 'not_empty', config: {} },
  { builtin_id: 'required_scrapedAt', banks: null, name: 'ScrapedAt required', description: 'scrapedAt must be present', group_name: 'Required fields', severity: 'error', field_path: 'scrapedAt', operator: 'required', config: {} },
  { builtin_id: 'date_validFrom_format', banks: DATE_BANKS, name: 'ValidFrom date format', description: 'validFrom must be YYYY-MM-DD (banks with structured date fields)', group_name: 'Dates', severity: 'error', field_path: 'validityPeriods[0].validFrom', operator: 'matches', config: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  { builtin_id: 'date_validTo_format', banks: DATE_BANKS, name: 'ValidTo date format', description: 'validTo must be YYYY-MM-DD (banks with structured date fields)', group_name: 'Dates', severity: 'error', field_path: 'validityPeriods[0].validTo', operator: 'matches', config: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  { builtin_id: 'date_range_order', banks: null, name: 'ValidFrom ≤ ValidTo', description: 'validFrom must not be after validTo (skips null values)', group_name: 'Dates', severity: 'warning', field_path: 'validityPeriods[0].validFrom', operator: 'lte_field', config: { other_field: 'validityPeriods[0].validTo' } },
  { builtin_id: 'offer_expired', banks: null, name: 'Offer not fully expired', description: 'At least one validity period must not be in the past', group_name: 'Dates', severity: 'error', field_path: 'validityPeriods', operator: 'array_any_not_expired', config: { date_field: 'validTo' } },
  { builtin_id: 'discount_range', banks: null, name: 'Discount 0–100%', description: 'Discount percentage must be in 0–100 range (null = skip)', group_name: 'Offer quality', severity: 'warning', field_path: 'offer.discountPercentage', operator: 'between', config: { min: 0, max: 100 } },
  { builtin_id: 'category_present', banks: null, name: 'Category non-empty', description: 'category must not be empty', group_name: 'Offer quality', severity: 'warning', field_path: 'category', operator: 'not_empty', config: {} },
  { builtin_id: 'merchant_name', banks: null, name: 'Merchant name non-empty', description: 'Merchant name must not be empty', group_name: 'Merchant', severity: 'warning', field_path: 'merchant.name', operator: 'not_empty', config: {} },
  { builtin_id: 'merchant_location', banks: LOC_BANKS, name: 'Merchant has location', description: 'merchant.location or merchant.addresses must have a value (banks that extract location)', group_name: 'Merchant', severity: 'warning', field_path: 'merchant.location', operator: 'has_value', config: { fields: ['merchant.location', 'merchant.addresses[0]'] } },
  { builtin_id: 'transaction_min', banks: TX_BANKS, name: 'Transaction min ≥ 0', description: 'Transaction minimum cannot be negative (null = not stated = ok)', group_name: 'Transaction range', severity: 'error', field_path: 'transactionRange.min', operator: 'min', config: { min: 0 } },
  { builtin_id: 'transaction_max', banks: TX_BANKS, name: 'Transaction max ≥ 0', description: 'Transaction maximum cannot be negative (null = not stated = ok)', group_name: 'Transaction range', severity: 'error', field_path: 'transactionRange.max', operator: 'min', config: { min: 0 } },
  { builtin_id: 'transaction_range_order', banks: TX_BANKS, name: 'Transaction min ≤ max', description: 'Transaction min must not exceed transaction max (skips null)', group_name: 'Transaction range', severity: 'warning', field_path: 'transactionRange.min', operator: 'lte_field', config: { other_field: 'transactionRange.max' } },
  { builtin_id: 'content_hash', banks: null, name: 'Content hash is SHA-256', description: 'contentHash must be a 64-character sha256 hex string', group_name: 'Integrity', severity: 'warning', field_path: 'contentHash', operator: 'matches', config: { pattern: '^[a-f0-9]{64}$' } },
];

export class RuleConfigRepository {
  public async initRuleConfigs(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rule_configs (
        id         TEXT PRIMARY KEY,
        enabled    BOOLEAN NOT NULL DEFAULT true,
        severity   TEXT    NOT NULL DEFAULT 'error',
        notes      TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custom_rules (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name        TEXT NOT NULL,
        description TEXT,
        group_name  TEXT NOT NULL DEFAULT 'Custom',
        severity    TEXT NOT NULL DEFAULT 'warning',
        enabled     BOOLEAN NOT NULL DEFAULT true,
        field_path  TEXT NOT NULL,
        operator    TEXT NOT NULL,
        config      JSONB NOT NULL DEFAULT '{}',
        notes       TEXT,
        is_builtin  BOOLEAN NOT NULL DEFAULT false,
        builtin_id  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      ALTER TABLE custom_rules ADD COLUMN IF NOT EXISTS banks TEXT[] DEFAULT NULL;
    `);

    // Ensure built-in rules exist
    for (const rule of BUILTIN_RULE_SEED) {
      await pool.query(
        `INSERT INTO custom_rules (name, description, group_name, severity, enabled, field_path, operator, config, is_builtin, builtin_id, banks)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, true, $8, $9)
         ON CONFLICT DO NOTHING`,
        [rule.name, rule.description, rule.group_name, rule.severity, rule.field_path, rule.operator, JSON.stringify(rule.config), rule.builtin_id, rule.banks]
      );
    }
  }

  public async getBuiltinRules() {
    const result = await pool.query('SELECT * FROM custom_rules WHERE is_builtin = true ORDER BY created_at');
    return result.rows.map((r: any) => ({
      id: r.builtin_id ?? r.id,
      field: r.field_path,
      description: r.description ?? r.name,
      severity: r.severity,
      group: r.group_name,
      enabled: r.enabled,
      notes: r.notes,
      updated_at: r.updated_at,
    }));
  }

  public async updateRuleConfig(id: string, enabled?: boolean, severity?: string, notes?: string) {
    const result = await pool.query(
      `INSERT INTO rule_configs (id, enabled, severity, notes, updated_at)
       VALUES ($1, COALESCE($2, true), COALESCE($3, 'error'), $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         enabled    = COALESCE($2, rule_configs.enabled),
         severity   = COALESCE($3, rule_configs.severity),
         notes      = COALESCE($4, rule_configs.notes),
         updated_at = NOW()
       RETURNING *`,
      [id, enabled, severity, notes ?? null]
    );
    return result.rows[0];
  }

  public async getCustomRules(): Promise<CustomRule[]> {
    const result = await pool.query<CustomRule>('SELECT * FROM custom_rules ORDER BY created_at');
    return result.rows;
  }

  public async getCustomRuleById(id: string): Promise<CustomRule | null> {
    const result = await pool.query<CustomRule>('SELECT * FROM custom_rules WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  public async createCustomRule(data: {
    name: string;
    description?: string | null;
    group_name?: string;
    severity?: string;
    field_path: string;
    operator: string;
    config?: Record<string, unknown>;
    notes?: string | null;
    banks?: string[] | null;
  }): Promise<CustomRule> {
    const banksVal = Array.isArray(data.banks) && data.banks.length > 0 ? data.banks : null;
    const result = await pool.query<CustomRule>(
      `INSERT INTO custom_rules (name, description, group_name, severity, field_path, operator, config, notes, banks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        data.name,
        data.description ?? null,
        data.group_name ?? 'Custom',
        data.severity ?? 'warning',
        data.field_path,
        data.operator,
        JSON.stringify(data.config ?? {}),
        data.notes ?? null,
        banksVal,
      ]
    );
    return result.rows[0];
  }

  public async updateCustomRule(id: string, updates: Record<string, any>): Promise<CustomRule | null> {
    const banksUpdate = 'banks' in updates
      ? (Array.isArray(updates.banks) && updates.banks.length > 0 ? updates.banks : null)
      : undefined;

    const result = await pool.query<CustomRule>(
      `UPDATE custom_rules SET
         name       = COALESCE($1,  name),
         description= COALESCE($2,  description),
         group_name = COALESCE($3,  group_name),
         severity   = COALESCE($4,  severity),
         enabled    = COALESCE($5,  enabled),
         field_path = COALESCE($6,  field_path),
         operator   = COALESCE($7,  operator),
         config     = COALESCE($8,  config),
         notes      = COALESCE($9,  notes),
         banks      = CASE WHEN $11 THEN $10 ELSE banks END,
         updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [
        updates.name,
        updates.description,
        updates.group_name,
        updates.severity,
        updates.enabled,
        updates.field_path,
        updates.operator,
        updates.config !== undefined ? JSON.stringify(updates.config) : null,
        updates.notes,
        banksUpdate ?? null,
        banksUpdate !== undefined,
        id,
      ]
    );
    return result.rows[0] ?? null;
  }

  public async deleteCustomRule(id: string): Promise<string | null> {
    const result = await pool.query('DELETE FROM custom_rules WHERE id = $1 RETURNING id', [id]);
    return result.rows[0]?.id ?? null;
  }

  public async getOffersForCustomRuleTest(bank?: string, limit = 50) {
    const conditions = bank ? ['bank = $1'] : [];
    const params: unknown[] = bank ? [bank] : [];
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, unique_id, bank, title, raw_offer FROM offers ${where} ORDER BY updated_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return result.rows;
  }
}

export const ruleConfigRepository = new RuleConfigRepository();
