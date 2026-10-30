/**
 * Lanka Offers — Production Rollback Operations
 *
 * Implements safe, auditable, transaction-backed rollback mechanisms:
 * - Identifies records actually created or changed by the target operation.
 * - Preserves pre-existing published offers (clearing staged candidates without mutating live published data).
 * - Never overwrites later operator actions (respects subsequent human reviews/approvals).
 * - Optimistic concurrency checks and transactions prevent races.
 * - Maintains complete audit history in offer_review_history.
 * - Idempotent: repeated calls safely return already_rolled_back.
 */

import { pool, withTransaction } from './db-client';
import { logHistory, type OfferWorkflowRow } from './offer-workflow-repository';

export interface ScrapeRunRollbackSummary {
  outcome: 'rolled_back' | 'already_rolled_back' | 'not_found' | 'failed';
  runId: string;
  candidatesCleared: number;
  newOffersDisabled: number;
  preservedPublished: number;
  preservedOperatorActions: number;
  totalAffected: number;
  error?: string;
}

export interface PublicationRollbackSummary {
  outcome: 'rolled_back' | 'already_rolled_back' | 'not_found' | 'failed';
  syncRunId: string;
  revertedCount: number;
  preservedPublished: number;
  skippedLaterOperatorActions: number;
  totalAffected: number;
  error?: string;
}

export interface SingleOfferRollbackSummary {
  outcome: 'rolled_back' | 'not_found' | 'conflict' | 'failed';
  offerId: string;
  fromStatus: string;
  toStatus: string;
  clearedPendingCandidate: boolean;
  error?: string;
}

/**
 * Safely rolls back a scrape run:
 * - If a published offer had candidate changes staged by this run, clears the candidate
 *   while leaving the live published offer 100% active.
 * - If an offer was newly created by this run and has had NO subsequent human approval,
 *   disables it.
 * - If an offer was subsequently reviewed or approved by an operator, preserves the operator's action.
 * - Idempotent: repeated calls on the same run return already_rolled_back.
 */
export async function rollbackScrapeRun(
  runId: string,
  options: { actor?: string; reason?: string } = {}
): Promise<ScrapeRunRollbackSummary> {
  const actor = options.actor ?? 'admin:rollback';
  const reason = options.reason ?? 'Operator triggered scrape run rollback';

  return withTransaction(async (client) => {
    // 1. Verify target scrape run
    const runRes = await client.query<{ id: string; status: string; started_at: string }>(
      'SELECT id, status, started_at FROM scrape_runs WHERE id = $1 FOR UPDATE',
      [runId]
    );
    const run = runRes.rows[0];
    if (!run) {
      return {
        outcome: 'not_found',
        runId,
        candidatesCleared: 0,
        newOffersDisabled: 0,
        preservedPublished: 0,
        preservedOperatorActions: 0,
        totalAffected: 0,
        error: `Scrape run ${runId} not found`,
      };
    }

    if (run.status === 'rolled_back') {
      return {
        outcome: 'already_rolled_back',
        runId,
        candidatesCleared: 0,
        newOffersDisabled: 0,
        preservedPublished: 0,
        preservedOperatorActions: 0,
        totalAffected: 0,
      };
    }

    // 2. Identify all offers touched by this scrape run
    const offersRes = await client.query<OfferWorkflowRow>(
      'SELECT * FROM offers WHERE scrape_run_id = $1 FOR UPDATE',
      [runId]
    );

    let candidatesCleared = 0;
    let newOffersDisabled = 0;
    let preservedPublished = 0;
    let preservedOperatorActions = 0;

    for (const offer of offersRes.rows) {
      // Check for subsequent human operator actions since the scrape run
      const laterActionsRes = await client.query<{ id: string; action: string }>(
        `SELECT id, action FROM offer_review_history
         WHERE offer_id = $1 AND created_at >= $2
           AND action IN ('approve', 'approved', 'published', 'publish', 'reject', 'rejected', 'disable', 'disabled', 'corrected', 'unpublish')
           AND actor != $3
         ORDER BY created_at ASC`,
        [offer.id, run.started_at, actor]
      );

      if (laterActionsRes.rows.length > 0) {
        // Subsequent operator decision takes precedence; do not overwrite!
        preservedOperatorActions++;
        continue;
      }

      if (offer.db_status === 'PUBLISHED') {
        if (offer.pending_candidate != null) {
          // Invariant #3: Offer was already published; this run only staged a candidate update.
          // Reverting the scrape run clears the candidate while leaving live published offer active!
          await client.query(
            `UPDATE offers
             SET pending_candidate = NULL, pending_lifecycle_status = NULL, pending_change_status = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [offer.id]
          );
          await logHistory(
            client,
            offer.id,
            'rollback_scrape_candidate',
            offer.db_status,
            offer.db_status,
            { cleared_candidate_from_run: runId },
            reason,
            actor
          );
          candidatesCleared++;
        }
        preservedPublished++;
      } else {
        // Newly created or unapproved staging offer from this run
        await client.query(
          `UPDATE offers
           SET db_status = 'DISABLED', change_status = 'FAILED', updated_at = NOW()
           WHERE id = $1`,
          [offer.id]
        );
        await logHistory(
          client,
          offer.id,
          'rollback_scrape_new',
          offer.db_status,
          'DISABLED',
          { disabled_new_offer_from_run: runId },
          reason,
          actor
        );
        newOffersDisabled++;
      }
    }

    // 3. Mark scrape run as rolled back
    await client.query(
      `UPDATE scrape_runs
       SET status = 'rolled_back', error_message = COALESCE($2, error_message, 'Rolled back by operator')
       WHERE id = $1`,
      [runId, reason]
    );

    return {
      outcome: 'rolled_back',
      runId,
      candidatesCleared,
      newOffersDisabled,
      preservedPublished,
      preservedOperatorActions,
      totalAffected: candidatesCleared + newOffersDisabled,
    };
  });
}

/**
 * Safely rolls back a publication sync batch:
 * - Identifies offers that transitioned to PUBLISHED during this specific sync run.
 * - Never overwrites offers that have received later operator actions.
 * - Reverts published offers to their pre-publication state (REVIEW_REQUIRED or APPROVED).
 * - Idempotent: repeated calls on the same sync run return already_rolled_back.
 */
export async function rollbackPublicationRun(
  syncRunId: string,
  options: { actor?: string; reason?: string } = {}
): Promise<PublicationRollbackSummary> {
  const actor = options.actor ?? 'admin:rollback';
  const reason = options.reason ?? 'Operator triggered publication batch rollback';

  return withTransaction(async (client) => {
    // 1. Verify target sync run
    const syncRes = await client.query<{ id: string; status: string; started_at: string; finished_at: string | null }>(
      'SELECT id, status, started_at, finished_at FROM offer_sync_runs WHERE id = $1 FOR UPDATE',
      [syncRunId]
    );
    const syncRun = syncRes.rows[0];
    if (!syncRun) {
      return {
        outcome: 'not_found',
        syncRunId,
        revertedCount: 0,
        preservedPublished: 0,
        skippedLaterOperatorActions: 0,
        totalAffected: 0,
        error: `Sync run ${syncRunId} not found`,
      };
    }

    if (syncRun.status === 'rolled_back') {
      return {
        outcome: 'already_rolled_back',
        syncRunId,
        revertedCount: 0,
        preservedPublished: 0,
        skippedLaterOperatorActions: 0,
        totalAffected: 0,
      };
    }

    // 2. Identify offers published during this sync run via audit history
    const historyEntries = await client.query<{
      offer_id: string;
      from_status: string | null;
      to_status: string | null;
      created_at: string;
    }>(
      `SELECT offer_id, from_status, to_status, created_at
       FROM offer_review_history
       WHERE action = 'published'
         AND created_at >= $1
         AND created_at <= COALESCE($2, NOW() + interval '1 second')
       ORDER BY created_at ASC`,
      [syncRun.started_at, syncRun.finished_at]
    );

    let revertedCount = 0;
    let preservedPublished = 0;
    let skippedLaterOperatorActions = 0;

    for (const entry of historyEntries.rows) {
      const offerRes = await client.query<OfferWorkflowRow>(
        'SELECT * FROM offers WHERE id = $1 FOR UPDATE',
        [entry.offer_id]
      );
      const offer = offerRes.rows[0];
      if (!offer) continue;

      // Check if subsequent operator actions occurred on this offer after this publication
      const laterActionsRes = await client.query<{ id: string }>(
        `SELECT id FROM offer_review_history
         WHERE offer_id = $1 AND created_at > $2
           AND actor != $3
         ORDER BY created_at ASC`,
        [offer.id, entry.created_at, actor]
      );

      if (laterActionsRes.rows.length > 0) {
        skippedLaterOperatorActions++;
        continue;
      }

      if (offer.db_status === 'PUBLISHED') {
        const revertTo = entry.from_status && entry.from_status !== 'PUBLISHED'
          ? entry.from_status
          : 'REVIEW_REQUIRED';

        await client.query(
          `UPDATE offers
           SET db_status = $2, updated_at = NOW()
           WHERE id = $1`,
          [offer.id, revertTo]
        );
        await logHistory(
          client,
          offer.id,
          'rollback_publication',
          'PUBLISHED',
          revertTo,
          { reverted_sync_run_id: syncRunId },
          reason,
          actor
        );
        revertedCount++;
      } else {
        preservedPublished++;
      }
    }

    // 3. Mark sync run as rolled back
    await client.query(
      `UPDATE offer_sync_runs SET status = 'rolled_back' WHERE id = $1`,
      [syncRunId]
    );

    return {
      outcome: 'rolled_back',
      syncRunId,
      revertedCount,
      preservedPublished,
      skippedLaterOperatorActions,
      totalAffected: revertedCount,
    };
  });
}

/**
 * Safely rolls back a single offer with optimistic concurrency protection:
 * - If published: unpublishes it to REVIEW_REQUIRED.
 * - If pending candidate exists: clears candidate.
 * - Emits audit trail entry.
 */
export async function rollbackSingleOffer(
  offerId: string,
  options: { actor?: string; reason?: string; expectedUpdatedAt?: string } = {}
): Promise<SingleOfferRollbackSummary> {
  const actor = options.actor ?? 'admin:rollback';
  const reason = options.reason ?? 'Operator rolled back single offer';

  return withTransaction(async (client) => {
    const offerRes = await client.query<OfferWorkflowRow>(
      'SELECT * FROM offers WHERE id = $1 FOR UPDATE',
      [offerId]
    );
    const offer = offerRes.rows[0];
    if (!offer) {
      return {
        outcome: 'not_found',
        offerId,
        fromStatus: 'UNKNOWN',
        toStatus: 'UNKNOWN',
        clearedPendingCandidate: false,
        error: `Offer ${offerId} not found`,
      };
    }

    if (options.expectedUpdatedAt && offer.updated_at) {
      const currentTs = new Date(offer.updated_at as string | number | Date).getTime();
      const expectedTs = new Date(options.expectedUpdatedAt).getTime();
      if (!isNaN(expectedTs) && Math.abs(currentTs - expectedTs) > 1000) {
        return {
          outcome: 'conflict',
          offerId,
          fromStatus: offer.db_status,
          toStatus: offer.db_status,
          clearedPendingCandidate: false,
          error: 'Concurrent modification conflict: offer was modified by another operator.',
        };
      }
    }

    let clearedPendingCandidate = false;
    let targetStatus = offer.db_status;

    if (offer.pending_candidate != null) {
      clearedPendingCandidate = true;
    }

    if (offer.db_status === 'PUBLISHED') {
      targetStatus = 'REVIEW_REQUIRED';
    }

    await client.query(
      `UPDATE offers
       SET db_status = $2,
           pending_candidate = NULL,
           pending_lifecycle_status = NULL,
           pending_change_status = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [offerId, targetStatus]
    );

    await logHistory(
      client,
      offerId,
      'rollback_offer',
      offer.db_status,
      targetStatus,
      { clearedPendingCandidate },
      reason,
      actor
    );

    return {
      outcome: 'rolled_back',
      offerId,
      fromStatus: offer.db_status,
      toStatus: targetStatus,
      clearedPendingCandidate,
    };
  });
}
