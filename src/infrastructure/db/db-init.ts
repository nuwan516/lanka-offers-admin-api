import { pool } from './db-client';
import { ruleConfigRepository } from '../repositories/rule-config.repository';
import { seedGoldenCases } from './seed-golden-cases';

const BANK_PARSER_RULE_SEED = [
  { bank: 'hnb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+?)(?=\\s*(?:Offer|Period|Eligibility|Contact|Location|Special|General|$))', flags: 'i', capture_group: 1, notes: 'Extracts merchant name from "Merchant: ..." block in offer text' },
  { bank: 'hnb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'Extracts discount % e.g. "20% off"' },
  { bank: 'hnb', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?)\\s*(?:to|[-–])\\s*Rs\\.?\\s*[\\d,.]+', flags: 'i', capture_group: 1, notes: 'Extracts minimum spend e.g. "Rs. 5,000 to Rs. 50,000"' },
  { bank: 'hnb', field: 'transaction_max', rule_type: 'regex', pattern: 'Rs\\.?\\s*[\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?\\s*(?:to|[-–])\\s*Rs\\.?\\s*([\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?)', flags: 'i', capture_group: 1, notes: 'Extracts maximum spend from same range pattern' },
  { bank: 'hnb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit card,debit card,visa,mastercard,amex,american express', flags: 'i', capture_group: 0, notes: 'Keywords to detect eligible card types' },
  { bank: 'hnb', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,advance booking,prior reservation', flags: 'i', capture_group: 0, notes: 'Keywords indicating booking is required' },
  { bank: 'hnb', field: 'installment_rate', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s+\\d+\\s*months', flags: 'i', capture_group: 1, notes: 'Extracts installment interest rate' },
  { bank: 'boc', field: 'merchant_name', rule_type: 'field_map', pattern: 'title', flags: '', capture_group: 0, notes: 'BOC uses the offer title as merchant name' },
  { bank: 'boc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%', flags: 'i', capture_group: 1, notes: 'Extracts % from offerValue or description' },
  { bank: 'boc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: 'BOC card type keywords' },
  { bank: 'boc', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,prior booking', flags: 'i', capture_group: 0, notes: 'BOC booking requirement keywords' },
  { bank: 'sampath', field: 'merchant_name', rule_type: 'field_map', pattern: 'company_name', flags: '', capture_group: 0, notes: 'Sampath API provides company_name; fallback: merchant_name or title' },
  { bank: 'sampath', field: 'discount_pct', rule_type: 'field_map', pattern: 'short_discount', flags: '', capture_group: 0, notes: 'Sampath provides discount value in short_discount field' },
  { bank: 'sampath', field: 'card_types', rule_type: 'field_map', pattern: 'eligible_cards', flags: '', capture_group: 0, notes: 'Sampath eligible_cards is an array field' },
  { bank: 'sampath', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,advance booking', flags: 'i', capture_group: 0, notes: 'Sampath booking requirement keywords in promotion_details' },
  { bank: 'sampath', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|min)', flags: 'i', capture_group: 1, notes: 'Minimum spend from promotion text' },
  { bank: 'ndb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'NDB offer text often has "Merchant: ..." label' },
  { bank: 'ndb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'NDB discount percentage' },
  { bank: 'ndb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'NDB card type keywords' },
  { bank: 'ndb', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+(?:,\\d{3})*)\\s*(?:and above|minimum|or above|\\+)', flags: 'i', capture_group: 1, notes: 'Minimum transaction amount' },
  { bank: 'ndb', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,prior booking,advance', flags: 'i', capture_group: 0, notes: 'Booking requirement keywords' },
  { bank: 'dfcc', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'DFCC merchant name label in text' },
  { bank: 'dfcc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'DFCC discount percentage' },
  { bank: 'dfcc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'DFCC card type keywords' },
  { bank: 'dfcc', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or more)', flags: 'i', capture_group: 1, notes: 'Minimum transaction' },
  { bank: 'seylan', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'Seylan merchant label extraction' },
  { bank: 'seylan', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'Seylan discount percentage' },
  { bank: 'seylan', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'Seylan card type keywords' },
  { bank: 'seylan', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above)', flags: 'i', capture_group: 1, notes: 'Seylan minimum spend' },
  { bank: 'peoples', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: "People's Bank merchant label" },
  { bank: 'peoples', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: "People's Bank discount %" },
  { bank: 'peoples', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: "People's Bank card types" },
  { bank: 'pabc', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'PABC merchant label extraction' },
  { bank: 'pabc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'PABC discount percentage' },
  { bank: 'pabc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'PABC card type keywords' },
  { bank: 'pabc', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or above)', flags: 'i', capture_group: 1, notes: 'PABC minimum transaction amount' },
  { bank: 'nsb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'NSB merchant label extraction' },
  { bank: 'nsb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'NSB discount percentage' },
  { bank: 'nsb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: 'NSB card type keywords' },
  { bank: 'combank', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'COMBANK merchant label extraction' },
  { bank: 'combank', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'COMBANK discount percentage' },
  { bank: 'combank', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'COMBANK card type keywords' },
  { bank: 'combank', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or more)', flags: 'i', capture_group: 1, notes: 'COMBANK minimum transaction' },
];

export async function initDatabaseSchemas(): Promise<void> {
  // 1. PostGIS Spatial Extension & Geospatial Geometry
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');
  await pool.query('ALTER TABLE offers ADD COLUMN IF NOT EXISTS geom geography(Point, 4326);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_offers_geom_gist ON offers USING GIST (geom);');

  // 2. Rule configs & custom rules
  await ruleConfigRepository.initRuleConfigs();

  // 3. Bank parser rules
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_parser_rules (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bank          TEXT NOT NULL,
      field         TEXT NOT NULL,
      rule_type     TEXT NOT NULL,
      pattern       TEXT,
      flags         TEXT NOT NULL DEFAULT 'i',
      capture_group INT  NOT NULL DEFAULT 1,
      enabled       BOOLEAN NOT NULL DEFAULT true,
      notes         TEXT,
      is_builtin    BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS priority    INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS source_path TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS category    TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS source_type TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS version     INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'active'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bpr_bank_field_priority_idx ON bank_parser_rules (bank, field, priority ASC)`);

  const countBpr = await pool.query('SELECT COUNT(*) FROM bank_parser_rules WHERE is_builtin = true');
  if (parseInt(countBpr.rows[0].count) === 0) {
    for (const r of BANK_PARSER_RULE_SEED) {
      await pool.query(
        `INSERT INTO bank_parser_rules (bank, field, rule_type, pattern, flags, capture_group, notes, is_builtin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [r.bank, r.field, r.rule_type, r.pattern ?? null, r.flags, r.capture_group, r.notes ?? null]
      );
    }
  }

  // 4. Cost control tables & Zero-cost control layer
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_api_usage (
      id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      provider         TEXT        NOT NULL,
      service          TEXT        NOT NULL,
      period_key       TEXT        NOT NULL,
      request_count    INTEGER     NOT NULL DEFAULT 0,
      estimated_units  INTEGER     NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS external_api_usage_key_idx ON external_api_usage (provider, service, period_key)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS geo_cache (
      cache_key         TEXT        PRIMARY KEY,
      query_normalized  TEXT        NOT NULL,
      provider          TEXT        NOT NULL,
      result_json       JSONB       NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS geo_cache_expires_idx ON geo_cache (expires_at)`);

  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validated_content_hash TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_prompt_version         TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validator_version      TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_provider               TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_model                  TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_status                 TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validated_at           TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS geo_status                 TEXT DEFAULT 'unresolved'`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS geo_cache_key              TEXT`);

  // 5. Offer workflow tables
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS change_status  TEXT NOT NULL DEFAULT 'NEW'`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS manual_override JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_candidate        JSONB`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_lifecycle_status TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_change_status    TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS pre_duplicate_change_status TEXT`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_validation       JSONB`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE offers ADD COLUMN IF NOT EXISTS rejected_at  TIMESTAMPTZ`);
  await pool.query(`UPDATE offers SET db_status = 'PUBLISHED' WHERE db_status = 'active'`);
  await pool.query(`UPDATE offers SET db_status = 'DISABLED' WHERE db_status = 'disabled'`);
  await pool.query(`UPDATE offers SET db_status = 'EXPIRED'  WHERE db_status = 'expired'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS offers_db_status_lifecycle_idx ON offers (db_status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_review_history (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      offer_id     UUID        REFERENCES offers(id) ON DELETE CASCADE,
      action       TEXT        NOT NULL,
      from_status  TEXT,
      to_status    TEXT,
      changes_json JSONB       DEFAULT '{}',
      reason       TEXT,
      actor        TEXT        DEFAULT 'admin',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS orh_offer_idx ON offer_review_history (offer_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_sync_runs (
      id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at     TIMESTAMPTZ,
      status          TEXT        NOT NULL DEFAULT 'running',
      approved_count  INTEGER     DEFAULT 0,
      published_count INTEGER     DEFAULT 0,
      updated_count   INTEGER     DEFAULT 0,
      unchanged_count INTEGER     DEFAULT 0,
      failed_count    INTEGER     DEFAULT 0,
      triggered_by    TEXT        DEFAULT 'admin'
    )
  `);

  // 6. Duplicate detection tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_duplicate_candidates (
      id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      offer_id           UUID        NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      candidate_offer_id UUID        NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
      score              INTEGER     NOT NULL,
      classification     TEXT        NOT NULL,
      reasons            JSONB       NOT NULL DEFAULT '[]',
      status             TEXT        NOT NULL DEFAULT 'PENDING',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at        TIMESTAMPTZ,
      reviewed_by        TEXT,
      CHECK (offer_id <> candidate_offer_id)
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS odc_pair_idx ON offer_duplicate_candidates (offer_id, candidate_offer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS odc_offer_idx ON offer_duplicate_candidates (offer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS odc_candidate_idx ON offer_duplicate_candidates (candidate_offer_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS odc_status_idx ON offer_duplicate_candidates (status)`);

  // 7. Parser golden cases
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parser_golden_cases (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bank            TEXT NOT NULL,
      offer_id        UUID REFERENCES offers(id) ON DELETE SET NULL,
      offer_unique_id TEXT,
      offer_title     TEXT,
      field           TEXT NOT NULL,
      expected_value  TEXT NOT NULL,
      raw_snippet     TEXT,
      notes           TEXT,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS pgc_bank_field_idx ON parser_golden_cases (bank, field)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS pgc_offer_idx ON parser_golden_cases (offer_id)`);

  const countPgc = await pool.query('SELECT COUNT(*) FROM parser_golden_cases');
  if (parseInt(countPgc.rows[0].count) === 0) {
    await seedGoldenCases();
  }
}
