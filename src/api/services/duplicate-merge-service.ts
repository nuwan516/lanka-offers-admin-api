import { pool, withTransaction } from '@/infrastructure/db/db-client';
import { logHistory, WorkflowError } from '@/infrastructure/db/offer-workflow-repository';

export interface MergeDuplicateParams {
  canonicalOfferId: string;
  duplicateOfferId: string;
  reason?: string;
  actor?: string;
}

export interface MergeDuplicateResult {
  success: boolean;
  canonicalOfferId: string;
  disabledOfferId: string;
  mergedAt: string;
  provenanceRecorded: {
    sourceUrl?: string | null;
    bank: string;
    contentHash?: string | null;
  };
}

export async function mergeDuplicateOffers({
  canonicalOfferId,
  duplicateOfferId,
  reason = 'Admin confirmed duplicate merge',
  actor = 'admin',
}: MergeDuplicateParams): Promise<MergeDuplicateResult> {
  if (!canonicalOfferId || !duplicateOfferId) {
    throw new WorkflowError('Both canonicalOfferId and duplicateOfferId are required');
  }

  if (canonicalOfferId === duplicateOfferId) {
    throw new WorkflowError('Cannot merge an offer into itself');
  }

  return withTransaction(async (client) => {
    // 1. Lock both rows in a deterministic order to prevent deadlocks
    const [firstId, secondId] = [canonicalOfferId, duplicateOfferId].sort();
    const rowsRes = await client.query(
      `SELECT * FROM offers WHERE id IN ($1, $2) FOR UPDATE`,
      [firstId, secondId]
    );

    if (rowsRes.rows.length < 2) {
      throw new WorkflowError('One or both offers not found for duplicate merge');
    }

    const canonical = rowsRes.rows.find((r) => r.id === canonicalOfferId);
    const duplicate = rowsRes.rows.find((r) => r.id === duplicateOfferId);

    if (!canonical || !duplicate) {
      throw new WorkflowError('Failed to resolve canonical and duplicate records');
    }

    if (duplicate.db_status === 'DISABLED' && duplicate.change_status === 'MERGED') {
      throw new WorkflowError('Duplicate offer has already been merged');
    }

    const mergedAt = new Date().toISOString();

    // 2. Preserve raw provenance on canonical offer
    const currentOverride = (canonical.manual_override ?? {}) as Record<string, unknown>;
    const priorProvenance = Array.isArray(currentOverride._merged_provenance)
      ? currentOverride._merged_provenance
      : [];

    const provenanceItem = {
      mergedOfferId: duplicate.id,
      bank: duplicate.bank,
      sourceUrl: duplicate.source_url,
      contentHash: duplicate.content_hash,
      scrapedAt: duplicate.raw_offer?.scrapedAt ?? duplicate.created_at,
      rawTitle: duplicate.title,
      mergedAt,
      reason,
      mergedBy: actor,
    };

    const updatedOverride = {
      ...currentOverride,
      _merged_provenance: [...priorProvenance, provenanceItem],
    };

    // 3. Update canonical offer with preserved provenance
    await client.query(
      `UPDATE offers
       SET manual_override = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [canonicalOfferId, JSON.stringify(updatedOverride)]
    );

    // 4. Disable the duplicate offer so it can never be published or re-surfaced
    await client.query(
      `UPDATE offers
       SET db_status = 'DISABLED',
           change_status = 'MERGED',
           pending_candidate = NULL,
           pending_lifecycle_status = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [duplicateOfferId]
    );

    // 5. Update duplicate candidates linking these offers to CONFIRMED_DUPLICATE
    await client.query(
      `UPDATE offer_duplicate_candidates
       SET status = 'CONFIRMED_DUPLICATE',
           reviewed_at = NOW(),
           reviewed_by = $3
       WHERE (offer_id = $1 AND candidate_offer_id = $2)
          OR (offer_id = $2 AND candidate_offer_id = $1)`,
      [canonicalOfferId, duplicateOfferId, actor]
    );

    // 6. Record audit review history on both offers
    await logHistory(
      client,
      duplicateOfferId,
      'merged',
      duplicate.db_status,
      'DISABLED',
      { canonicalOfferId, reason },
      `Merged into canonical offer ${canonicalOfferId}: ${reason}`,
      actor
    );

    await logHistory(
      client,
      canonicalOfferId,
      'source_merged',
      canonical.db_status,
      canonical.db_status,
      { duplicateOfferId, provenanceItem },
      `Preserved provenance from merged duplicate ${duplicateOfferId}`,
      actor
    );

    return {
      success: true,
      canonicalOfferId,
      disabledOfferId: duplicateOfferId,
      mergedAt,
      provenanceRecorded: {
        sourceUrl: duplicate.source_url,
        bank: duplicate.bank,
        contentHash: duplicate.content_hash,
      },
    };
  });
}
