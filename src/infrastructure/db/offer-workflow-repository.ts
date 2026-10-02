/**
 * Staging → review → correction → approval → sync workflow persistence.
 * Kept separate from `offer-repository.ts` (scrape-time upsert/query) so
 * each file stays focused.
 */
import { pool, withTransaction } from './db-client';
import type { PoolClient } from 'pg';
import type { Offer } from '@/core/types/offers';
import { OfferValidator } from '@/parsing/validators/offer-validator';
import { computeEffectiveOffer, sanitizeManualOverride, type ManualOverride } from '@/domain/effective-offer';
import {
  isValidTransition,
  nextLifecycleStatus,
  type OfferLifecycleStatus,
  type OfferReviewAction,
} from '@/domain/offer-lifecycle';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OfferWorkflowRow {
  id: string;
  unique_id: string;
  bank: string;
  db_status: OfferLifecycleStatus;
  change_status: string;
  raw_offer: Offer;
  manual_override: ManualOverride;
  pending_candidate: Offer | null;
  pending_lifecycle_status: OfferLifecycleStatus | null;
  pending_change_status: string | null;
  content_hash: string | null;
  [key: string]: unknown;
}

export interface ReviewHistoryEntry {
  id: string;
  offer_id: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  changes_json: Record<string, unknown>;
  reason: string | null;
  actor: string;
  created_at: string;
}

export class WorkflowError extends Error {}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getOfferWorkflow(idOrUniqueId: string): Promise<OfferWorkflowRow | null> {
  const res = await pool.query<OfferWorkflowRow>(
    `SELECT * FROM offers WHERE id::text = $1 OR unique_id = $1`,
    [idOrUniqueId]
  );
  return res.rows[0] ?? null;
}

export async function getReviewHistory(offerId: string): Promise<ReviewHistoryEntry[]> {
  const res = await pool.query<ReviewHistoryEntry>(
    `SELECT * FROM offer_review_history WHERE offer_id = $1 ORDER BY created_at DESC`,
    [offerId]
  );
  return res.rows;
}

/** The offer as it would look if published right now (candidate + manual overrides). */
export function computeEffectivePreview(row: OfferWorkflowRow): Offer {
  const candidate = row.pending_candidate ?? row.raw_offer;
  return computeEffectiveOffer(candidate, row.manual_override);
}

// ─── Audit logging ────────────────────────────────────────────────────────────

export async function logHistory(
  client: PoolClient,
  offerId: string,
  action: string,
  fromStatus: string | null,
  toStatus: string | null,
  changes: Record<string, unknown> = {},
  reason: string | null = null,
  actor = 'admin'
): Promise<void> {
  await client.query(
    `INSERT INTO offer_review_history (offer_id, action, from_status, to_status, changes_json, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [offerId, action, fromStatus, toStatus, JSON.stringify(changes), reason, actor]
  );
}

// ─── Manual correction (Step 5/12) ───────────────────────────────────────────

export interface SaveCorrectionResult {
  manualOverride: ManualOverride;
  rulePassed: boolean;
  ruleErrors: unknown[];
}

/**
 * Persist an admin correction. Only re-runs deterministic rule validation
 * (never the LLM automatically — Step 12) against the resulting effective
 * offer, so a manual edit can't silently invalidate the offer without the
 * admin seeing the new rule result immediately.
 */
export async function saveManualCorrection(
  offerId: string,
  override: ManualOverride,
  actor = 'admin',
  reason: string | null = null,
  expectedUpdatedAt?: string
): Promise<SaveCorrectionResult> {
  const clean = sanitizeManualOverride(override);

  return withTransaction(async (client) => {
    const res = await client.query<OfferWorkflowRow>(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [offerId]);
    const row = res.rows[0];
    if (!row) throw new WorkflowError('Offer not found');

    if (expectedUpdatedAt && row.updated_at) {
      const currentTs = new Date(row.updated_at as string | number | Date).getTime();
      const expectedTs = new Date(expectedUpdatedAt).getTime();
      if (!isNaN(expectedTs) && Math.abs(currentTs - expectedTs) > 1000) {
        throw new WorkflowError('Concurrent modification conflict: this offer was modified by another operator. Please refresh to inspect the latest candidate state.');
      }
    }

    const merged: ManualOverride = { ...(row.manual_override ?? {}), ...clean };
    const candidate = row.pending_candidate ?? row.raw_offer;
    const effective = computeEffectiveOffer(candidate, merged);
    const ruleResult = new OfferValidator().validate(effective);

    await client.query(
      `UPDATE offers SET manual_override = $2, rule_passed = $3, rule_errors = $4, rule_warnings = $5, updated_at = NOW()
       WHERE id = $1`,
      [offerId, JSON.stringify(merged), ruleResult.valid, JSON.stringify(ruleResult.errors), JSON.stringify(ruleResult.warnings)]
    );

    await logHistory(client, offerId, 'corrected', row.db_status, row.db_status, clean, reason, actor);

    return { manualOverride: merged, rulePassed: ruleResult.valid, ruleErrors: ruleResult.errors };
  });
}

// ─── Review actions / transitions (Step 6/7) ─────────────────────────────────

export interface TransitionResult {
  id: string;
  fromStatus: string;
  toStatus: string;
}

/** Actions whose target is always the row's own top-level lifecycle,
 *  never a staged pending candidate — taking an offer offline (or back
 *  online) is a whole-offer action regardless of any pending update. */
const TOP_LEVEL_ONLY_ACTIONS = new Set<OfferReviewAction>(['DISABLE', 'UNPUBLISH']);

export async function transitionOffer(
  offerId: string,
  action: OfferReviewAction,
  actor = 'admin',
  reason: string | null = null,
  correction?: ManualOverride,
  expectedUpdatedAt?: string
): Promise<TransitionResult> {
  return withTransaction(async (client) => {
    const res = await client.query<OfferWorkflowRow>(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [offerId]);
    const row = res.rows[0];
    if (!row) throw new WorkflowError('Offer not found');

    if (expectedUpdatedAt && row.updated_at) {
      const currentTs = new Date(row.updated_at as string | number | Date).getTime();
      const expectedTs = new Date(expectedUpdatedAt).getTime();
      if (!isNaN(expectedTs) && Math.abs(currentTs - expectedTs) > 1000) {
        throw new WorkflowError('Concurrent modification conflict: this offer was modified by another operator. Please refresh to inspect the latest candidate state.');
      }
    }

    // A staged candidate (Step 10) is what's actually "under review" for a
    // PUBLISHED offer — APPROVE/REJECT/SEND_BACK must act on
    // pending_lifecycle_status, never on the live db_status, so the
    // published offer keeps showing its current value while its pending
    // update is reviewed.
    const isStaged = row.pending_candidate != null && !TOP_LEVEL_ONLY_ACTIONS.has(action);
    const from: OfferLifecycleStatus = isStaged ? (row.pending_lifecycle_status ?? 'REVIEW_REQUIRED') : row.db_status;

    if (!isValidTransition(from, action)) {
      throw new WorkflowError(`Cannot ${action} an offer in status ${from}`);
    }
    const to = nextLifecycleStatus(action);

    let mergedOverride = row.manual_override ?? {};
    if (action === 'APPROVE_WITH_CORRECTIONS' && correction) {
      mergedOverride = { ...mergedOverride, ...sanitizeManualOverride(correction) };
    }

    if (mergedOverride !== row.manual_override) {
      await client.query(`UPDATE offers SET manual_override = $2, updated_at = NOW() WHERE id = $1`, [offerId, JSON.stringify(mergedOverride)]);
    }

    // PUBLISH must never be a bare status flip — it has to go through the
    // same merge + re-validate logic as the dedicated sync endpoint, or a
    // direct PUBLISH call would mark an offer live without ever writing its
    // corrected/merged fields (Part 9 correctness).
    if (action === 'PUBLISH') {
      const syncResult = await syncOneOfferWithClient(client, offerId);
      if (syncResult.outcome !== 'published') {
        throw new WorkflowError(`Cannot publish: ${syncResult.reason ?? syncResult.outcome}`);
      }
      return { id: offerId, fromStatus: from, toStatus: 'PUBLISHED' };
    }

    if (isStaged) {
      await client.query(
        `UPDATE offers SET pending_lifecycle_status = $2, updated_at = NOW() WHERE id = $1`,
        [offerId, to]
      );
    } else {
      const timestampCol =
        to === 'APPROVED' ? 'approved_at' :
        to === 'REJECTED' ? 'rejected_at' :
        to === 'PUBLISHED' ? 'published_at' : null;

      await client.query(
        `UPDATE offers SET
           db_status = $2
           ${timestampCol ? `, ${timestampCol} = NOW()` : ''},
           updated_at = NOW()
         WHERE id = $1`,
        [offerId, to]
      );
    }

    await logHistory(client, offerId, action.toLowerCase(), from, to, correction ? sanitizeManualOverride(correction) : {}, reason, actor);

    return { id: offerId, fromStatus: from, toStatus: to };
  });
}

// ─── Sync / publish (Step 8/9) ────────────────────────────────────────────────

export type SyncOutcome = 'published' | 'unchanged' | 'failed' | 'skipped';

export interface SyncResult {
  offerId: string;
  outcome: SyncOutcome;
  reason?: string;
}

/**
 * Publish one approved offer: merge manual overrides onto the effective
 * candidate, re-validate, and — only if that passes — write the result into
 * the public-facing columns and flip lifecycle to PUBLISHED.
 *
 * Eligible rows are either:
 *  - db_status = 'APPROVED' (a brand-new offer never published before), or
 *  - already PUBLISHED with a pending_candidate whose pending_lifecycle_status = 'APPROVED'
 *    (an approved update to a previously-published offer).
 *
 * Uses SELECT ... FOR UPDATE + a fresh re-read so a concurrent change to the
 * same row can't be silently clobbered ("confirm source/version has not
 * unexpectedly changed" — Step 8.4).
 */
export async function syncApprovedOffer(offerId: string): Promise<SyncResult> {
  return withTransaction(async (client) => syncOneOfferWithClient(client, offerId));
}

async function syncOneOfferWithClient(client: PoolClient, offerId: string): Promise<SyncResult> {
  const res = await client.query<OfferWorkflowRow>(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [offerId]);
  const row = res.rows[0];
  if (!row) return { offerId, outcome: 'failed', reason: 'not_found' };

  const isFreshApproval = row.db_status === 'APPROVED';
  const isApprovedUpdate = row.db_status === 'PUBLISHED' && row.pending_candidate != null && row.pending_lifecycle_status === 'APPROVED';

  if (!isFreshApproval && !isApprovedUpdate) {
    return { offerId, outcome: 'skipped', reason: `not eligible (db_status=${row.db_status})` };
  }

  const candidate = row.pending_candidate ?? row.raw_offer;
  const effective = computeEffectiveOffer(candidate, row.manual_override);
  const ruleResult = new OfferValidator().validate(effective);

  if (!ruleResult.valid) {
    // Never publish a candidate that now fails deterministic validation —
    // leave it exactly where it was and report the failure.
    await logHistory(client, offerId, 'sync_failed', row.db_status, row.db_status,
      { errors: ruleResult.errors }, 'final validation failed before publish');
    return { offerId, outcome: 'failed', reason: 'final validation failed' };
  }

  const cols = {
    discount: effective.offer?.discountPercentage?.toString() ?? null,
    validFrom: effective.validityPeriods?.[0]?.validFrom ?? null,
    validTo: effective.validityPeriods?.[0]?.validTo ?? null,
    cardEligibility: JSON.stringify(effective.cardEligibility ?? {}),
    geoLocations: JSON.stringify(effective.merchant?.geocodedLocations ?? row.geo_locations ?? []),
    rawOffer: JSON.stringify(effective),
  };

  await client.query(
    `UPDATE offers SET
       title = $2, category = $3, card_type = $4, merchant_name = $5, merchant_location = $6,
       discount_percentage = $7, valid_from = $8, valid_to = $9, card_eligibility = $10,
       raw_offer = $11, content_hash = COALESCE(pending_candidate->>'contentHash', content_hash),
       db_status = 'PUBLISHED', change_status = COALESCE(pending_change_status, change_status),
       pending_candidate = NULL, pending_lifecycle_status = NULL, pending_change_status = NULL,
       published_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [
      offerId, effective.title, effective.category, effective.cardType,
      effective.merchant?.name, effective.merchant?.location,
      cols.discount, cols.validFrom, cols.validTo, cols.cardEligibility, cols.rawOffer,
    ]
  );

  await logHistory(client, offerId, 'published', row.db_status, 'PUBLISHED', {}, null);
  return { offerId, outcome: 'published' };
}

// ─── Bulk sync (Step 13) ──────────────────────────────────────────────────────

export interface BulkSyncSummary {
  syncRunId: string;
  published: number;
  updated: number;
  unchanged: number;
  failed: number;
  results: SyncResult[];
}

export async function bulkSyncApprovedOffers(triggeredBy = 'admin'): Promise<BulkSyncSummary> {
  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO offer_sync_runs (status, triggered_by) VALUES ('running', $1) RETURNING id`,
    [triggeredBy]
  );
  const syncRunId = runRes.rows[0].id;

  const eligible = await pool.query<{ id: string; db_status: string }>(
    `SELECT id, db_status FROM offers
     WHERE db_status = 'APPROVED'
        OR (db_status = 'PUBLISHED' AND pending_candidate IS NOT NULL AND pending_lifecycle_status = 'APPROVED')`
  );

  let published = 0, updated = 0, unchanged = 0, failed = 0;
  const results: SyncResult[] = [];

  for (const row of eligible.rows) {
    try {
      const wasAlreadyPublished = row.db_status === 'PUBLISHED';
      const result = await withTransaction((client) => syncOneOfferWithClient(client, row.id));
      results.push(result);
      if (result.outcome === 'published') {
        if (wasAlreadyPublished) updated++; else published++;
      } else if (result.outcome === 'failed') {
        failed++;
      } else {
        unchanged++;
      }
    } catch (e) {
      failed++;
      results.push({ offerId: row.id, outcome: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  await pool.query(
    `UPDATE offer_sync_runs SET status = 'completed', finished_at = NOW(),
       approved_count = $2, published_count = $3, updated_count = $4, unchanged_count = $5, failed_count = $6
     WHERE id = $1`,
    [syncRunId, eligible.rows.length, published, updated, unchanged, failed]
  );

  return { syncRunId, published, updated, unchanged, failed, results };
}

// ─── Sync preview (Step 14, read-only) ───────────────────────────────────────

export interface SyncPreview {
  approvedReady: number;
  reviewRequired: number;
  rejected: number;
  alreadyPublished: number;
  changedExisting: number;
}

export async function getSyncPreview(): Promise<SyncPreview> {
  const res = await pool.query<{
    approved_ready: string; review_required: string; rejected: string;
    already_published: string; changed_existing: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE db_status = 'APPROVED') AS approved_ready,
      COUNT(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED') AS review_required,
      COUNT(*) FILTER (WHERE db_status = 'REJECTED') AS rejected,
      COUNT(*) FILTER (WHERE db_status = 'PUBLISHED' AND pending_candidate IS NULL) AS already_published,
      COUNT(*) FILTER (WHERE pending_candidate IS NOT NULL) AS changed_existing
    FROM offers
  `);
  const r = res.rows[0];
  return {
    approvedReady: Number(r.approved_ready),
    reviewRequired: Number(r.review_required),
    rejected: Number(r.rejected),
    alreadyPublished: Number(r.already_published),
    changedExisting: Number(r.changed_existing),
  };
}

/**
 * Reconciles offers whose valid_to date is in the past:
 * transitions db_status from PUBLISHED to EXPIRED so downstream consumer APIs,
 * Admin dashboard, and Flutter views have consistent expiry state.
 */
export async function reconcileExpiredOffers(): Promise<{ expiredCount: number }> {
  return withTransaction(async (client) => {
    const expiredRes = await client.query<{ id: string; unique_id: string }>(
      `UPDATE offers
       SET db_status = 'EXPIRED',
           updated_at = NOW()
       WHERE db_status = 'PUBLISHED'
         AND valid_to IS NOT NULL
         AND valid_to < CURRENT_DATE
       RETURNING id, unique_id`
    );

    for (const row of expiredRes.rows) {
      await logHistory(
        client,
        row.id,
        'expire',
        'PUBLISHED',
        'EXPIRED',
        {},
        'Offer validity period ended (valid_to < CURRENT_DATE)',
        'system:expiry-reconciliation'
      );
    }

    return { expiredCount: expiredRes.rows.length };
  });
}
