/**
 * Duplicate detection persistence (Part 6/7/8/12/13).
 *
 * Detection itself is deterministic and cheap (see `duplicate-detector.ts`)
 * — this file only does narrow same-bank candidate lookups and pair
 * storage/review, never LLM/geo calls.
 */
import { pool, withTransaction } from './db-client';
import type { PoolClient } from 'pg';
import type { Offer } from '@/core/types/offers';
import { scoreDuplicateCandidate } from '@/domain/duplicate-detector';
import { getDuplicatePolicyConfig } from '@/config/duplicate-policy';
import type { DuplicateClassification, DuplicateReviewStatus } from '@/domain/duplicate-types';
import { decideOfferQuality } from '@/domain/offer-quality-decision';
import type { OfferLifecycleStatus } from '@/domain/offer-lifecycle';
import { logHistory, WorkflowError } from './offer-workflow-repository';
import type { UpsertStatus } from './offer-repository';

export { WorkflowError };

// ─── Candidate lookup (Part 7 — narrow, cheap prefilter) ─────────────────────

interface CandidateOfferRow {
  id: string;
  bank: string;
  raw_offer: Offer;
  content_hash: string | null;
}

async function findCandidateOffers(
  bank: string,
  excludeOfferId: string,
  limit: number,
  maxStaleDays: number
): Promise<CandidateOfferRow[]> {
  const res = await pool.query<CandidateOfferRow>(
    `SELECT id, bank, raw_offer, content_hash FROM offers
     WHERE bank = $1 AND id <> $2
       AND db_status NOT IN ('REJECTED', 'DISABLED')
       AND (valid_to IS NULL OR valid_to >= CURRENT_DATE - ($3 || ' days')::interval)
     ORDER BY updated_at DESC
     LIMIT $4`,
    [bank, excludeOfferId, String(maxStaleDays), limit]
  );
  return res.rows;
}

// ─── Pair storage (Part 6 — stored once per pair) ────────────────────────────

async function upsertDuplicateCandidatePair(
  offerId: string,
  candidateOfferId: string,
  score: number,
  classification: DuplicateClassification,
  reasons: string[]
): Promise<void> {
  // Sort so a pair is always stored as (min id, max id) — never twice as
  // both (A,B) and (B,A).
  const [a, b] = [offerId, candidateOfferId].sort();
  await pool.query(
    `INSERT INTO offer_duplicate_candidates (offer_id, candidate_offer_id, score, classification, reasons)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (offer_id, candidate_offer_id) DO UPDATE SET
       score = EXCLUDED.score, classification = EXCLUDED.classification, reasons = EXCLUDED.reasons
     WHERE offer_duplicate_candidates.status = 'PENDING'`,
    [a, b, score, classification, JSON.stringify(reasons)]
  );
}

/**
 * Duplicate detection is only useful for offers whose content actually
 * changed this scrape (Part 7/11) — an UNCHANGED offer can't have newly
 * become a duplicate of anything, so re-scoring it would be pure waste.
 */
export function shouldRunDuplicateDetection(status: UpsertStatus): boolean {
  return status === 'NEW' || status === 'CHANGED';
}

// ─── Detection entry point (Part 7/8 — only for NEW/CHANGED offers) ──────────

export interface DuplicateDetectionResult {
  flagged: boolean;
  topCandidate?: { candidateOfferId: string; score: number; classification: DuplicateClassification };
  scoredCount: number;
}

/**
 * Run duplicate detection for one freshly NEW/CHANGED offer against a
 * narrow same-bank candidate set. Persists any LIKELY/EXACT pair (once),
 * and reports whether this offer should be routed to REVIEW_REQUIRED with
 * change_status=DUPLICATE. Never calls an LLM or a geo provider.
 */
export async function detectAndRecordDuplicates(
  offerId: string,
  offer: Offer,
  bank: string
): Promise<DuplicateDetectionResult> {
  const policy = getDuplicatePolicyConfig();
  const candidates = await findCandidateOffers(bank, offerId, policy.candidateSearchLimit, policy.candidateMaxStaleDays);

  let flagged = false;
  let top: DuplicateDetectionResult['topCandidate'];

  for (const row of candidates) {
    const result = scoreDuplicateCandidate(offer, row.raw_offer);
    if (result.classification !== 'LIKELY_DUPLICATE' && result.classification !== 'EXACT_DUPLICATE') continue;

    await upsertDuplicateCandidatePair(offerId, row.id, result.score, result.classification, result.reasons);

    const triggersReview = result.classification === 'EXACT_DUPLICATE' || result.score >= policy.reviewTriggerThreshold;
    if (triggersReview && (!top || result.score > top.score)) {
      flagged = true;
      top = { candidateOfferId: row.id, score: result.score, classification: result.classification };
    }
  }

  return { flagged, topCandidate: top, scoredCount: candidates.length };
}

/**
 * Route a flagged offer to REVIEW_REQUIRED with change_status=DUPLICATE
 * without touching anything else — never deletes, never rejects.
 *
 * The offer's actual change classification (NEW vs CHANGED) at the moment
 * of flagging is preserved in `pre_duplicate_change_status` so a later
 * NOT_DUPLICATE decision can restore it instead of guessing (Part 6 fix —
 * previously a never-published item always reset to 'NEW').
 */
export async function flagOfferAsDuplicate(offerId: string, staged: boolean, actor = 'system'): Promise<void> {
  return withTransaction(async (client) => {
    const res = await client.query<{ change_status: string; pending_change_status: string | null }>(
      `SELECT change_status, pending_change_status FROM offers WHERE id = $1 FOR UPDATE`,
      [offerId]
    );
    const row = res.rows[0];
    const priorChangeStatus = staged ? (row?.pending_change_status ?? 'CHANGED') : (row?.change_status ?? 'NEW');

    if (staged) {
      await client.query(
        `UPDATE offers SET pending_change_status = 'DUPLICATE', pending_lifecycle_status = 'REVIEW_REQUIRED',
           pre_duplicate_change_status = $2, updated_at = NOW() WHERE id = $1`,
        [offerId, priorChangeStatus]
      );
    } else {
      await client.query(
        `UPDATE offers SET change_status = 'DUPLICATE', db_status = 'REVIEW_REQUIRED',
           pre_duplicate_change_status = $2, updated_at = NOW() WHERE id = $1`,
        [offerId, priorChangeStatus]
      );
    }
    await logHistory(client, offerId, 'flagged_duplicate', null, 'REVIEW_REQUIRED', {}, 'possible duplicate detected', actor);
  });
}

// ─── Listing / reads (Part 13) ────────────────────────────────────────────────

export interface DuplicateListFilters {
  bank?: string;
  classification?: string;
  status?: string;
  minimumScore?: number;
  limit?: number;
  offset?: number;
}

export async function listDuplicateCandidates(filters: DuplicateListFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.bank) { conditions.push(`(a.bank = $${i} OR b.bank = $${i})`); params.push(filters.bank); i++; }
  if (filters.classification) { conditions.push(`odc.classification = $${i++}`); params.push(filters.classification); }
  if (filters.status) { conditions.push(`odc.status = $${i++}`); params.push(filters.status); }
  if (filters.minimumScore != null) { conditions.push(`odc.score >= $${i++}`); params.push(filters.minimumScore); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const res = await pool.query(
    `SELECT odc.id, odc.offer_id, odc.candidate_offer_id, odc.score, odc.classification, odc.reasons,
            odc.status, odc.created_at, odc.reviewed_at, odc.reviewed_by,
            a.bank AS offer_bank, a.title AS offer_title, a.merchant_name AS offer_merchant,
            a.discount_percentage AS offer_discount, a.db_status AS offer_status, a.source_url AS offer_source_url,
            a.card_type AS offer_card_type, a.valid_from AS offer_valid_from, a.valid_to AS offer_valid_to,
            a.merchant_location AS offer_location,
            b.bank AS candidate_bank, b.title AS candidate_title, b.merchant_name AS candidate_merchant,
            b.discount_percentage AS candidate_discount, b.db_status AS candidate_status, b.source_url AS candidate_source_url,
            b.card_type AS candidate_card_type, b.valid_from AS candidate_valid_from, b.valid_to AS candidate_valid_to,
            b.merchant_location AS candidate_location
     FROM offer_duplicate_candidates odc
     JOIN offers a ON a.id = odc.offer_id
     JOIN offers b ON b.id = odc.candidate_offer_id
     ${where}
     ORDER BY odc.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );
  return res.rows;
}

export async function getDuplicateCandidateById(id: string) {
  const res = await pool.query(
    `SELECT odc.*, row_to_json(a) AS offer, row_to_json(b) AS candidate_offer
     FROM offer_duplicate_candidates odc
     JOIN offers a ON a.id = odc.offer_id
     JOIN offers b ON b.id = odc.candidate_offer_id
     WHERE odc.id = $1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function getDuplicateCandidatesForOffer(offerId: string) {
  const res = await pool.query(
    `SELECT * FROM offer_duplicate_candidates WHERE offer_id = $1 OR candidate_offer_id = $1 ORDER BY created_at DESC`,
    [offerId]
  );
  return res.rows;
}

export interface DuplicateStats {
  pending: number;
  confirmed: number;
  notDuplicate: number;
  ignored: number;
}

export async function getDuplicateStats(): Promise<DuplicateStats> {
  const res = await pool.query<{ pending: string; confirmed: string; not_duplicate: string; ignored: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
      COUNT(*) FILTER (WHERE status = 'CONFIRMED_DUPLICATE') AS confirmed,
      COUNT(*) FILTER (WHERE status = 'NOT_DUPLICATE') AS not_duplicate,
      COUNT(*) FILTER (WHERE status = 'IGNORED') AS ignored
    FROM offer_duplicate_candidates
  `);
  const r = res.rows[0];
  return { pending: Number(r.pending), confirmed: Number(r.confirmed), notDuplicate: Number(r.not_duplicate), ignored: Number(r.ignored) };
}

// ─── Review action (Part 8/9/12) ──────────────────────────────────────────────

interface OfferLite {
  id: string;
  db_status: OfferLifecycleStatus;
  pending_candidate: unknown;
  pre_duplicate_change_status: string | null;
  rule_passed: boolean | null;
  rule_errors: unknown[] | null;
  rule_warnings: unknown[] | null;
  llm_score: number | null;
  llm_valid: boolean | null;
  llm_status: string | null;
}

export interface DuplicateReviewResult {
  id: string;
  status: DuplicateReviewStatus;
  offerId: string;
  offerNewStatus: string;
}

/**
 * Resolve a duplicate candidate. `offer_id` is always treated as the
 * flagged copy under review.
 *
 *  - CONFIRMED_DUPLICATE: the flagged copy can never publish. If it was a
 *    staged change to an already-published offer, the pending change is
 *    discarded (the published offer stays exactly as it was). Otherwise
 *    the row itself is marked REJECTED — never deleted.
 *  - NOT_DUPLICATE: the flagged copy re-enters its normal quality/workflow
 *    path, recomputed from its own stored validation results.
 *  - IGNORED: no offer state change — just dismisses the suggestion.
 */
export async function reviewDuplicateCandidate(
  candidateId: string,
  decision: DuplicateReviewStatus,
  actor = 'admin',
  reason: string | null = null
): Promise<DuplicateReviewResult> {
  return withTransaction(async (client) => {
    const candRes = await client.query<{ id: string; offer_id: string; status: DuplicateReviewStatus }>(
      `SELECT id, offer_id, status FROM offer_duplicate_candidates WHERE id = $1 FOR UPDATE`,
      [candidateId]
    );
    const candidate = candRes.rows[0];
    if (!candidate) throw new WorkflowError('Duplicate candidate not found');

    await client.query(
      `UPDATE offer_duplicate_candidates SET status = $2, reviewed_at = NOW(), reviewed_by = $3 WHERE id = $1`,
      [candidateId, decision, actor]
    );

    const offerRes = await client.query<OfferLite>(`SELECT * FROM offers WHERE id = $1 FOR UPDATE`, [candidate.offer_id]);
    const offer = offerRes.rows[0];
    let offerNewStatus = offer?.db_status ?? 'UNKNOWN';

    if (offer && decision === 'CONFIRMED_DUPLICATE') {
      if (offer.pending_candidate) {
        await client.query(
          `UPDATE offers SET pending_candidate = NULL, pending_lifecycle_status = NULL, pending_change_status = NULL,
             pre_duplicate_change_status = NULL, updated_at = NOW() WHERE id = $1`,
          [offer.id]
        );
        offerNewStatus = offer.db_status; // published offer itself is untouched
      } else {
        await client.query(
          `UPDATE offers SET db_status = 'REJECTED', rejected_at = NOW(), pre_duplicate_change_status = NULL, updated_at = NOW() WHERE id = $1`,
          [offer.id]
        );
        offerNewStatus = 'REJECTED';
      }
      await logHistory(client, offer.id, 'confirmed_duplicate', offer.db_status, offerNewStatus, {}, reason, actor);
    } else if (offer && decision === 'NOT_DUPLICATE') {
      const quality = decideOfferQuality({
        ruleValid: offer.rule_passed ?? true,
        ruleErrorCount: offer.rule_errors?.length ?? 0,
        ruleWarningCount: offer.rule_warnings?.length ?? 0,
        llmScore: offer.llm_score,
        llmValid: offer.llm_valid,
        llmStatus: offer.llm_status,
      });
      const lifecycle: OfferLifecycleStatus =
        quality === 'AUTO_APPROVE' ? 'APPROVED' : quality === 'REJECT' ? 'REJECTED' : 'REVIEW_REQUIRED';

      // Restore whatever the change classification actually was before this
      // offer got flagged as a possible duplicate, instead of assuming NEW.
      const restoredChangeStatus = offer.pre_duplicate_change_status ?? (offer.pending_candidate ? 'CHANGED' : 'NEW');

      if (offer.pending_candidate) {
        await client.query(
          `UPDATE offers SET pending_change_status = $2, pending_lifecycle_status = $3,
             pre_duplicate_change_status = NULL, updated_at = NOW() WHERE id = $1`,
          [offer.id, restoredChangeStatus, lifecycle]
        );
        offerNewStatus = offer.db_status; // published row unaffected; pending state re-routed
      } else {
        await client.query(
          `UPDATE offers SET change_status = $2, db_status = $3,
             pre_duplicate_change_status = NULL, updated_at = NOW() WHERE id = $1`,
          [offer.id, restoredChangeStatus, lifecycle]
        );
        offerNewStatus = lifecycle;
      }
      await logHistory(client, offer.id, 'not_duplicate', offer.db_status, offerNewStatus, {}, reason, actor);
    } else if (offer) {
      await logHistory(client, offer.id, 'duplicate_ignored', offer.db_status, offer.db_status, {}, reason, actor);
    }

    return { id: candidateId, status: decision, offerId: candidate.offer_id, offerNewStatus };
  });
}
