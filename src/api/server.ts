/**
 * Lanka Offers Admin API server.
 * Run: npx ts-node -r tsconfig-paths/register src/api/server.ts
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { pool } from '@/infrastructure/db/db-client';
import { getOfferById, getCurrentPeriodUsage } from '@/infrastructure/db/offer-repository';
import { getCostControlConfig, formatSafePolicySummary } from '@/config/cost-control';
import { evaluateCostGuard } from '@/infrastructure/cost-control/cost-guard';
import {
  getOfferWorkflow, getReviewHistory, computeEffectivePreview,
  saveManualCorrection, transitionOffer, syncApprovedOffer, bulkSyncApprovedOffers,
  getSyncPreview, WorkflowError,
} from '@/infrastructure/db/offer-workflow-repository';
import { PUBLIC_LIFECYCLE_STATUSES, LIFECYCLE_STATUSES, type OfferReviewAction } from '@/domain/offer-lifecycle';
import { buildOfferListQuery, sanitizePublicOffer } from '@/api/offer-query-scope';
import { computeThreeWayDiff } from '@/domain/offer-diff';
import {
  listDuplicateCandidates, getDuplicateCandidateById, reviewDuplicateCandidate,
  getDuplicateCandidatesForOffer, getDuplicateStats,
} from '@/infrastructure/db/duplicate-repository';
import type { DuplicateReviewStatus } from '@/domain/duplicate-types';
import {
  invalidateBankRulesCache,
  testRuleAgainstRaw,
  evaluateRulesForField,
  resolveSourcePath,
  areGoldenValuesEqual,
} from '@/banks/bank-rules-loader';
import type { BankParserRule } from '@/banks/bank-rules-loader';


import { correlationMiddleware } from './middleware/correlation';
import { errorHandler } from './middleware/error-handler';
import { seedGoldenCases } from '@/infrastructure/db/seed-golden-cases';
import { jobManager, VALID_BANKS } from './services/job-manager';
import { mergeDuplicateOffers } from './services/duplicate-merge-service';

const app = express();
const PORT = Number(process.env.API_PORT ?? 3001);

app.use(cors());
app.use(express.json());
app.use(correlationMiddleware);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ─── Validation rules definition ──────────────────────────────────────────────

const VALIDATION_RULES = [
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

// ─── Custom rules engine ─────────────────────────────────────────────────────

interface CustomRule {
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
}

function getValueAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    const m = part.match(/^(\w+)\[(\d+)\]$/);
    if (m) {
      current = (current as any)[m[1]]?.[parseInt(m[2])];
    } else {
      current = (current as any)[part];
    }
  }
  return current;
}

function evalCustomRule(rule: CustomRule, offer: Record<string, unknown>): { passed: boolean; message?: string } {
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
      // null/undefined = value not extracted — not a violation (use 'required' to enforce presence)
      if (v !== null && v !== undefined && Number(v) < c.min) return { passed: false, message: `${label} must be ≥ ${c.min} (got: ${v})` };
      break;
    case 'max':
      if (v !== null && v !== undefined && Number(v) > c.max) return { passed: false, message: `${label} must be ≤ ${c.max} (got: ${v})` };
      break;
    case 'between':
      // null/undefined = value not extracted — skip; only fail when a value exists but is out of range
      if (v !== null && v !== undefined && (Number(v) < c.min || Number(v) > c.max)) return { passed: false, message: `${label} must be between ${c.min} and ${c.max} (got: ${v})` };
      break;
    case 'matches':
      // null/undefined = value not extracted — skip; only validate when a value is present
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
      // value at field_path must be <= value at config.other_field (works for dates and numbers)
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
      // Array at field_path; at least one element's c.date_field must be >= today
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
      // At least one of the listed fields (config.fields[]) must be non-null/non-empty
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

// ─── Auto-init rule_configs table ────────────────────────────────────────────

// Built-in rules expressed as configurable DB entries (no TypeScript hardcoding needed)
// banks: null = all banks; string[] = only those banks
// Rules that only make sense for banks that reliably produce that field are scoped.
// HNB/BOC/Sampath/Peoples/Seylan/DFCC/ComBank reliably extract structured dates.
// NSB/PABC extract dates from loose prose — validFrom is often null.
// NDB uses a headless browser, dates vary.
// PABC/NSB rarely have merchant.location populated.
// Transaction ranges only meaningful for banks whose detail pages state min/max spend.
const DATE_BANKS  = ['hnb', 'boc', 'sampath', 'peoples', 'seylan', 'dfcc', 'combank'];
const TX_BANKS    = ['hnb', 'boc', 'sampath', 'peoples', 'ndb', 'seylan', 'dfcc', 'combank'];
const LOC_BANKS   = ['hnb', 'boc', 'sampath', 'peoples', 'ndb', 'seylan', 'dfcc', 'combank'];

const BUILTIN_RULE_SEED = [
  // Required fields — all parsers always set these, universal
  { builtin_id: 'required_uniqueId',       banks: null,       name: 'Unique ID required',              description: 'uniqueId must be present',                                     group_name: 'Required fields',    severity: 'error',   field_path: 'uniqueId',                          operator: 'required',             config: {} },
  { builtin_id: 'required_source',         banks: null,       name: 'Source required',                 description: 'source must be present',                                       group_name: 'Required fields',    severity: 'error',   field_path: 'source',                            operator: 'required',             config: {} },
  { builtin_id: 'required_title',          banks: null,       name: 'Title non-empty',                 description: 'title must be non-empty',                                      group_name: 'Required fields',    severity: 'error',   field_path: 'title',                             operator: 'not_empty',            config: {} },
  { builtin_id: 'required_scrapedAt',      banks: null,       name: 'ScrapedAt required',              description: 'scrapedAt must be present',                                    group_name: 'Required fields',    severity: 'error',   field_path: 'scrapedAt',                         operator: 'required',             config: {} },
  // Date quality — only for banks that reliably extract structured validFrom/validTo
  { builtin_id: 'date_validFrom_format',   banks: DATE_BANKS, name: 'ValidFrom date format',           description: 'validFrom must be YYYY-MM-DD (banks with structured date fields)',group_name: 'Dates',              severity: 'error',   field_path: 'validityPeriods[0].validFrom',       operator: 'matches',              config: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  { builtin_id: 'date_validTo_format',     banks: DATE_BANKS, name: 'ValidTo date format',             description: 'validTo must be YYYY-MM-DD (banks with structured date fields)',  group_name: 'Dates',              severity: 'error',   field_path: 'validityPeriods[0].validTo',         operator: 'matches',              config: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
  { builtin_id: 'date_range_order',        banks: null,       name: 'ValidFrom ≤ ValidTo',             description: 'validFrom must not be after validTo (skips null values)',         group_name: 'Dates',              severity: 'warning', field_path: 'validityPeriods[0].validFrom',       operator: 'lte_field',            config: { other_field: 'validityPeriods[0].validTo' } },
  { builtin_id: 'offer_expired',           banks: null,       name: 'Offer not fully expired',         description: 'At least one validity period must not be in the past',           group_name: 'Dates',              severity: 'error',   field_path: 'validityPeriods',                   operator: 'array_any_not_expired',config: { date_field: 'validTo' } },
  // Offer quality — discount range only validates when a value is present (null = not extracted = ok)
  { builtin_id: 'discount_range',          banks: null,       name: 'Discount 0–100%',                 description: 'Discount percentage must be in 0–100 range (null = skip)',       group_name: 'Offer quality',      severity: 'warning', field_path: 'offer.discountPercentage',           operator: 'between',              config: { min: 0, max: 100 } },
  { builtin_id: 'category_present',        banks: null,       name: 'Category non-empty',              description: 'category must not be empty',                                   group_name: 'Offer quality',      severity: 'warning', field_path: 'category',                          operator: 'not_empty',            config: {} },
  // Merchant — name always set by parsers; location only for banks whose scrapers extract it
  { builtin_id: 'merchant_name',           banks: null,       name: 'Merchant name non-empty',         description: 'Merchant name must not be empty',                              group_name: 'Merchant',           severity: 'warning', field_path: 'merchant.name',                     operator: 'not_empty',            config: {} },
  { builtin_id: 'merchant_location',       banks: LOC_BANKS,  name: 'Merchant has location',           description: 'merchant.location or merchant.addresses must have a value (banks that extract location)', group_name: 'Merchant', severity: 'warning', field_path: 'merchant.location', operator: 'has_value', config: { fields: ['merchant.location', 'merchant.addresses[0]'] } },
  // Transaction range — only for banks whose detail pages state min/max spend values
  { builtin_id: 'transaction_min',         banks: TX_BANKS,   name: 'Transaction min ≥ 0',             description: 'Transaction minimum cannot be negative (null = not stated = ok)', group_name: 'Transaction range',  severity: 'error',   field_path: 'transactionRange.min',              operator: 'min',                  config: { min: 0 } },
  { builtin_id: 'transaction_max',         banks: TX_BANKS,   name: 'Transaction max ≥ 0',             description: 'Transaction maximum cannot be negative (null = not stated = ok)', group_name: 'Transaction range',  severity: 'error',   field_path: 'transactionRange.max',              operator: 'min',                  config: { min: 0 } },
  { builtin_id: 'transaction_range_order', banks: TX_BANKS,   name: 'Transaction min ≤ max',           description: 'Transaction min must not exceed transaction max (skips null)',  group_name: 'Transaction range',  severity: 'warning', field_path: 'transactionRange.min',              operator: 'lte_field',            config: { other_field: 'transactionRange.max' } },
  // Integrity — content hash always 64-char hex (all parsers), universal
  { builtin_id: 'content_hash',            banks: null,       name: 'Content hash is SHA-256',         description: 'contentHash must be a 64-character sha256 hex string',          group_name: 'Integrity',          severity: 'warning', field_path: 'contentHash',                       operator: 'matches',              config: { pattern: '^[a-f0-9]{64}$' } },
];

async function initRuleConfigs() {
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
  // Migrate existing custom_rules table if it predates the is_builtin / banks columns
  await pool.query(`ALTER TABLE custom_rules ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE custom_rules ADD COLUMN IF NOT EXISTS builtin_id TEXT`);
  // banks TEXT[] — null means all banks; non-null means only those banks
  await pool.query(`ALTER TABLE custom_rules ADD COLUMN IF NOT EXISTS banks TEXT[]`);

  // Seed built-in rules — insert if not yet present, identified by builtin_id
  for (const r of BUILTIN_RULE_SEED) {
    const exists = await pool.query('SELECT id FROM custom_rules WHERE builtin_id = $1', [r.builtin_id]);
    if (!exists.rows.length) {
      await pool.query(
        `INSERT INTO custom_rules (name, description, group_name, severity, field_path, operator, config, is_builtin, builtin_id, banks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)`,
        [r.name, r.description, r.group_name, r.severity, r.field_path, r.operator, JSON.stringify(r.config), r.builtin_id, r.banks]
      );
    } else {
      // Keep banks column in sync when seed definition changes
      await pool.query(
        `UPDATE custom_rules SET banks = $1 WHERE builtin_id = $2 AND is_builtin = true`,
        [r.banks, r.builtin_id]
      );
    }
  }

  // Keep rule_configs seeded for backward compat
  for (const rule of VALIDATION_RULES) {
    await pool.query(
      `INSERT INTO rule_configs (id, enabled, severity) VALUES ($1, true, $2) ON CONFLICT (id) DO NOTHING`,
      [rule.id, rule.severity]
    );
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', asyncHandler(async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
}));

// ─── Cost Control ─────────────────────────────────────────────────────────────

app.get('/api/cost-control/status', asyncHandler(async (_req, res) => {
  const config = getCostControlConfig();
  const usageRows = await getCurrentPeriodUsage();
  const usageByService = new Map(usageRows.map((r) => [r.service, r.requestCount]));

  const services = Object.values(config.services).map((svc) => {
    const used = usageByService.get(svc.service) ?? 0;
    const decision = evaluateCostGuard(svc, used);
    return {
      service: svc.service,
      used,
      limit: svc.limit,
      percentage: decision.percentage,
      state: decision.verdict,
      enabled: svc.enabled,
      reason: decision.reason,
    };
  });

  res.json({
    services,
    policy: {
      llmMode: config.llm.mode,
      llmPrimaryProvider: config.llm.primaryProvider,
      llmFallbackProvider: config.llm.fallbackProvider,
      allowPaidLlmFallback: config.llm.allowPaidFallback,
      llmValidationEnabled: config.llm.validationEnabled,
      geoProviderCallsEnabled: config.geoProviderCallsEnabled,
      placesEnrichmentEnabled: config.placesEnrichmentEnabled,
    },
    periodKey: usageRows[0]?.periodKey ?? null,
  });
}));

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get('/api/stats', asyncHandler(async (_req, res) => {
  const [offerStats, runStats, validationStats] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE db_status = 'PUBLISHED') AS active_offers,
        COUNT(*) AS total_offers,
        COUNT(*) FILTER (WHERE llm_valid = true) AS llm_valid,
        COUNT(*) FILTER (WHERE rule_passed = false) AS rule_failed,
        COUNT(*) FILTER (WHERE llm_score IS NOT NULL) AS llm_scored,
        ROUND(AVG(llm_score) FILTER (WHERE llm_score IS NOT NULL)) AS avg_llm_score,
        COUNT(DISTINCT bank) AS banks_with_data,
        COUNT(*) FILTER (WHERE db_status IN ('DISCOVERED', 'PENDING_REVIEW', 'REVIEW_REQUIRED') OR pending_candidate IS NOT NULL) AS pending_review,
        COUNT(*) FILTER (WHERE db_status = 'APPROVED') AS pending_sync,
        COUNT(*) FILTER (WHERE geo_status = 'unresolved' OR ((geo_locations IS NULL OR geo_locations = '[]'::jsonb) AND merchant_location IS NOT NULL)) AS unresolved_geo
      FROM offers
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'running') AS running_jobs,
        COUNT(*) FILTER (WHERE status = 'failed' AND started_at > NOW() - INTERVAL '24h') AS failed_today,
        COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24h') AS runs_today,
        COALESCE(SUM(offers_found) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS scraped_today,
        COALESCE(SUM(offers_new) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS new_today,
        COALESCE(SUM(offers_changed) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS changed_today,
        MAX(started_at) AS last_run_at
      FROM scrape_runs
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE passed = false) AS validation_failures,
        COUNT(*) AS total_validated
      FROM validation_reports
    `),
  ]);
  res.json({
    offers: offerStats.rows[0],
    runs: runStats.rows[0],
    validation: validationStats.rows[0],
    duplicates: await getDuplicateStats(),
  });
}));

// ─── Offers ───────────────────────────────────────────────────────────────────

// `scope=admin` is how the trusted Admin app opts into seeing every
// lifecycle state. Any other caller (the public Flutter app included) only
// ever sees PUBLISHED offers — scraping/staging must never be publicly
// visible (Step 3/19).
app.get('/api/offers', asyncHandler(async (req, res) => {
  const { bank, status, limit = '50', offset = '0', search, scope, locationScope, merchant } = req.query as Record<string, string | undefined>;
  const q = buildOfferListQuery({ bank, status, search, scope, locationScope, merchant });

  const lim = Math.min(parseInt(limit), 500);
  const off = parseInt(offset);
  let i = q.nextParamIndex;

  const [rows, countRes] = await Promise.all([
    pool.query(
      // Admin gets the full row. Public callers get a field-restricted SELECT
      // so internal operational data (LLM reasoning, rule diagnostics, pending
      // lifecycle info, scrape run IDs) is never present in the payload at all,
      // rather than relying purely on post-processing sanitization.
      q.isAdmin
        ? `SELECT id, unique_id, bank, title, category, card_type, merchant_name,
              merchant_location, canonical_merchant, location_scope, discount_percentage, valid_from, valid_to, llm_score, llm_valid,
              rule_passed, rule_errors, rule_warnings, db_status, change_status,
              pending_candidate IS NOT NULL AS has_pending_candidate, pending_lifecycle_status,
              created_at, updated_at, scrape_run_id, content_hash, geo_locations, geo_status
           FROM offers ${q.whereSql}
           ORDER BY updated_at DESC
           LIMIT $${i++} OFFSET $${i}`
        : `SELECT id, unique_id, bank, source_url, title, category, card_type,
              merchant_name, merchant_location, canonical_merchant, location_scope,
              discount_percentage, valid_from, valid_to, card_eligibility,
              geo_locations, geo_status, raw_offer, rule_passed, db_status,
              created_at, updated_at
           FROM offers ${q.whereSql}
           ORDER BY updated_at DESC
           LIMIT $${i++} OFFSET $${i}`,
      [...q.params, lim, off]
    ),
    pool.query(`SELECT COUNT(*) FROM offers ${q.whereSql}`, q.params),
  ]);

  res.json({ items: rows.rows, total: parseInt(countRes.rows[0].count), limit: lim, offset: off });
}));

// Merchant Intelligence: aggregation of merchants with canonical identities, aliases & offer stats
app.get('/api/merchants', asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT
      COALESCE(canonical_merchant, merchant_name) AS name,
      canonical_merchant,
      COUNT(*) AS offer_count,
      COUNT(DISTINCT bank) AS bank_count,
      ARRAY_AGG(DISTINCT merchant_name) FILTER (WHERE merchant_name IS NOT NULL) AS observed_names,
      ARRAY_AGG(DISTINCT location_scope) FILTER (WHERE location_scope IS NOT NULL) AS observed_scopes
    FROM offers
    WHERE db_status = 'PUBLISHED'
      AND COALESCE(canonical_merchant, merchant_name) IS NOT NULL
      AND COALESCE(canonical_merchant, merchant_name) <> ''
    GROUP BY COALESCE(canonical_merchant, merchant_name), canonical_merchant
    ORDER BY offer_count DESC
    LIMIT 100;
  `);
  res.json({ items: result.rows });
}));


app.get('/api/offers/:id', asyncHandler(async (req, res) => {
  const isAdmin = req.query.scope === 'admin';
  const offer = await getOfferById(String(req.params['id']));
  if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
  if (!isAdmin && !(PUBLIC_LIFECYCLE_STATUSES as string[]).includes(offer.db_status)) {
    res.status(404).json({ error: 'Offer not found' }); return;
  }
  res.json(isAdmin ? offer : sanitizePublicOffer(offer));
}));

// Direct status override (superuser shortcut) — still routed through the
// same transition/history machinery used by the review workspace.
app.patch('/api/offers/:id', asyncHandler(async (req, res) => {
  const { db_status } = req.body as { db_status?: string };
  if (db_status && !(LIFECYCLE_STATUSES as string[]).includes(db_status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${LIFECYCLE_STATUSES.join(', ')}` }); return;
  }
  const result = await pool.query(
    `UPDATE offers SET db_status = COALESCE($1, db_status), updated_at = NOW() WHERE id = $2 RETURNING id, db_status`,
    [db_status, req.params.id]
  );
  if (!result.rows.length) { res.status(404).json({ error: 'Offer not found' }); return; }
  res.json(result.rows[0]);
}));

// ─── Offer review workflow (staging / correction / approval) ────────────────

app.get('/api/offers/:id/review', asyncHandler(async (req, res) => {
  const row = await getOfferWorkflow(String(req.params.id));
  if (!row) { res.status(404).json({ error: 'Offer not found' }); return; }
  const [history, duplicates, valReport] = await Promise.all([
    getReviewHistory(row.id),
    getDuplicateCandidatesForOffer(row.id),
    pool.query(`SELECT * FROM validation_reports WHERE offer_id = $1 ORDER BY created_at DESC LIMIT 1`, [row.id]),
  ]);

  const effectiveOffer = computeEffectivePreview(row);
  const published = row.pending_candidate ? row.raw_offer : null;
  const candidate = row.pending_candidate ?? row.raw_offer;
  const diff = computeThreeWayDiff(published, candidate, effectiveOffer, row.manual_override, undefined, true);

  res.json({
    offer: row,
    rawOffer: row.raw_offer,
    pendingCandidate: row.pending_candidate,
    pendingValidation: (row as Record<string, unknown>).pending_validation ?? null,
    validationReport: valReport.rows[0] ?? null,
    manualOverride: row.manual_override,
    effectiveOffer,
    diff,
    duplicates,
    history,
  });
}));

app.post('/api/offers/:id/correction', asyncHandler(async (req, res) => {
  const { override, reason, expectedUpdatedAt } = req.body as {
    override: Record<string, unknown>;
    reason?: string;
    expectedUpdatedAt?: string;
  };
  try {
    const result = await saveManualCorrection(String(req.params.id), override ?? {}, 'admin', reason ?? null, expectedUpdatedAt);
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      const isConflict = e.message.includes('Concurrent modification conflict');
      res.status(isConflict ? 409 : 404).json({ error: e.message });
      return;
    }
    throw e;
  }
}));

const REVIEW_ACTIONS: OfferReviewAction[] = [
  'APPROVE', 'APPROVE_WITH_CORRECTIONS', 'REJECT', 'SEND_BACK', 'DISABLE', 'PUBLISH', 'UNPUBLISH',
];

app.post('/api/offers/:id/transition', asyncHandler(async (req, res) => {
  const { action, reason, correction, expectedUpdatedAt } = req.body as {
    action: string;
    reason?: string;
    correction?: Record<string, unknown>;
    expectedUpdatedAt?: string;
  };
  if (!REVIEW_ACTIONS.includes(action as OfferReviewAction)) {
    res.status(400).json({ error: `Invalid action. Must be one of: ${REVIEW_ACTIONS.join(', ')}` }); return;
  }
  try {
    const result = await transitionOffer(String(req.params.id), action as OfferReviewAction, 'admin', reason ?? null, correction, expectedUpdatedAt);
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) { res.status(409).json({ error: e.message }); return; }
    throw e;
  }
}));

app.get('/api/offers/:id/history', asyncHandler(async (req, res) => {
  res.json({ items: await getReviewHistory(String(req.params.id)) });
}));

// ─── Duplicate review (Part 9/13) ────────────────────────────────────────────

const DUPLICATE_REVIEW_STATUSES: DuplicateReviewStatus[] = ['CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'IGNORED'];

app.get('/api/duplicates', asyncHandler(async (req, res) => {
  const { bank, classification, status, minimum_score, limit, offset } = req.query as Record<string, string | undefined>;
  const items = await listDuplicateCandidates({
    bank, classification, status,
    minimumScore: minimum_score ? parseInt(minimum_score, 10) : undefined,
    limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });
  res.json({ items });
}));

app.get('/api/duplicates/stats', asyncHandler(async (_req, res) => {
  res.json(await getDuplicateStats());
}));

app.get('/api/duplicates/:id', asyncHandler(async (req, res) => {
  const row = await getDuplicateCandidateById(String(req.params.id));
  if (!row) { res.status(404).json({ error: 'Duplicate candidate not found' }); return; }
  res.json(row);
}));

app.post('/api/duplicates/:id/review', asyncHandler(async (req, res) => {
  const { decision, reason } = req.body as { decision: string; reason?: string };
  if (!DUPLICATE_REVIEW_STATUSES.includes(decision as DuplicateReviewStatus)) {
    res.status(400).json({ error: `Invalid decision. Must be one of: ${DUPLICATE_REVIEW_STATUSES.join(', ')}` }); return;
  }
  try {
    const result = await reviewDuplicateCandidate(String(req.params.id), decision as DuplicateReviewStatus, 'admin', reason ?? null);
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) { res.status(404).json({ error: e.message }); return; }
    throw e;
  }
}));

app.post('/api/duplicates/merge', asyncHandler(async (req, res) => {
  const { canonicalOfferId, duplicateOfferId, reason } = req.body as {
    canonicalOfferId: string;
    duplicateOfferId: string;
    reason?: string;
  };
  try {
    const result = await mergeDuplicateOffers({
      canonicalOfferId,
      duplicateOfferId,
      reason,
      actor: 'admin',
    });
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
}));

app.post('/api/duplicates/:id/merge', asyncHandler(async (req, res) => {
  const duplicateCandidate = await getDuplicateCandidateById(String(req.params.id));
  if (!duplicateCandidate) {
    res.status(404).json({ error: 'Duplicate candidate not found' });
    return;
  }
  const { canonicalOfferId, reason } = req.body as { canonicalOfferId?: string; reason?: string };
  const targetCanonical = canonicalOfferId ?? duplicateCandidate.offer_id;
  const targetDuplicate = targetCanonical === duplicateCandidate.offer_id ? duplicateCandidate.candidate_offer_id : duplicateCandidate.offer_id;

  try {
    const result = await mergeDuplicateOffers({
      canonicalOfferId: targetCanonical,
      duplicateOfferId: targetDuplicate,
      reason: reason ?? `Merged via duplicate candidate ${req.params.id}`,
      actor: 'admin',
    });
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
}));

// ─── Sync / publish ───────────────────────────────────────────────────────────

app.get('/api/sync/preview', asyncHandler(async (_req, res) => {
  res.json(await getSyncPreview());
}));

app.post('/api/sync/:id', asyncHandler(async (req, res) => {
  res.json(await syncApprovedOffer(String(req.params.id)));
}));

app.post('/api/sync', asyncHandler(async (_req, res) => {
  res.json(await bulkSyncApprovedOffers('admin'));
}));

app.get('/api/sync/runs', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20')), 100);
  const rows = await pool.query(`SELECT * FROM offer_sync_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
  res.json({ items: rows.rows });
}));

// ─── Scrape Runs ──────────────────────────────────────────────────────────────

app.get('/api/runs', asyncHandler(async (req, res) => {
  const { bank, status, limit = '50' } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (bank) { conditions.push(`bank = $${i++}`); params.push(bank); }
  if (status) { conditions.push(`status = $${i++}`); params.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT * FROM scrape_runs ${where} ORDER BY started_at DESC LIMIT $${i}`,
    [...params, parseInt(limit)]
  );
  res.json({ items: result.rows, total: result.rows.length });
}));

app.get('/api/runs/:id', asyncHandler(async (req, res) => {
  const run = await pool.query('SELECT * FROM scrape_runs WHERE id = $1', [req.params.id]);
  if (!run.rows.length) { res.status(404).json({ error: 'Run not found' }); return; }

  const offers = await pool.query(
    `SELECT id, unique_id, title, bank, merchant_name, llm_score, rule_passed, db_status, created_at
     FROM offers WHERE scrape_run_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json({ run: run.rows[0], offers: offers.rows });
}));

// ─── Validation Reports ───────────────────────────────────────────────────────

app.get('/api/validation', asyncHandler(async (req, res) => {
  const { limit = '50', passed } = req.query as Record<string, string>;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (passed !== undefined) { conditions.push(`passed = $${i++}`); params.push(passed === 'true'); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT vr.*, o.title, o.bank, o.merchant_name
     FROM validation_reports vr
     JOIN offers o ON o.id = vr.offer_id
     ${where}
     ORDER BY vr.created_at DESC
     LIMIT $${i}`,
    [...params, parseInt(limit)]
  );
  res.json({ items: result.rows });
}));

// ─── Rules CRUD ───────────────────────────────────────────────────────────────

app.get('/api/rules', asyncHandler(async (_req, res) => {
  // Return built-in rules from custom_rules table (is_builtin=true), mapped to the legacy shape for backward compat
  const result = await pool.query('SELECT * FROM custom_rules WHERE is_builtin = true ORDER BY created_at');
  const items = result.rows.map((r: any) => ({
    id: r.builtin_id ?? r.id,
    field: r.field_path,
    description: r.description ?? r.name,
    severity: r.severity,
    group: r.group_name,
    enabled: r.enabled,
    notes: r.notes,
    updated_at: r.updated_at,
  }));
  res.json({ items, total: items.length });
}));

app.patch('/api/rules/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled, severity, notes } = req.body as {
    enabled?: boolean; severity?: string; notes?: string;
  };

  if (!VALIDATION_RULES.find(r => r.id === id)) {
    res.status(404).json({ error: `Unknown rule: ${id}` }); return;
  }

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
  res.json(result.rows[0]);
}));

// ─── Custom rules CRUD ────────────────────────────────────────────────────────

app.get('/api/custom-rules', asyncHandler(async (_req, res) => {
  const result = await pool.query('SELECT * FROM custom_rules ORDER BY created_at');
  res.json({ items: result.rows, total: result.rows.length });
}));

app.post('/api/custom-rules', asyncHandler(async (req, res) => {
  const { name, description, group_name, severity, field_path, operator, config, notes, banks } = req.body as Record<string, any>;
  if (!name || !field_path || !operator) {
    res.status(400).json({ error: 'name, field_path, and operator are required' }); return;
  }
  // banks: null = all banks, string[] = scoped list
  const banksVal = Array.isArray(banks) && banks.length > 0 ? banks : null;
  const result = await pool.query(
    `INSERT INTO custom_rules (name, description, group_name, severity, field_path, operator, config, notes, banks)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [name, description ?? null, group_name ?? 'Custom', severity ?? 'warning', field_path, operator, JSON.stringify(config ?? {}), notes ?? null, banksVal]
  );
  res.status(201).json(result.rows[0]);
}));

app.put('/api/custom-rules/:id', asyncHandler(async (req, res) => {
  const { name, description, group_name, severity, enabled, field_path, operator, config, notes, banks } = req.body as Record<string, any>;
  // banks key present in body = explicit update; absent = leave unchanged
  const banksUpdate = 'banks' in req.body
    ? (Array.isArray(banks) && banks.length > 0 ? banks : null)
    : undefined;
  const result = await pool.query(
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
    [name, description, group_name, severity, enabled, field_path, operator,
     config !== undefined ? JSON.stringify(config) : null, notes,
     banksUpdate ?? null, banksUpdate !== undefined, req.params.id]
  );
  if (!result.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  res.json(result.rows[0]);
}));

app.delete('/api/custom-rules/:id', asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM custom_rules WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  res.json({ deleted: result.rows[0].id });
}));

// Test a custom rule against recent DB offers
app.post('/api/custom-rules/:id/test', asyncHandler(async (req, res) => {
  const ruleRow = await pool.query('SELECT * FROM custom_rules WHERE id = $1', [req.params.id]);
  if (!ruleRow.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  const rule: CustomRule = { ...ruleRow.rows[0], config: ruleRow.rows[0].config ?? {} };

  const { bank, limit = '50' } = req.query as Record<string, string>;
  const conditions = bank ? ['bank = $1'] : [];
  const params: unknown[] = bank ? [bank] : [];
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const offers = await pool.query(
    `SELECT id, unique_id, bank, title, raw_offer FROM offers ${where} ORDER BY updated_at DESC LIMIT $${params.length + 1}`,
    [...params, parseInt(limit)]
  );

  let passed = 0, failed = 0, skipped = 0;
  const failures: { unique_id: string; bank: string; title: string; message: string }[] = [];

  for (const row of offers.rows) {
    const offerBank: string = row.bank ?? '';
    if (rule.banks !== null && Array.isArray(rule.banks) && !rule.banks.includes(offerBank)) {
      skipped++;
      continue;
    }
    const r = evalCustomRule(rule, row.raw_offer ?? {});
    if (r.passed) { passed++; }
    else {
      failed++;
      if (failures.length < 20) {
        failures.push({ unique_id: row.unique_id, bank: row.bank, title: row.title ?? '', message: r.message ?? 'failed' });
      }
    }
  }

  res.json({ total: offers.rows.length, passed, failed, skipped, failures });
}));

// ─── Backtest ─────────────────────────────────────────────────────────────────

app.get('/api/backtest', asyncHandler(async (_req, res) => {
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

  res.json({
    errors: errorStats.rows,
    warnings: warnStats.rows,
    byBank: bankStats.rows,
    summary: summary.rows[0],
  });
}));

// ─── Revalidate offers ────────────────────────────────────────────────────────

app.post('/api/revalidate', asyncHandler(async (req, res) => {
  const { bank, offerId } = { ...req.query, ...req.body } as Record<string, string>;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let pIdx = 1;
  if (bank) { conditions.push(`bank = $${pIdx++}`); params.push(bank); }
  if (offerId) { conditions.push(`(id::text = $${pIdx} OR unique_id = $${pIdx})`); params.push(offerId); pIdx++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await pool.query(
    `SELECT id, bank, raw_offer FROM offers ${where} LIMIT 5000`,
    params
  );

  // All rules (built-in seeded + custom) are now in custom_rules table — no TypeScript OfferValidator needed
  const allRulesResult = await pool.query('SELECT * FROM custom_rules WHERE enabled = true ORDER BY is_builtin DESC, created_at');
  const allRules: CustomRule[] = allRulesResult.rows.map((r: any) => ({ ...r, config: r.config ?? {} }));
  let passed = 0, failed = 0, errors = 0;

  for (const row of rows.rows) {
    try {
      const offerData: Record<string, unknown> = row.raw_offer ?? {};
      const offerBank: string = (offerData.source as string) ?? row.bank ?? '';
      const ruleErrors: Array<{ field: string; message: string; severity: string }> = [];
      const ruleWarnings: Array<{ field: string; message: string; severity: string }> = [];

      for (const rule of allRules) {
        // Skip rule if it's scoped to specific banks and this offer's bank isn't in the list
        if (rule.banks !== null && Array.isArray(rule.banks) && !rule.banks.includes(offerBank)) continue;
        const r = evalCustomRule(rule, offerData);
        if (!r.passed) {
          const entry = { field: rule.field_path, message: r.message ?? rule.name, severity: rule.severity };
          if (rule.severity === 'error') ruleErrors.push(entry);
          else ruleWarnings.push(entry);
        }
      }

      const valid = ruleErrors.length === 0;
      await pool.query(
        `UPDATE offers SET rule_passed = $1, rule_errors = $2, rule_warnings = $3, updated_at = NOW() WHERE id = $4`,
        [valid, JSON.stringify(ruleErrors), JSON.stringify(ruleWarnings), row.id]
      );
      if (valid) passed++; else failed++;
    } catch {
      errors++;
    }
  }

  res.json({ total: rows.rows.length, passed, failed, errors });
}));

// ─── Banks summary ────────────────────────────────────────────────────────────

app.get('/api/banks', asyncHandler(async (_req, res) => {
  const result = await pool.query(`
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
  res.json({ items: result.rows });
}));

// ─── Bank parser rules ────────────────────────────────────────────────────────

const BANK_PARSER_RULE_SEED = [
  // HNB — HTML/JSON hybrid, text extraction via regex
  { bank: 'hnb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+?)(?=\\s*(?:Offer|Period|Eligibility|Contact|Location|Special|General|$))', flags: 'i', capture_group: 1, notes: 'Extracts merchant name from "Merchant: ..." block in offer text' },
  { bank: 'hnb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'Extracts discount % e.g. "20% off"' },
  { bank: 'hnb', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?)\\s*(?:to|[-–])\\s*Rs\\.?\\s*[\\d,.]+', flags: 'i', capture_group: 1, notes: 'Extracts minimum spend e.g. "Rs. 5,000 to Rs. 50,000"' },
  { bank: 'hnb', field: 'transaction_max', rule_type: 'regex', pattern: 'Rs\\.?\\s*[\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?\\s*(?:to|[-–])\\s*Rs\\.?\\s*([\\d,.]+(?:\\s*(?:Million|Lakh|Mn|k|m))?)', flags: 'i', capture_group: 1, notes: 'Extracts maximum spend from same range pattern' },
  { bank: 'hnb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit card,debit card,visa,mastercard,amex,american express', flags: 'i', capture_group: 0, notes: 'Keywords to detect eligible card types' },
  { bank: 'hnb', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,advance booking,prior reservation', flags: 'i', capture_group: 0, notes: 'Keywords indicating booking is required' },
  { bank: 'hnb', field: 'installment_rate', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s+\\d+\\s*months', flags: 'i', capture_group: 1, notes: 'Extracts installment interest rate' },

  // BOC — HTML scrape, title is merchant name, offerValue may have %
  { bank: 'boc', field: 'merchant_name', rule_type: 'field_map', pattern: 'title', flags: '', capture_group: 0, notes: 'BOC uses the offer title as merchant name' },
  { bank: 'boc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%', flags: 'i', capture_group: 1, notes: 'Extracts % from offerValue or description' },
  { bank: 'boc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: 'BOC card type keywords' },
  { bank: 'boc', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,prior booking', flags: 'i', capture_group: 0, notes: 'BOC booking requirement keywords' },

  // Sampath — JSON API, fields come pre-structured
  { bank: 'sampath', field: 'merchant_name', rule_type: 'field_map', pattern: 'company_name', flags: '', capture_group: 0, notes: 'Sampath API provides company_name; fallback: merchant_name or title' },
  { bank: 'sampath', field: 'discount_pct', rule_type: 'field_map', pattern: 'short_discount', flags: '', capture_group: 0, notes: 'Sampath provides discount value in short_discount field' },
  { bank: 'sampath', field: 'card_types', rule_type: 'field_map', pattern: 'eligible_cards', flags: '', capture_group: 0, notes: 'Sampath eligible_cards is an array field' },
  { bank: 'sampath', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,advance booking', flags: 'i', capture_group: 0, notes: 'Sampath booking requirement keywords in promotion_details' },
  { bank: 'sampath', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|min)', flags: 'i', capture_group: 1, notes: 'Minimum spend from promotion text' },

  // NDB — HTML scrape
  { bank: 'ndb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'NDB offer text often has "Merchant: ..." label' },
  { bank: 'ndb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'NDB discount percentage' },
  { bank: 'ndb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'NDB card type keywords' },
  { bank: 'ndb', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+(?:,\\d{3})*)\\s*(?:and above|minimum|or above|\\+)', flags: 'i', capture_group: 1, notes: 'Minimum transaction amount' },
  { bank: 'ndb', field: 'booking_required', rule_type: 'keyword_list', pattern: 'reservation,booking,prior booking,advance', flags: 'i', capture_group: 0, notes: 'Booking requirement keywords' },

  // DFCC — HTML scrape
  { bank: 'dfcc', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'DFCC merchant name label in text' },
  { bank: 'dfcc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'DFCC discount percentage' },
  { bank: 'dfcc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'DFCC card type keywords' },
  { bank: 'dfcc', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or more)', flags: 'i', capture_group: 1, notes: 'Minimum transaction' },

  // SEYLAN — HTML scrape
  { bank: 'seylan', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'Seylan merchant label extraction' },
  { bank: 'seylan', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'Seylan discount percentage' },
  { bank: 'seylan', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'Seylan card type keywords' },
  { bank: 'seylan', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above)', flags: 'i', capture_group: 1, notes: 'Seylan minimum spend' },

  // PEOPLES — HTML scrape
  { bank: 'peoples', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: "People's Bank merchant label" },
  { bank: 'peoples', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: "People's Bank discount %" },
  { bank: 'peoples', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: "People's Bank card types" },

  // PABC — HTML scrape
  { bank: 'pabc', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'PABC merchant label extraction' },
  { bank: 'pabc', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'PABC discount percentage' },
  { bank: 'pabc', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'PABC card type keywords' },
  { bank: 'pabc', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or above)', flags: 'i', capture_group: 1, notes: 'PABC minimum transaction amount' },

  // NSB — HTML scrape
  { bank: 'nsb', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'NSB merchant label extraction' },
  { bank: 'nsb', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount)', flags: 'i', capture_group: 1, notes: 'NSB discount percentage' },
  { bank: 'nsb', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master', flags: 'i', capture_group: 0, notes: 'NSB card type keywords' },

  // COMBANK — HTML scrape
  { bank: 'combank', field: 'merchant_name', rule_type: 'regex', pattern: 'Merchant\\s*:\\s*([^\\n]+)', flags: 'i', capture_group: 1, notes: 'COMBANK merchant label extraction' },
  { bank: 'combank', field: 'discount_pct', rule_type: 'regex', pattern: '(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|discount|cashback)', flags: 'i', capture_group: 1, notes: 'COMBANK discount percentage' },
  { bank: 'combank', field: 'card_types', rule_type: 'keyword_list', pattern: 'credit,debit,visa,master,amex', flags: 'i', capture_group: 0, notes: 'COMBANK card type keywords' },
  { bank: 'combank', field: 'transaction_min', rule_type: 'regex', pattern: 'Rs\\.?\\s*([\\d,.]+)\\s*(?:minimum|and above|or more)', flags: 'i', capture_group: 1, notes: 'COMBANK minimum transaction' },
];


async function initBankParserRules() {
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

  // ── Phase 2: add new columns idempotently ───────────────────────────────
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS priority    INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS source_path TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS category    TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS source_type TEXT`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS version     INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE bank_parser_rules ADD COLUMN IF NOT EXISTS status      TEXT NOT NULL DEFAULT 'active'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bpr_bank_field_priority_idx ON bank_parser_rules (bank, field, priority ASC)`);

  // Seed built-in rules if table is empty
  const count = await pool.query('SELECT COUNT(*) FROM bank_parser_rules WHERE is_builtin = true');
  if (parseInt(count.rows[0].count) === 0) {
    for (const r of BANK_PARSER_RULE_SEED) {
      await pool.query(
        `INSERT INTO bank_parser_rules (bank, field, rule_type, pattern, flags, capture_group, notes, is_builtin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [r.bank, r.field, r.rule_type, r.pattern ?? null, r.flags, r.capture_group, r.notes ?? null]
      );
    }
    console.log(`[DB] Seeded ${BANK_PARSER_RULE_SEED.length} bank parser rules`);
  }
}

async function initCostControlTables() {
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
}

async function initOfferWorkflowTables() {
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
}

async function initDuplicateDetectionTables() {
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
}

async function initParserGoldenCases() {
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

  const countRes = await pool.query('SELECT COUNT(*) FROM parser_golden_cases');
  if (parseInt(countRes.rows[0].count) === 0) {
    const seeded = await seedGoldenCases();
    console.log(`[DB] Seeded ${seeded} initial parser golden cases`);
  }
}


// Bank parser rules CRUD
app.get('/api/bank-parser-rules', asyncHandler(async (req, res) => {
  const { bank } = req.query as Record<string, string>;
  const rows = bank
    ? await pool.query(
        'SELECT * FROM bank_parser_rules WHERE bank = $1 ORDER BY field, priority ASC, created_at',
        [bank]
      )
    : await pool.query('SELECT * FROM bank_parser_rules ORDER BY bank, field, priority ASC, created_at');
  res.json({ items: rows.rows, total: rows.rows.length });
}));


app.post('/api/bank-parser-rules', asyncHandler(async (req, res) => {
  const {
    bank, field, rule_type, pattern, flags, capture_group, notes,
    priority, source_path, category, source_type, status,
  } = req.body as Record<string, any>;
  if (!bank || !field || !rule_type) {
    res.status(400).json({ error: 'bank, field, and rule_type are required' }); return;
  }
  const result = await pool.query(
    `INSERT INTO bank_parser_rules
       (bank, field, rule_type, pattern, flags, capture_group, notes, is_builtin,
        priority, source_path, category, source_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      bank, field, rule_type, pattern ?? null, flags ?? 'i', capture_group ?? 1, notes ?? null,
      priority ?? 100, source_path ?? null, category ?? null, source_type ?? null, status ?? 'active',
    ]
  );
  // Invalidate in-process cache so the next scrape picks up the new rule
  invalidateBankRulesCache(bank);
  res.status(201).json(result.rows[0]);
}));


app.put('/api/bank-parser-rules/:id', asyncHandler(async (req, res) => {
  const {
    field, rule_type, pattern, flags, capture_group, enabled, notes,
    priority, source_path, category, source_type, status,
  } = req.body as Record<string, any>;
  const result = await pool.query(
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
    [field, rule_type, pattern, flags, capture_group, enabled, notes,
     priority, source_path, category, source_type, status, req.params.id]
  );
  if (!result.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  // Invalidate in-process cache for the bank that owns this rule
  invalidateBankRulesCache(result.rows[0].bank);
  res.json(result.rows[0]);
}));


app.delete('/api/bank-parser-rules/:id', asyncHandler(async (req, res) => {
  // Fetch bank first so we can invalidate the right cache key
  const lookup = await pool.query('SELECT bank FROM bank_parser_rules WHERE id = $1', [req.params.id]);
  if (!lookup.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  await pool.query('DELETE FROM bank_parser_rules WHERE id = $1', [req.params.id]);
  invalidateBankRulesCache(lookup.rows[0].bank);
  res.json({ deleted: req.params.id });
}));


// Test a bank parser rule against recent scraped offers for that bank
app.post('/api/bank-parser-rules/:id/test', asyncHandler(async (req, res) => {
  const ruleRow = await pool.query('SELECT * FROM bank_parser_rules WHERE id = $1', [req.params.id]);
  if (!ruleRow.rows.length) { res.status(404).json({ error: 'Rule not found' }); return; }
  const rule = ruleRow.rows[0] as BankParserRule;

  const limit = parseInt((req.query.limit as string) ?? '20');
  const offers = await pool.query(
    `SELECT unique_id, bank, title, raw_offer FROM offers WHERE bank = $1 AND raw_offer IS NOT NULL ORDER BY updated_at DESC LIMIT $2`,
    [rule.bank, Math.min(limit, 50)]
  );

  const results: { unique_id: string; title: string; extracted: string | null; matched: boolean; trace?: unknown }[] = [];
  const includeTrace = req.query.trace === 'true';

  for (const row of offers.rows) {
    const raw: Record<string, unknown> = typeof row.raw_offer === 'object' ? row.raw_offer : {};
    const trace = testRuleAgainstRaw(rule, raw);
    results.push({
      unique_id: row.unique_id,
      title: row.title ?? '',
      extracted: trace.extracted,
      matched: trace.matched,
      ...(includeTrace ? { trace } : {}),
    });
  }

  const matchCount = results.filter(r => r.matched).length;
  res.json({ total: results.length, matched: matchCount, unmatched: results.length - matchCount, results });
}));

// ─── Backtest helpers (Read-only evaluation & regression candidate detection) ───

function getCurrentNormalizedValue(
  field: string,
  offerRow: Record<string, unknown>,
  raw: Record<string, unknown>,
): string | null {
  if (field === 'discount_pct') {
    if (offerRow.discount_percentage !== null && offerRow.discount_percentage !== undefined) {
      return String(offerRow.discount_percentage);
    }
    const rawOfferObj = (raw.offer ?? {}) as Record<string, unknown>;
    if (rawOfferObj.discountPercentage !== null && rawOfferObj.discountPercentage !== undefined) {
      return String(rawOfferObj.discountPercentage);
    }
    return null;
  }
  if (field === 'merchant_name') {
    if (offerRow.merchant_name) return String(offerRow.merchant_name);
    const rawMerchant = (raw.merchant ?? {}) as Record<string, unknown>;
    if (rawMerchant.name) return String(rawMerchant.name);
    return null;
  }
  if (field === 'merchant_location') {
    if (offerRow.merchant_location) return String(offerRow.merchant_location);
    const rawMerchant = (raw.merchant ?? {}) as Record<string, unknown>;
    if (rawMerchant.location) return String(rawMerchant.location);
    return null;
  }
  if (field === 'booking_required') {
    const rawOfferObj = (raw.offer ?? {}) as Record<string, unknown>;
    if (rawOfferObj.bookingRequired !== undefined && rawOfferObj.bookingRequired !== null) {
      return String(rawOfferObj.bookingRequired);
    }
    return null;
  }
  if (field === 'card_types') {
    if (offerRow.card_type) return String(offerRow.card_type);
    const cardElig = (raw.cardEligibility ?? {}) as Record<string, unknown>;
    if (Array.isArray(cardElig.cardTypes) && cardElig.cardTypes.length > 0) {
      return cardElig.cardTypes.join(', ');
    }
    return null;
  }
  if (field === 'transaction_min') {
    const tx = (raw.transactionRange ?? {}) as Record<string, unknown>;
    if (tx.min !== null && tx.min !== undefined) return String(tx.min);
    return null;
  }
  if (field === 'transaction_max') {
    const tx = (raw.transactionRange ?? {}) as Record<string, unknown>;
    if (tx.max !== null && tx.max !== undefined) return String(tx.max);
    return null;
  }
  if (raw[field] !== undefined && raw[field] !== null) return String(raw[field]);
  return null;
}

function normalizeValForCompare(val: string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  const trimmed = String(val).trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  const num = parseFloat(trimmed.replace(/%/g, ''));
  if (!isNaN(num) && /^-?\d+(\.\d+)?%?$/.test(trimmed)) {
    return String(num);
  }
  return trimmed.toLowerCase();
}

// Backtest: run ALL active rules for a bank against its last N offers
// READ-ONLY: Operates solely on fetched database records.
// No offers updated, no rules activated or modified, no external LLM or Geo API calls.
app.post('/api/bank-parser-rules/backtest', asyncHandler(async (req, res) => {
  const { bank, limit: rawLimit } = req.body as { bank: string; limit?: number };
  if (!bank) { res.status(400).json({ error: 'bank is required' }); return; }

  const limit = Math.min(rawLimit ?? 30, 100);
  const [rulesResult, offersResult] = await Promise.all([
    pool.query<BankParserRule>(
      'SELECT * FROM bank_parser_rules WHERE bank = $1 AND enabled = true AND status = $2 ORDER BY field, priority ASC',
      [bank, 'active']
    ),
    pool.query(
      `SELECT unique_id, title, category, card_type, merchant_name, merchant_location, discount_percentage, raw_offer
       FROM offers
       WHERE bank = $1 AND raw_offer IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT $2`,
      [bank, limit]
    ),
  ]);

  const rules = rulesResult.rows;
  const offers = offersResult.rows;

  // Group rules by field to evaluate them in priority order
  const rulesByField = new Map<string, BankParserRule[]>();
  for (const rule of rules) {
    const list = rulesByField.get(rule.field) ?? [];
    list.push(rule);
    rulesByField.set(rule.field, list);
  }

  interface RegressionCandidate {
    uniqueId: string;
    title: string;
    rawSourceValue: string | null;
    currentValue: string | null;
    ruleResult: string | null;
    ruleId: string;
    ruleVersion: number;
    classification: 'CHANGED' | 'NEW_NULL' | 'ERROR';
  }

  interface FieldBacktestSummary {
    field: string;
    ruleId: string;
    samples: number;
    matched: number;
    unchanged: number;
    changed: number;
    newValues: number;
    newNulls: number;
    noMatch: number;
    errors: number;
    regressionCandidates: RegressionCandidate[];
  }

  const summaries: FieldBacktestSummary[] = [];

  for (const [field, fieldRules] of rulesByField.entries()) {
    const primaryRule = fieldRules[0];
    const summary: FieldBacktestSummary = {
      field,
      ruleId: primaryRule ? primaryRule.id : 'unknown',
      samples: offers.length,
      matched: 0,
      unchanged: 0,
      changed: 0,
      newValues: 0,
      newNulls: 0,
      noMatch: 0,
      errors: 0,
      regressionCandidates: [],
    };

    for (const offerRow of offers) {
      const raw: Record<string, unknown> = typeof offerRow.raw_offer === 'object' && offerRow.raw_offer !== null
        ? (offerRow.raw_offer as Record<string, unknown>)
        : {};

      const currentVal = getCurrentNormalizedValue(field, offerRow, raw);

      // Evaluate candidate rules against this offer using the authoritative evaluation pipeline
      const evalResult = evaluateRulesForField({
        bank,
        field,
        category: offerRow.category,
        sourceType: null, // wildcard
        rawOffer: raw,
      });

      const winningTrace = evalResult.trace.find((t) => t.matched);
      const ruleResult = evalResult.matched && !evalResult.usedFallback ? evalResult.value : null;
      const winningRuleId = evalResult.matched && !evalResult.usedFallback ? (evalResult.ruleId ?? 'none') : 'none';
      const winningRuleVersion = evalResult.matched && !evalResult.usedFallback ? (evalResult.ruleVersion ?? 1) : 1;

      // Classify result
      const curNorm = normalizeValForCompare(currentVal);
      const ruleNorm = normalizeValForCompare(ruleResult);

      const hasError = evalResult.trace.some((t) => !!t.error && !t.matched);

      let classification: 'UNCHANGED' | 'CHANGED' | 'NEW_VALUE' | 'NEW_NULL' | 'NO_MATCH' | 'ERROR';

      if (hasError && !evalResult.matched) {
        classification = 'ERROR';
        summary.errors++;
      } else if (curNorm === null && ruleNorm === null) {
        classification = 'NO_MATCH';
        summary.noMatch++;
      } else if (curNorm === null && ruleNorm !== null) {
        classification = 'NEW_VALUE';
        summary.newValues++;
        summary.matched++;
      } else if (curNorm !== null && ruleNorm === null) {
        classification = 'NEW_NULL';
        summary.newNulls++;
      } else if (curNorm === ruleNorm) {
        classification = 'UNCHANGED';
        summary.unchanged++;
        summary.matched++;
      } else {
        classification = 'CHANGED';
        summary.changed++;
        summary.matched++;
      }

      // Record regression candidates (CHANGED, NEW_NULL, ERROR)
      if (classification === 'CHANGED' || classification === 'NEW_NULL' || classification === 'ERROR') {
        if (summary.regressionCandidates.length < 15) {
          const rawSourceVal = winningTrace?.input ?? (primaryRule?.source_path ? resolveSourcePath(raw, primaryRule.source_path) : undefined) ?? null;
          summary.regressionCandidates.push({
            uniqueId: offerRow.unique_id,
            title: offerRow.title ?? 'Untitled Offer',
            rawSourceValue: rawSourceVal ? rawSourceVal.substring(0, 150) : null,
            currentValue: currentVal,
            ruleResult,
            ruleId: winningRuleId,
            ruleVersion: winningRuleVersion,
            classification,
          });
        }
      }
    }

    summaries.push(summary);
  }

  res.json({
    bank,
    offersScanned: offers.length,
    rulesEvaluated: rules.length,
    byField: summaries,
  });
}));

// ─── Golden Cases API (Read-only execution, ground truth regression test) ──────

// GET /api/parser-golden-cases
app.get('/api/parser-golden-cases', asyncHandler(async (req, res) => {
  const { bank, field, enabled } = req.query as Record<string, string>;
  const enabledBool = enabled === 'true' ? true : enabled === 'false' ? false : null;

  const result = await pool.query(
    `SELECT g.*, COALESCE(g.offer_title, o.title) AS title, o.unique_id AS live_unique_id
     FROM parser_golden_cases g
     LEFT JOIN offers o ON (g.offer_id = o.id OR (g.offer_unique_id IS NOT NULL AND g.offer_unique_id = o.unique_id))
     WHERE ($1::TEXT IS NULL OR g.bank = $1)
       AND ($2::TEXT IS NULL OR g.field = $2)
       AND ($3::BOOLEAN IS NULL OR g.enabled = $3)
     ORDER BY g.created_at DESC`,
    [bank || null, field || null, enabledBool]
  );
  res.json({ total: result.rows.length, items: result.rows });
}));

// POST /api/parser-golden-cases
app.post('/api/parser-golden-cases', asyncHandler(async (req, res) => {
  const {
    bank,
    offerId,
    offerUniqueId,
    offerTitle,
    field,
    expectedValue,
    rawSnippet,
    notes,
    enabled,
  } = req.body as {
    bank: string;
    offerId?: string;
    offerUniqueId?: string;
    offerTitle?: string;
    field: string;
    expectedValue: string;
    rawSnippet?: string;
    notes?: string;
    enabled?: boolean;
  };

  if (!bank || !field || expectedValue === undefined || expectedValue === null) {
    res.status(400).json({ error: 'bank, field, and expectedValue are required' });
    return;
  }

  let title = offerTitle ?? null;
  let resolvedOfferId = offerId ?? null;
  let resolvedOfferUniqueId = offerUniqueId ?? null;

  if ((offerId || offerUniqueId) && !title) {
    const offerLookup = await pool.query(
      `SELECT id, unique_id, title FROM offers WHERE ($1::UUID IS NOT NULL AND id = $1) OR ($2::TEXT IS NOT NULL AND unique_id = $2) LIMIT 1`,
      [offerId || null, offerUniqueId || null]
    );
    if (offerLookup.rows.length > 0) {
      title = offerLookup.rows[0].title;
      resolvedOfferId = offerLookup.rows[0].id;
      resolvedOfferUniqueId = offerLookup.rows[0].unique_id;
    }
  }

  const insert = await pool.query(
    `INSERT INTO parser_golden_cases (
       bank, offer_id, offer_unique_id, offer_title, field, expected_value, raw_snippet, notes, enabled
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      bank,
      resolvedOfferId,
      resolvedOfferUniqueId,
      title,
      field,
      String(expectedValue),
      rawSnippet || null,
      notes || null,
      enabled !== false,
    ]
  );
  res.status(201).json(insert.rows[0]);
}));

// PUT /api/parser-golden-cases/:id
app.put('/api/parser-golden-cases/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { expectedValue, notes, enabled, field, rawSnippet } = req.body as {
    expectedValue?: string;
    notes?: string;
    enabled?: boolean;
    field?: string;
    rawSnippet?: string;
  };

  const update = await pool.query(
    `UPDATE parser_golden_cases
     SET expected_value = COALESCE($1, expected_value),
         notes = COALESCE($2, notes),
         enabled = COALESCE($3, enabled),
         field = COALESCE($4, field),
         raw_snippet = COALESCE($5, raw_snippet),
         updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [
      expectedValue !== undefined ? String(expectedValue) : null,
      notes !== undefined ? notes : null,
      enabled !== undefined ? enabled : null,
      field !== undefined ? field : null,
      rawSnippet !== undefined ? rawSnippet : null,
      id,
    ]
  );
  if (update.rows.length === 0) {
    res.status(404).json({ error: 'Golden case not found' });
    return;
  }
  res.json(update.rows[0]);
}));

// DELETE /api/parser-golden-cases/:id
app.delete('/api/parser-golden-cases/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const del = await pool.query('DELETE FROM parser_golden_cases WHERE id = $1 RETURNING id', [id]);
  if (del.rows.length === 0) {
    res.status(404).json({ error: 'Golden case not found' });
    return;
  }
  res.json({ success: true, id });
}));

// POST /api/parser-golden-cases/run
// READ-ONLY: Evaluates enabled golden cases against stored offers using the authoritative engine.
// Does NOT modify offers, does NOT activate rules, does NOT call external LLM or Geo APIs.
app.post('/api/parser-golden-cases/run', asyncHandler(async (req, res) => {
  const { bank, field } = req.body as { bank?: string; field?: string };

  const casesResult = await pool.query(
    `SELECT g.*, o.title AS live_offer_title, o.raw_offer, o.category, o.unique_id AS live_unique_id
     FROM parser_golden_cases g
     LEFT JOIN offers o ON (g.offer_id = o.id OR (g.offer_unique_id IS NOT NULL AND g.offer_unique_id = o.unique_id))
     WHERE g.enabled = true
       AND ($1::TEXT IS NULL OR g.bank = $1)
       AND ($2::TEXT IS NULL OR g.field = $2)
     ORDER BY g.bank, g.field, g.created_at DESC`,
    [bank || null, field || null]
  );

  const cases = casesResult.rows;

  interface GoldenTestResultItem {
    caseId: string;
    bank: string;
    field: string;
    offerTitle: string;
    expected: string;
    actual: string | null;
    status: 'PASS' | 'FAIL';
    whichRuleRan: string;
    ruleVersion: number;
    sourcePath: string | null;
    inputValue: string | null;
    regexMatched: boolean;
    capture: string | null;
    usedFallback: boolean;
    error?: string;
  }

  const results: GoldenTestResultItem[] = [];

  for (const row of cases) {
    const raw: Record<string, unknown> = (typeof row.raw_offer === 'object' && row.raw_offer !== null)
      ? (row.raw_offer as Record<string, unknown>)
      : (row.raw_snippet ? { text: row.raw_snippet } : {});

    const fallbackInput = row.raw_snippet ?? (row.raw_offer ? JSON.stringify(row.raw_offer) : '');

    const evalResult = evaluateRulesForField({
      bank: row.bank,
      field: row.field,
      category: row.category,
      sourceType: null, // wildcard
      rawOffer: raw,
      fallbackInput,
    });

    const winningTrace = evalResult.trace.find((t) => t.matched);
    const activeTrace = winningTrace ?? evalResult.trace[evalResult.trace.length - 1];

    const actualVal = evalResult.value;
    const passed = areGoldenValuesEqual(row.expected_value, actualVal, row.field);

    results.push({
      caseId: row.id,
      bank: row.bank,
      field: row.field,
      offerTitle: row.live_offer_title ?? row.offer_title ?? 'Untitled Offer',
      expected: row.expected_value,
      actual: actualVal,
      status: passed ? 'PASS' : 'FAIL',
      whichRuleRan: activeTrace?.ruleId ?? 'none',
      ruleVersion: activeTrace?.ruleVersion ?? 1,
      sourcePath: activeTrace?.sourcePath ?? null,
      inputValue: activeTrace?.input ?? null,
      regexMatched: activeTrace?.matched ?? false,
      capture: activeTrace?.extracted ?? null,
      usedFallback: activeTrace?.usedFallback ?? false,
      error: activeTrace?.error,
    });
  }

  const total = results.length;
  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = total - passedCount;
  const passRate = total > 0 ? Math.round((passedCount / total) * 100) : 100;

  res.json({
    bank: bank ?? 'all',
    field: field ?? 'all',
    total,
    passed: passedCount,
    failed: failedCount,
    passRate,
    cases: results,
  });
}));




// ─── Geocode trigger ──────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

app.post('/api/geocode/:bank', (req, res) => {
  const { bank } = req.params;
  try {
    const job = jobManager.startGeocodeJob(bank);
    res.json({ message: `Geocode started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('already running')) {
      res.status(409).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

// ─── Scrape execution & job lifecycle ─────────────────────────────────────────

app.post('/api/scrape/:bank', (req, res) => {
  const { bank } = req.params;
  const { cache, llm, noValidate, skipDetails, concurrency, maxCategories } = (req.body ?? {}) as {
    cache?: boolean;
    llm?: boolean;
    noValidate?: boolean;
    skipDetails?: boolean;
    concurrency?: number;
    maxCategories?: number;
  };

  try {
    const job = jobManager.startScrapeJob(bank, {
      cache,
      llm,
      noValidate,
      skipDetails,
      concurrency,
      maxCategories,
    });
    res.json({ message: `Scrape started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('already running') || msg.includes('Cannot run') || msg.includes('Cannot start') || msg.includes('limit reached')) {
      res.status(409).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

app.post('/api/scrape/:bank/cancel', asyncHandler(async (req, res) => {
  const bank = String(req.params.bank);
  const result = await jobManager.cancelScrapeJob(bank, 'operator');
  if (!result.cancelled) {
    res.status(404).json({ error: `No active scraper found running for bank: ${bank}` });
    return;
  }
  res.json({ message: `Scraper for ${bank} cancelled successfully`, ...result });
}));

app.delete('/api/scrape/:bank', asyncHandler(async (req, res) => {
  const bank = String(req.params.bank);
  const result = await jobManager.cancelScrapeJob(bank, 'operator');
  if (!result.cancelled) {
    res.status(404).json({ error: `No active scraper found running for bank: ${bank}` });
    return;
  }
  res.json({ message: `Scraper for ${bank} cancelled successfully`, ...result });
}));

app.post('/api/scrape/:bank/retry', asyncHandler(async (req, res) => {
  const bank = String(req.params.bank);
  const options = (req.body ?? {}) as any;
  try {
    const job = await jobManager.retryScrapeJob(bank, options, 'operator');
    res.json({ message: `Scrape retry started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(409).json({ error: msg });
  }
}));

app.get('/api/scrape/status', (_req, res) => {
  res.json({
    active: jobManager.getActiveJobs(),
    activeGeo: jobManager.getActiveGeoJobs(),
  });
});

app.get('/api/logs', asyncHandler(async (req, res) => {
  const rawBank = req.query.bank ? String(req.query.bank).toLowerCase() : undefined;
  // Guard against path traversal: must be in VALID_BANKS
  const bankFilter = rawBank && VALID_BANKS.includes(rawBank) ? rawBank : rawBank === 'all' ? undefined : rawBank ? 'INVALID' : undefined;

  if (bankFilter === 'INVALID') {
    res.json({ items: [], total: 0 });
    return;
  }

  const levelFilter = req.query.level ? String(req.query.level).toUpperCase() : undefined;
  const tagFilter = req.query.tag ? String(req.query.tag) : undefined;
  const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);

  const logsDir = path.resolve(PROJECT_ROOT, 'logs');
  if (!fs.existsSync(logsDir)) {
    res.json({ items: [], total: 0 });
    return;
  }

  const bankDirs = fs.readdirSync(logsDir).filter((d) => {
    const full = path.resolve(logsDir, d);
    if (!full.startsWith(logsDir)) return false; // path traversal prevention
    if (!fs.statSync(full).isDirectory()) return false;
    if (bankFilter && d.toLowerCase() !== bankFilter) return false;
    return true;
  });

  interface LogEntry {
    ts: string;
    level: string;
    bank: string;
    tag?: string;
    message: string;
    pid?: number;
    data?: Record<string, unknown>;
  }

  const entries: LogEntry[] = [];

  for (const bDir of bankDirs) {
    const dirPath = path.resolve(logsDir, bDir);
    if (!dirPath.startsWith(logsDir)) continue;

    const files = fs.readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    for (const f of files.slice(0, 3)) {
      const filePath = path.resolve(dirPath, f);
      if (!filePath.startsWith(dirPath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (levelFilter && levelFilter !== 'ALL' && parsed.level?.toUpperCase() !== levelFilter) continue;
          if (tagFilter && tagFilter !== 'ALL' && parsed.tag !== tagFilter) continue;
          if (search && !parsed.message?.toLowerCase().includes(search) && !parsed.tag?.toLowerCase().includes(search)) continue;
          entries.push({
            ts: parsed.ts || parsed.timestamp || new Date().toISOString(),
            level: parsed.level ?? 'INFO',
            bank: parsed.bank ?? bDir,
            tag: parsed.tag ?? 'SYSTEM',
            message: parsed.message ?? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)),
            pid: parsed.pid,
            data: parsed.data || (parsed.metadata ? parsed.metadata : undefined),
          });
          if (entries.length >= limit * 2) break;
        } catch {
          // ignore malformed lines
        }
      }
      if (entries.length >= limit * 2) break;
    }
  }

  entries.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  res.json({ items: entries.slice(0, limit), total: entries.length });
}));

// ─── Admin UI static files ────────────────────────────────────────────────────
// Serve the built admin dashboard from admin/dist so that localhost:3001
// opens the admin directly — no separate dev server or Vite proxy required.

const ADMIN_DIST = path.resolve(__dirname, '../../../admin/dist');
const adminIndexHtml = path.join(ADMIN_DIST, 'index.html');

app.use(express.static(ADMIN_DIST));

// SPA fallback — any non-API, non-file route returns index.html
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(adminIndexHtml, (err) => {
    if (err) {
      res.type('html').send(
        '<pre style="font-family:monospace;padding:2rem">' +
        '<strong>Admin UI not built.</strong>\n\n' +
        'Run: cd admin &amp;&amp; npm run build\n\n' +
        'API is running at <a href="/api/health">/api/health</a>' +
        '</pre>'
      );
    } else {
      next(err);
    }
  });
});

// ─── Centralized Error handler ────────────────────────────────────────────────

app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  console.log(`Lanka Offers API running on http://localhost:${PORT}`);
  console.log(formatSafePolicySummary());
  try {
    await initRuleConfigs();
    console.log('[DB] rule_configs table ready');
    await initBankParserRules();
    console.log('[DB] bank_parser_rules table ready');
    await initParserGoldenCases();
    console.log('[DB] parser_golden_cases table ready');
    await initCostControlTables();
    console.log('[DB] cost-control tables ready');
    await initOfferWorkflowTables();
    console.log('[DB] offer workflow tables ready');
    await initDuplicateDetectionTables();
    console.log('[DB] duplicate detection tables ready');

    // Startup recovery of orphaned stale runs
    await jobManager.recoverStaleRunsOnStartup();
  } catch (e) {
    console.warn('[DB] Could not init tables:', (e as Error).message);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Kill the existing process or set API_PORT in .env`);
  } else {
    console.error('[FATAL] Server error:', err.message);
  }
  process.exit(1);
});

// Graceful process termination
process.on('SIGINT', async () => {
  console.log('\n[Server] SIGINT received, shutting down gracefully...');
  await jobManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] SIGTERM received, shutting down gracefully...');
  await jobManager.shutdown();
  process.exit(0);
});

