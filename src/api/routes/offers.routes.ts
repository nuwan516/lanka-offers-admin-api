import { Router, Request, Response } from 'express';
import { pool } from '@/infrastructure/db/db-client';
import { getOfferById } from '@/infrastructure/db/offer-repository';
import {
  getOfferWorkflow,
  getReviewHistory,
  computeEffectivePreview,
  saveManualCorrection,
  transitionOffer,
  WorkflowError,
} from '@/infrastructure/db/offer-workflow-repository';
import { PUBLIC_LIFECYCLE_STATUSES, LIFECYCLE_STATUSES, type OfferReviewAction } from '@/domain/offer-lifecycle';
import { buildOfferListQuery, sanitizePublicOffer } from '@/api/offer-query-scope';
import { computeThreeWayDiff } from '@/domain/offer-diff';
import { getDuplicateCandidatesForOffer } from '@/infrastructure/db/duplicate-repository';
import { statsRepository } from '@/infrastructure/repositories/stats.repository';

const router = Router();

const REVIEW_ACTIONS: OfferReviewAction[] = [
  'APPROVE', 'APPROVE_WITH_CORRECTIONS', 'REJECT', 'SEND_BACK', 'DISABLE', 'PUBLISH', 'UNPUBLISH',
];

router.get('/offers', async (req: Request, res: Response) => {
  const { bank, status, limit = '50', offset = '0', search, scope, locationScope, merchant } = req.query as Record<string, string | undefined>;
  const q = buildOfferListQuery({ bank, status, search, scope, locationScope, merchant });

  const lim = Math.min(parseInt(limit, 10), 500);
  const off = parseInt(offset, 10);
  let i = q.nextParamIndex;

  const [rows, countRes] = await Promise.all([
    pool.query(
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

  res.json({ items: rows.rows, total: parseInt(countRes.rows[0].count, 10), limit: lim, offset: off });
});

router.get('/merchants', async (_req: Request, res: Response) => {
  const items = await statsRepository.getMerchants(100);
  res.json({ items });
});

router.get('/offers/:id', async (req: Request, res: Response) => {
  const isAdmin = req.query.scope === 'admin';
  const offer = await getOfferById(String(req.params.id));
  if (!offer) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  if (!isAdmin && !(PUBLIC_LIFECYCLE_STATUSES as string[]).includes(offer.db_status)) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  res.json(isAdmin ? offer : sanitizePublicOffer(offer));
});

router.patch('/offers/:id', async (req: Request, res: Response) => {
  const { db_status } = req.body as { db_status?: string };
  if (db_status && !(LIFECYCLE_STATUSES as string[]).includes(db_status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${LIFECYCLE_STATUSES.join(', ')}` });
    return;
  }
  const result = await pool.query(
    `UPDATE offers SET db_status = COALESCE($1, db_status), updated_at = NOW() WHERE id = $2 RETURNING id, db_status`,
    [db_status, req.params.id]
  );
  if (!result.rows.length) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  res.json(result.rows[0]);
});

router.get('/offers/:id/review', async (req: Request, res: Response) => {
  const row = await getOfferWorkflow(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
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
});

router.post('/offers/:id/correction', async (req: Request, res: Response) => {
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
});

router.post('/offers/:id/transition', async (req: Request, res: Response) => {
  const { action, reason, correction, expectedUpdatedAt } = req.body as {
    action: string;
    reason?: string;
    correction?: Record<string, unknown>;
    expectedUpdatedAt?: string;
  };
  if (!REVIEW_ACTIONS.includes(action as OfferReviewAction)) {
    res.status(400).json({ error: `Invalid action. Must be one of: ${REVIEW_ACTIONS.join(', ')}` });
    return;
  }
  try {
    const result = await transitionOffer(String(req.params.id), action as OfferReviewAction, 'admin', reason ?? null, correction, expectedUpdatedAt);
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      res.status(409).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.get('/offers/:id/history', async (req: Request, res: Response) => {
  const items = await getReviewHistory(String(req.params.id));
  res.json({ items });
});

export const offerRoutes = router;
