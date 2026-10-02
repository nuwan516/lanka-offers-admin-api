/**
 * Offer + ScrapeRun persistence layer.
 * All writes use the pooled connection (DATABASE_URL).
 */

import { pool, withTransaction } from './db-client';
import type { Offer, GeoLocation } from '@/core/types/offers';
import type { ValidatorReport } from '@/core/types/validation';
import type { OfferLifecycleStatus, OfferChangeStatus } from '@/domain/offer-lifecycle';

// ─── Scrape Runs ─────────────────────────────────────────────────────────────

export async function createScrapeRun(bank: string, mode: string, triggeredBy: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO scrape_runs (bank, mode, triggered_by, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING id`,
    [bank, mode, triggeredBy]
  );
  return res.rows[0].id;
}

export interface CompleteScrapeRunStats {
  found: number;
  newCount: number;
  changed: number;
  unchanged: number;
  errors: number;
  status?: string;
  errorMessage?: string;
}

export interface CompleteScrapeRunResult {
  status: string;
  anomalyWarning: string | null;
}

export async function completeScrapeRun(
  runId: string,
  stats: CompleteScrapeRunStats
): Promise<CompleteScrapeRunResult> {
  let finalStatus = stats.status ?? 'completed';
  let finalErrorMessage = stats.errorMessage ?? null;

  try {
    const runRes = await pool.query<{ bank: string }>(
      `SELECT bank FROM scrape_runs WHERE id = $1`,
      [runId]
    );
    const bank = runRes.rows[0]?.bank;

    if (bank) {
      const prevRes = await pool.query<{ offers_found: number }>(
        `SELECT offers_found
         FROM scrape_runs
         WHERE bank = $1 AND id != $2 AND status IN ('completed', 'warning')
         ORDER BY started_at DESC
         LIMIT 1`,
        [bank, runId]
      );

      const prevRun = prevRes.rows[0];
      const prevFound = prevRun ? Number(prevRun.offers_found) : null;

      if (!stats.status || stats.status === 'completed') {
        if (stats.found === 0) {
          finalStatus = 'warning';
          finalErrorMessage = prevFound !== null && prevFound > 0
            ? `Suspicious zero-result run: 0 offers found (previous run found ${prevFound}). Possible DOM layout change, WAF blocking, or broken selectors.`
            : `Zero offers found: Bank source returned empty results.`;
        } else if (prevFound !== null && prevFound >= 10 && stats.found <= Math.floor(prevFound * 0.5)) {
          const dropPct = Math.round(((prevFound - stats.found) / prevFound) * 100);
          finalStatus = 'warning';
          finalErrorMessage = `Suspicious volume collapse: Found ${stats.found} offers vs ${prevFound} previously (-${dropPct}%). Possible category or pagination failure.`;
        } else if (prevFound !== null && prevFound >= 10 && stats.found >= prevFound * 3) {
          const surgePct = Math.round(((stats.found - prevFound) / prevFound) * 100);
          finalStatus = 'warning';
          finalErrorMessage = `Suspicious volume surge: Found ${stats.found} offers vs ${prevFound} previously (+${surgePct}%). Possible loop or duplicate inflation.`;
        } else if (stats.errors > 0 && stats.errors >= Math.max(1, Math.floor(stats.found * 0.3))) {
          finalStatus = 'warning';
          finalErrorMessage = `High persistence error rate: ${stats.errors} errors across ${stats.found} offers.`;
        }
      }
    }
  } catch {
    // If anomaly lookup encounters an error, proceed with basic stats
  }

  await pool.query(
    `UPDATE scrape_runs
     SET status = $2, finished_at = NOW(),
         offers_found = $3, offers_new = $4, offers_changed = $5,
         offers_unchanged = $6, errors = $7, error_message = $8
     WHERE id = $1`,
    [runId, finalStatus, stats.found, stats.newCount, stats.changed, stats.unchanged, stats.errors, finalErrorMessage]
  );

  return {
    status: finalStatus,
    anomalyWarning: finalStatus === 'warning' ? finalErrorMessage : null,
  };
}

export async function failScrapeRun(runId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE scrape_runs
     SET status = 'failed', finished_at = NOW(), error_message = $2
     WHERE id = $1`,
    [runId, errorMessage]
  );
}

// ─── Offers ──────────────────────────────────────────────────────────────────

export type UpsertStatus = 'NEW' | 'CHANGED' | 'UNCHANGED';

export interface UpsertResult {
  id: string;
  isNew: boolean;
  isChanged: boolean;
  isUnchanged: boolean;
  status: UpsertStatus;
  /** True when the changed candidate was staged into `pending_candidate`
   *  instead of overwriting a live PUBLISHED row (Step 10). */
  staged: boolean;
}

export interface OfferLifecycleDecision {
  /** The quality-gate decision for the freshly-scraped candidate. `change_status`
   *  (NEW/CHANGED) is determined internally from the upsert branch taken, not
   *  by the caller, since that's only known once the existing row is read. */
  lifecycleStatus: OfferLifecycleStatus;
}

const NEW_CHANGE_STATUS: OfferChangeStatus = 'NEW';
const CHANGED_CHANGE_STATUS: OfferChangeStatus = 'CHANGED';

function offerColumnValues(offer: Offer) {
  const validity = offer.validityPeriods?.[0];
  return {
    validFrom: validity?.validFrom ?? null,
    validTo: validity?.validTo ?? null,
    discount: offer.offer?.discountPercentage?.toString() ?? null,
    cardEligibility: JSON.stringify(offer.cardEligibility ?? {}),
    geoLocations: JSON.stringify(offer.merchant?.geocodedLocations ?? []),
    rawOffer: JSON.stringify(offer),
  };
}

/**
 * Insert or conditionally update an offer, respecting the staging/review
 * lifecycle (Step 10/11):
 *
 *  - Same `unique_id` + same `content_hash` → NO WRITE at all (zero-cost
 *    control invariant — not even `updated_at` bumps).
 *  - New identity → inserted directly with the caller's quality decision.
 *  - Changed identity, currently PUBLISHED → the live published columns are
 *    left untouched; the new candidate is staged into `pending_candidate`
 *    for review/approval instead of silently going live.
 *  - Changed identity, NOT yet published (still DISCOVERED/REVIEW_REQUIRED/
 *    APPROVED/REJECTED) → nothing public to protect, so the row is updated
 *    directly with a fresh quality decision, same as before this feature.
 *
 * Runs inside a transaction with `SELECT ... FOR UPDATE` so concurrent
 * scrape runs for the same offer can't race each other.
 */
export async function upsertOffer(
  offer: Offer,
  runId: string,
  decision: OfferLifecycleDecision
): Promise<UpsertResult> {
  return withTransaction(async (client) => {
    const existingRes = await client.query<{ id: string; content_hash: string | null; db_status: string }>(
      `SELECT id, content_hash, db_status FROM offers WHERE unique_id = $1 FOR UPDATE`,
      [offer.uniqueId]
    );
    const existing = existingRes.rows[0];
    const cols = offerColumnValues(offer);

    if (!existing) {
      const insertRes = await client.query<{ id: string }>(
        `INSERT INTO offers (
           unique_id, bank, source_url, title, category, card_type,
           merchant_name, merchant_location, discount_percentage,
           valid_from, valid_to, card_eligibility, geo_locations,
           raw_offer, content_hash, scrape_run_id, db_status, change_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id`,
        [
          offer.uniqueId, offer.source, offer.sourceUrl, offer.title, offer.category, offer.cardType,
          offer.merchant?.name, offer.merchant?.location, cols.discount,
          cols.validFrom, cols.validTo, cols.cardEligibility, cols.geoLocations,
          cols.rawOffer, offer.contentHash, runId, decision.lifecycleStatus, NEW_CHANGE_STATUS,
        ]
      );
      return { id: insertRes.rows[0].id, isNew: true, isChanged: false, isUnchanged: false, status: 'NEW', staged: false };
    }

    if (existing.content_hash === offer.contentHash) {
      return { id: existing.id, isNew: false, isChanged: false, isUnchanged: true, status: 'UNCHANGED', staged: false };
    }

    if (existing.db_status === 'PUBLISHED') {
      // Protect the live public record — stage the candidate for review.
      await client.query(
        `UPDATE offers
         SET pending_candidate = $2, pending_lifecycle_status = $3, pending_change_status = 'CHANGED',
             scrape_run_id = $4, updated_at = NOW()
         WHERE id = $1`,
        [existing.id, cols.rawOffer, decision.lifecycleStatus, runId]
      );
      return { id: existing.id, isNew: false, isChanged: true, isUnchanged: false, status: 'CHANGED', staged: true };
    }

    // Not yet published — safe to update directly, no live data to protect.
    await client.query(
      `UPDATE offers SET
         title = $2, category = $3, card_type = $4, merchant_name = $5, merchant_location = $6,
         discount_percentage = $7, valid_from = $8, valid_to = $9, card_eligibility = $10,
         geo_locations = $11, raw_offer = $12, content_hash = $13, scrape_run_id = $14,
         db_status = $15, change_status = $16, pending_candidate = NULL,
         pending_lifecycle_status = NULL, pending_change_status = NULL, updated_at = NOW()
       WHERE id = $1`,
      [
        existing.id, offer.title, offer.category, offer.cardType, offer.merchant?.name, offer.merchant?.location,
        cols.discount, cols.validFrom, cols.validTo, cols.cardEligibility, cols.geoLocations, cols.rawOffer,
        offer.contentHash, runId, decision.lifecycleStatus, CHANGED_CHANGE_STATUS,
      ]
    );
    return { id: existing.id, isNew: false, isChanged: true, isUnchanged: false, status: 'CHANGED', staged: false };
  });
}

// ─── LLM validation fingerprint reuse ────────────────────────────────────────

export interface StoredLlmFingerprint {
  offerId: string;
  uniqueId: string;
  contentHash: string | null;
  llmValidatedContentHash: string | null;
  llmPromptVersion: string | null;
  llmValidatorVersion: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmScore: number | null;
  llmValid: boolean | null;
  llmStatus: string | null;
  llmValidatedAt: string | null;
}

/**
 * Batch-load the current LLM fingerprint for every offer of a bank, keyed by
 * unique_id. Used to decide, before running the validation pipeline, which
 * offers already have a reusable validation for their current content_hash —
 * so an unchanged offer scraped 100 times calls the LLM 0 more times, not 100.
 */
export async function getLlmFingerprints(bank: string): Promise<Map<string, StoredLlmFingerprint>> {
  const res = await pool.query<{
    id: string; unique_id: string; content_hash: string | null;
    llm_validated_content_hash: string | null; llm_prompt_version: string | null;
    llm_validator_version: string | null; llm_provider: string | null; llm_model: string | null;
    llm_score: number | null; llm_valid: boolean | null; llm_status: string | null;
    llm_validated_at: string | null;
  }>(
    `SELECT id, unique_id, content_hash, llm_validated_content_hash, llm_prompt_version,
            llm_validator_version, llm_provider, llm_model, llm_score, llm_valid,
            llm_status, llm_validated_at
     FROM offers WHERE bank = $1`,
    [bank]
  );

  const map = new Map<string, StoredLlmFingerprint>();
  for (const r of res.rows) {
    map.set(r.unique_id, {
      offerId: r.id,
      uniqueId: r.unique_id,
      contentHash: r.content_hash,
      llmValidatedContentHash: r.llm_validated_content_hash,
      llmPromptVersion: r.llm_prompt_version,
      llmValidatorVersion: r.llm_validator_version,
      llmProvider: r.llm_provider,
      llmModel: r.llm_model,
      llmScore: r.llm_score,
      llmValid: r.llm_valid,
      llmStatus: r.llm_status,
      llmValidatedAt: r.llm_validated_at,
    });
  }
  return map;
}

export interface LlmFingerprintMeta {
  contentHash: string;
  promptVersion: string;
  validatorVersion: string;
  /** 'validated' (LLM actually ran) | 'reused' | 'skipped_budget' | 'review_required' */
  status: string;
}

export async function saveValidationReport(
  offerId: string,
  uniqueId: string,
  runId: string,
  report: ValidatorReport,
  fingerprint?: LlmFingerprintMeta,
  /** True when this offer's new candidate was staged (Step 10) rather than
   *  applied directly — the currently-PUBLISHED row's displayed rule/LLM
   *  columns must keep describing the published content, not the candidate. */
  staged = false
): Promise<void> {
  const llm = report.llmValidation;
  await pool.query(
    `INSERT INTO validation_reports (
       offer_id, unique_id, scrape_run_id, passed,
       rule_errors, rule_warnings,
       llm_score, llm_valid, llm_provider, llm_model, llm_reasoning, llm_issues
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      offerId, uniqueId, runId, report.passed,
      JSON.stringify(report.ruleValidation.errors),
      JSON.stringify(report.ruleValidation.warnings),
      llm?.extractionScore ?? null,
      llm?.isValidOffer ?? null,
      llm?.provider ?? null,
      llm?.model ?? null,
      llm?.reasoning ?? null,
      JSON.stringify(llm?.issues ?? []),
    ]
  );

  // The LLM fingerprint always reflects "this content_hash's LLM opinion"
  // regardless of publish state — must persist so reuse-checking on the
  // NEXT scrape works even while a candidate sits staged awaiting review.
  await pool.query(
    `UPDATE offers
     SET llm_validated_content_hash = $2, llm_prompt_version = $3,
         llm_validator_version = $4, llm_provider = $5, llm_model = $6,
         llm_status = $7, llm_validated_at = NOW()
     WHERE id = $1`,
    [
      offerId,
      fingerprint?.contentHash ?? null,
      fingerprint?.promptVersion ?? null,
      fingerprint?.validatorVersion ?? null,
      llm?.provider ?? null,
      llm?.model ?? null,
      fingerprint?.status ?? null,
    ]
  );

  if (staged) {
    await pool.query(
      `UPDATE offers SET pending_validation = $2 WHERE id = $1`,
      [offerId, JSON.stringify({
        rulePassed: report.ruleValidation.valid,
        ruleErrors: report.ruleValidation.errors,
        ruleWarnings: report.ruleValidation.warnings,
        llmScore: llm?.extractionScore ?? null,
        llmValid: llm?.isValidOffer ?? null,
      })]
    );
  } else {
    await pool.query(
      `UPDATE offers SET rule_passed = $2, rule_errors = $3, rule_warnings = $4, llm_score = $5, llm_valid = $6
       WHERE id = $1`,
      [
        offerId, report.passed,
        JSON.stringify(report.ruleValidation.errors),
        JSON.stringify(report.ruleValidation.warnings),
        llm?.extractionScore ?? null,
        llm?.isValidOffer ?? null,
      ]
    );
  }
}

// ─── External API usage tracking ─────────────────────────────────────────────

export interface ApiUsageRow {
  provider: string;
  service: string;
  periodKey: string;
  requestCount: number;
  estimatedUnits: number | null;
}

function currentPeriodKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Record one (or more) external API call(s) against the current month's counter. */
export async function recordApiUsage(
  provider: string,
  service: string,
  units = 1,
  estimatedUnits = 0
): Promise<number> {
  const periodKey = currentPeriodKey();
  const res = await pool.query<{ request_count: number }>(
    `INSERT INTO external_api_usage (provider, service, period_key, request_count, estimated_units)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, service, period_key) DO UPDATE SET
       request_count   = external_api_usage.request_count + EXCLUDED.request_count,
       estimated_units = external_api_usage.estimated_units + EXCLUDED.estimated_units,
       updated_at      = NOW()
     RETURNING request_count`,
    [provider, service, periodKey, units, estimatedUnits]
  );
  return res.rows[0].request_count;
}

/** Current-month usage count for a service (0 if never called this period). */
export async function getServiceUsage(service: string): Promise<number> {
  const res = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(request_count), 0) AS total
     FROM external_api_usage WHERE service = $1 AND period_key = $2`,
    [service, currentPeriodKey()]
  );
  return Number(res.rows[0]?.total ?? 0);
}

/** All usage rows for the current period, for the admin status endpoint. */
export async function getCurrentPeriodUsage(): Promise<ApiUsageRow[]> {
  const res = await pool.query<{
    provider: string; service: string; period_key: string;
    request_count: number; estimated_units: string;
  }>(
    `SELECT provider, service, period_key, request_count, estimated_units
     FROM external_api_usage WHERE period_key = $1`,
    [currentPeriodKey()]
  );
  return res.rows.map((r) => ({
    provider: r.provider,
    service: r.service,
    periodKey: r.period_key,
    requestCount: r.request_count,
    estimatedUnits: r.estimated_units === null ? null : Number(r.estimated_units),
  }));
}

// ─── Persistent geo cache (Postgres tier) ────────────────────────────────────

export interface GeoCacheRow {
  cacheKey: string;
  queryNormalized: string;
  provider: string;
  resultJson: unknown;
  expiresAt: string | null;
}

export async function getGeoCacheEntry(cacheKey: string): Promise<GeoCacheRow | null> {
  const res = await pool.query<{
    cache_key: string; query_normalized: string; provider: string;
    result_json: unknown; expires_at: string | null;
  }>(
    `SELECT cache_key, query_normalized, provider, result_json, expires_at
     FROM geo_cache
     WHERE cache_key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [cacheKey]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    cacheKey: row.cache_key,
    queryNormalized: row.query_normalized,
    provider: row.provider,
    resultJson: row.result_json,
    expiresAt: row.expires_at,
  };
}

export async function setGeoCacheEntry(
  cacheKey: string,
  queryNormalized: string,
  provider: string,
  resultJson: unknown,
  ttlMs: number | null
): Promise<void> {
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
  await pool.query(
    `INSERT INTO geo_cache (cache_key, query_normalized, provider, result_json, expires_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (cache_key) DO UPDATE SET
       result_json      = EXCLUDED.result_json,
       expires_at       = EXCLUDED.expires_at,
       last_verified_at = NOW()`,
    [cacheKey, queryNormalized, provider, JSON.stringify(resultJson), expiresAt]
  );
}

// ─── Persist geocoding results back onto the offer row ───────────────────────

export type GeoStatus = 'resolved' | 'unresolved' | 'quota_blocked';

/**
 * Write resolved geo locations back onto the offer record so they survive
 * outside `.geo-cache/`/output files. Only called for offers that were
 * actually (re-)geocoded this run.
 */
export async function updateOfferGeoLocations(
  uniqueId: string,
  geoLocations: GeoLocation[],
  status: GeoStatus,
  geoCacheKey: string | null
): Promise<void> {
  await pool.query(
    `UPDATE offers
     SET geo_locations = $2, geo_status = $3, geo_cache_key = $4, updated_at = NOW()
     WHERE unique_id = $1`,
    [uniqueId, JSON.stringify(geoLocations), status, geoCacheKey]
  );
}

// ─── Query helpers used by the API ───────────────────────────────────────────

export async function getOffers(filters: {
  bank?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.bank) { conditions.push(`bank = $${i++}`); params.push(filters.bank); }
  if (filters.status) { conditions.push(`db_status = $${i++}`); params.push(filters.status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const rows = await pool.query(
    `SELECT id, unique_id, bank, title, category, card_type, merchant_name,
            discount_percentage, valid_from, valid_to, llm_score, llm_valid,
            rule_passed, rule_errors, rule_warnings, db_status, created_at, updated_at,
            scrape_run_id
     FROM offers
     ${where}
     ORDER BY updated_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );
  return rows.rows;
}

export async function getOfferById(id: string) {
  const res = await pool.query(
    `SELECT o.*, vr.llm_reasoning, vr.llm_issues
     FROM offers o
     LEFT JOIN validation_reports vr ON vr.offer_id = o.id
     WHERE o.id::text = $1 OR o.unique_id = $1
     ORDER BY vr.created_at DESC
     LIMIT 1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function getScrapeRuns(limit = 50) {
  const res = await pool.query(
    `SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE db_status = 'PUBLISHED')   AS active_offers,
      COUNT(*) FILTER (WHERE db_status != 'PUBLISHED')  AS inactive_offers,
      COUNT(*)                                        AS total_offers,
      COUNT(*) FILTER (WHERE llm_valid = true)        AS llm_valid,
      COUNT(*) FILTER (WHERE rule_passed = false)     AS rule_failed,
      AVG(llm_score) FILTER (WHERE llm_score IS NOT NULL) AS avg_llm_score
    FROM offers
  `);
  return res.rows[0];
}
