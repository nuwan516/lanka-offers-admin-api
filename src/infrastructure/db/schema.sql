-- Lanka Offers — Neon Postgres Schema
-- Run via: ts-node -r tsconfig-paths/register src/infrastructure/db/migrate.ts

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bank          TEXT        NOT NULL,
  mode          TEXT        NOT NULL DEFAULT 'full',
  status        TEXT        NOT NULL DEFAULT 'running',  -- running | completed | failed
  triggered_by  TEXT        NOT NULL DEFAULT 'cli',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  offers_found  INTEGER     DEFAULT 0,
  offers_new    INTEGER     DEFAULT 0,
  offers_changed INTEGER    DEFAULT 0,
  offers_unchanged INTEGER  DEFAULT 0,
  errors        INTEGER     DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS offers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_id        TEXT        NOT NULL,
  bank             TEXT        NOT NULL,
  source_url       TEXT,
  title            TEXT        NOT NULL,
  category         TEXT,
  card_type        TEXT,
  merchant_name    TEXT,
  merchant_location TEXT,
  discount_percentage TEXT,
  valid_from       DATE,
  valid_to         DATE,
  card_eligibility JSONB       DEFAULT '{}',
  geo_locations    JSONB       DEFAULT '[]',
  raw_offer        JSONB       NOT NULL,
  content_hash     TEXT,
  llm_score        INTEGER,
  llm_valid        BOOLEAN,
  rule_passed      BOOLEAN     DEFAULT TRUE,
  rule_errors      JSONB       DEFAULT '[]',
  rule_warnings    JSONB       DEFAULT '[]',
  scrape_run_id    UUID        REFERENCES scrape_runs(id) ON DELETE SET NULL,
  db_status        TEXT        NOT NULL DEFAULT 'DISCOVERED',  -- lifecycle status, see offer_lifecycle.ts
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS offers_unique_id_idx ON offers (unique_id);
CREATE INDEX IF NOT EXISTS offers_bank_idx ON offers (bank);
CREATE INDEX IF NOT EXISTS offers_status_idx ON offers (db_status);
CREATE INDEX IF NOT EXISTS offers_valid_to_idx ON offers (valid_to);

-- ── Zero-cost control layer: LLM validation fingerprint ─────────────────────
-- Lets a later scrape decide whether an existing LLM validation can be
-- reused instead of calling the LLM again (see getLlmFingerprints()).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validated_content_hash TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_prompt_version         TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validator_version      TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_provider               TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_model                  TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_status                 TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS llm_validated_at           TIMESTAMPTZ;

-- ── Zero-cost control layer: geo persistence ─────────────────────────────────
ALTER TABLE offers ADD COLUMN IF NOT EXISTS geo_status    TEXT DEFAULT 'unresolved';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS geo_cache_key TEXT;

-- ── Staging / review / sync workflow ──────────────────────────────────────────
-- `db_status` is reused (extended) as the operational lifecycle status,
-- rather than adding a second overlapping status column. `change_status` is
-- a distinct, orthogonal per-scrape classification (NEW/CHANGED/etc).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS change_status  TEXT NOT NULL DEFAULT 'NEW';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS manual_override JSONB NOT NULL DEFAULT '{}';
-- A newer scraped candidate for an already-PUBLISHED offer is staged here
-- instead of overwriting the live published columns (Step 10).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_candidate        JSONB;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_lifecycle_status TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_change_status    TEXT;
-- Preserves the offer's NEW/CHANGED classification from the moment it was
-- flagged as a possible duplicate, so a NOT_DUPLICATE decision can restore
-- it instead of assuming NEW (Phase-1 readiness fix).
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pre_duplicate_change_status TEXT;
-- Rule/LLM outcome for the *pending* candidate — kept apart from the main
-- rule_passed/llm_score columns so those keep describing the currently
-- published content, not an unreviewed candidate awaiting approval.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS pending_validation       JSONB;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS rejected_at  TIMESTAMPTZ;

-- Pre-existing rows predate this workflow — they were already live, so
-- preserve current Flutter-visible behavior by treating them as published.
UPDATE offers SET db_status = 'PUBLISHED' WHERE db_status = 'active';
UPDATE offers SET db_status = 'DISABLED' WHERE db_status = 'disabled';
UPDATE offers SET db_status = 'EXPIRED'  WHERE db_status = 'expired';

CREATE INDEX IF NOT EXISTS offers_db_status_lifecycle_idx ON offers (db_status);

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
);

CREATE INDEX IF NOT EXISTS orh_offer_idx ON offer_review_history (offer_id);

CREATE TABLE IF NOT EXISTS offer_sync_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'running',  -- running | completed | failed
  approved_count  INTEGER     DEFAULT 0,
  published_count INTEGER     DEFAULT 0,
  updated_count   INTEGER     DEFAULT 0,
  unchanged_count INTEGER     DEFAULT 0,
  failed_count    INTEGER     DEFAULT 0,
  triggered_by    TEXT        DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS validation_reports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id      UUID        REFERENCES offers(id) ON DELETE CASCADE,
  unique_id     TEXT        NOT NULL,
  scrape_run_id UUID        REFERENCES scrape_runs(id) ON DELETE SET NULL,
  passed        BOOLEAN     NOT NULL,
  rule_errors   JSONB       DEFAULT '[]',
  rule_warnings JSONB       DEFAULT '[]',
  llm_score     INTEGER,
  llm_valid     BOOLEAN,
  llm_provider  TEXT,
  llm_model     TEXT,
  llm_reasoning TEXT,
  llm_issues    JSONB       DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS validation_offer_idx ON validation_reports (offer_id);
CREATE INDEX IF NOT EXISTS validation_run_idx ON validation_reports (scrape_run_id);

CREATE TABLE IF NOT EXISTS rule_configs (
  id         TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  severity   TEXT    NOT NULL DEFAULT 'error',
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

CREATE INDEX IF NOT EXISTS pgc_bank_field_idx ON parser_golden_cases (bank, field);
CREATE INDEX IF NOT EXISTS pgc_offer_idx ON parser_golden_cases (offer_id);

-- ── Zero-cost control layer: external API usage tracking ────────────────────
-- Minimal per-provider/service/month request counter — no billing math,
-- just enough for CostGuard to compare against a configured limit.
CREATE TABLE IF NOT EXISTS external_api_usage (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT        NOT NULL,          -- gemini | deepseek | google
  service          TEXT        NOT NULL,          -- gemini_llm | deepseek_llm | google_geocoding | google_places
  period_key       TEXT        NOT NULL,           -- 'YYYY-MM'
  request_count    INTEGER     NOT NULL DEFAULT 0,
  estimated_units  INTEGER     NOT NULL DEFAULT 0, -- e.g. tokens, if the provider reports them
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS external_api_usage_key_idx
  ON external_api_usage (provider, service, period_key);

-- ── Zero-cost control layer: persistent geo cache ────────────────────────────
-- Third tier below in-process memory and the local `.geo-cache/` file cache.
CREATE TABLE IF NOT EXISTS geo_cache (
  cache_key         TEXT        PRIMARY KEY,
  query_normalized  TEXT        NOT NULL,
  provider          TEXT        NOT NULL,          -- geocoding_api | places_text_search
  result_json       JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ                     -- NULL = never expires (direct geocodes)
);

CREATE INDEX IF NOT EXISTS geo_cache_expires_idx ON geo_cache (expires_at);

-- ── Duplicate detection candidates ────────────────────────────────────────────
-- offer_id is always the flagged/newer copy under review; candidate_offer_id
-- is the pre-existing match it collided with. The app always inserts with
-- offer_id/candidate_offer_id sorted (min id, max id) so a pair is stored
-- once regardless of comparison order.
CREATE TABLE IF NOT EXISTS offer_duplicate_candidates (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id           UUID        NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  candidate_offer_id UUID        NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  score              INTEGER     NOT NULL,
  classification     TEXT        NOT NULL,   -- EXACT_DUPLICATE | LIKELY_DUPLICATE | CROSS_BANK_SIMILAR | NOT_DUPLICATE
  reasons            JSONB       NOT NULL DEFAULT '[]',
  status             TEXT        NOT NULL DEFAULT 'PENDING', -- PENDING | CONFIRMED_DUPLICATE | NOT_DUPLICATE | IGNORED
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at        TIMESTAMPTZ,
  reviewed_by        TEXT,
  CHECK (offer_id <> candidate_offer_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS odc_pair_idx ON offer_duplicate_candidates (offer_id, candidate_offer_id);
CREATE INDEX IF NOT EXISTS odc_offer_idx ON offer_duplicate_candidates (offer_id);
CREATE INDEX IF NOT EXISTS odc_candidate_idx ON offer_duplicate_candidates (candidate_offer_id);
CREATE INDEX IF NOT EXISTS odc_status_idx ON offer_duplicate_candidates (status);

-- ── Phase 5: Merchant Intelligence & Location Scope ─────────────────────────
ALTER TABLE offers ADD COLUMN IF NOT EXISTS canonical_merchant TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS location_scope    TEXT DEFAULT 'UNRESOLVED';

CREATE INDEX IF NOT EXISTS offers_canonical_merchant_idx ON offers (canonical_merchant);
CREATE INDEX IF NOT EXISTS offers_location_scope_idx ON offers (location_scope);

-- ── High-Performance Production Query Indexes ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_offers_published_active 
  ON offers (valid_to, updated_at DESC) 
  WHERE db_status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_offers_published_bank 
  ON offers (bank, valid_to, updated_at DESC) 
  WHERE db_status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_offers_published_category 
  ON offers (category) 
  WHERE db_status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_offers_published_scope 
  ON offers (location_scope) 
  WHERE db_status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_offers_published_merchant 
  ON offers (canonical_merchant) 
  WHERE db_status = 'PUBLISHED';

CREATE INDEX IF NOT EXISTS idx_offers_geo_locations_gin 
  ON offers USING gin (geo_locations);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_offers_title_trgm 
  ON offers USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_offers_merchant_trgm 
  ON offers USING gin (merchant_name gin_trgm_ops);

