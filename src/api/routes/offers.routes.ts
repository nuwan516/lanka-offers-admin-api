import { Router, Request, Response } from 'express';
import { getOfferById, listOffersWithCount } from '@/infrastructure/db/offer-repository';
import {
  getOfferWorkflow,
  getReviewHistory,
  computeEffectivePreview,
  computePublishedBaseline,
  saveManualCorrection,
  transitionOffer,
  bulkTransitionOffers,
  WorkflowError,
  reconcileExpiredOffers,
} from '@/infrastructure/db/offer-workflow-repository';
import { PUBLIC_LIFECYCLE_STATUSES, type OfferReviewAction } from '@/domain/offer-lifecycle';
import { buildOfferListQuery, sanitizePublicOffer } from '@/api/offer-query-scope';
import { computeThreeWayDiff } from '@/domain/offer-diff';
import { getDuplicateCandidatesForOffer } from '@/infrastructure/db/duplicate-repository';
import { statsRepository } from '@/infrastructure/repositories/stats.repository';
import { validationRepository } from '@/infrastructure/repositories/validation.repository';
import { directLifecyclePatchError } from '@/domain/publication/lifecycle-patch-policy';

const router = Router();

const REVIEW_ACTIONS: OfferReviewAction[] = [
  'APPROVE', 'APPROVE_WITH_CORRECTIONS', 'REJECT', 'SEND_BACK', 'DISABLE', 'PUBLISH', 'UNPUBLISH',
];

const BULK_ACTIONS: OfferReviewAction[] = ['APPROVE', 'REJECT'];

router.get('/offers', async (req: Request, res: Response) => {
  const {
    bank, status, limit = '50', offset = '0', search, scope, locationScope, merchant,
    view, hasPendingCandidate, changeStatus, rulePassed, geoStatus, maxLlmScore,
  } = req.query as Record<string, string | undefined>;

  const q = buildOfferListQuery({
    bank, status, search, scope, locationScope, merchant,
    view, hasPendingCandidate, changeStatus, rulePassed, geoStatus, maxLlmScore,
  });

  const lim = Math.min(parseInt(limit, 10) || 50, 500);
  const off = parseInt(offset, 10) || 0;
  const { items, total } = await listOffersWithCount({
    whereSql: q.whereSql,
    params: q.params,
    nextParamIndex: q.nextParamIndex,
    isAdmin: q.isAdmin,
    limit: lim,
    offset: off,
  });

  res.json({ items, total, limit: lim, offset: off });
});

router.get('/merchants', async (_req: Request, res: Response) => {
  const items = await statsRepository.getMerchants(100);
  res.json({ items });
});

// Registered before /offers/:id so "bulk-transition" is not captured as an id.
router.post('/offers/bulk-transition', async (req: Request, res: Response) => {
  const { action, offerIds, reason, expectedUpdatedAtById } = req.body as {
    action?: string;
    offerIds?: string[];
    reason?: string;
    expectedUpdatedAtById?: Record<string, string>;
  };

  if (!action || !BULK_ACTIONS.includes(action as OfferReviewAction)) {
    res.status(400).json({ error: `Invalid bulk action. Must be one of: ${BULK_ACTIONS.join(', ')}` });
    return;
  }
  if (!Array.isArray(offerIds) || offerIds.length === 0) {
    res.status(400).json({ error: 'offerIds must be a non-empty array' });
    return;
  }
  if (offerIds.length > 100) {
    res.status(400).json({ error: 'Bulk transition limited to 100 offers per request' });
    return;
  }

  try {
    const result = await bulkTransitionOffers(
      offerIds,
      action as OfferReviewAction,
      'admin',
      reason ?? null,
      expectedUpdatedAtById,
    );
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
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
  // Lifecycle status changes must go through transitionOffer so that the
  // legal transition, review history, fencing, and publication re-validation
  // are enforced. A PATCH must never be a second lifecycle API.
  res.status(400).json({ error: directLifecyclePatchError(req.body) });
});

router.get('/offers/:id/review', async (req: Request, res: Response) => {
  const row = await getOfferWorkflow(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Offer not found' });
    return;
  }
  const [history, duplicates, validationReport] = await Promise.all([
    getReviewHistory(row.id),
    getDuplicateCandidatesForOffer(row.id),
    validationRepository.getLatestReportForOffer(row.id),
  ]);

  const effectiveOffer = computeEffectivePreview(row);
  // Live published baseline = last published scrape evidence + manual_override
  // (manual wins). Do not use raw_offer alone — that hides approved corrections.
  const published = computePublishedBaseline(row);
  const candidate = row.pending_candidate ?? row.raw_offer;
  const diff = computeThreeWayDiff(published, candidate, effectiveOffer, row.manual_override, undefined, true);

  res.json({
    offer: row,
    rawOffer: row.raw_offer,
    pendingCandidate: row.pending_candidate,
    publishedOffer: published,
    pendingValidation: (row as Record<string, unknown>).pending_validation ?? null,
    validationReport,
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

router.post('/offers/reconcile-expired', async (req: Request, res: Response) => {
  const isDryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
  const operator = String(req.body?.operator || (isDryRun ? 'admin:preview' : 'admin:reconcile'));
  const result = await reconcileExpiredOffers({ dryRun: isDryRun, operator });
  res.json({
    success: true,
    mode: result.mode,
    skippedDueToLock: result.skippedDueToLock ?? false,
    message: isDryRun
      ? `Preview: Found ${result.expiredCount} expired offer(s) eligible for transition to EXPIRED (no database mutations)`
      : `Reconciled ${result.expiredCount} expired offer(s) from PUBLISHED to EXPIRED`,
    expiredCount: result.expiredCount,
    sampleOfferIds: result.sampleOfferIds ?? [],
  });
});

router.post('/offers/:id/rollback', async (req: Request, res: Response) => {
  const { actor = 'admin:rollback', reason, expectedUpdatedAt } = req.body ?? {};
  const { rollbackSingleOffer } = await import('@/infrastructure/db/rollback-operations');
  const result = await rollbackSingleOffer(String(req.params.id), { actor, reason, expectedUpdatedAt });
  if (result.outcome === 'not_found') {
    res.status(404).json(result);
    return;
  }
  if (result.outcome === 'conflict') {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

export const offerRoutes = router;
