import { Router, Request, Response } from 'express';
import {
  listDuplicateCandidates,
  getDuplicateCandidateById,
  reviewDuplicateCandidate,
  getDuplicateStats,
} from '@/infrastructure/db/duplicate-repository';
import type { DuplicateReviewStatus } from '@/domain/duplicate-types';
import { mergeDuplicateOffers } from '../services/duplicate-merge-service';
import { WorkflowError } from '@/infrastructure/db/offer-workflow-repository';

const router = Router();

const DUPLICATE_REVIEW_STATUSES: DuplicateReviewStatus[] = ['CONFIRMED_DUPLICATE', 'NOT_DUPLICATE', 'IGNORED'];

router.get('/duplicates', async (req: Request, res: Response) => {
  const { bank, classification, status, minimum_score, limit, offset } = req.query as Record<string, string | undefined>;
  const items = await listDuplicateCandidates({
    bank,
    classification,
    status,
    minimumScore: minimum_score ? parseInt(minimum_score, 10) : undefined,
    limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });
  res.json({ items });
});

router.get('/duplicates/stats', async (_req: Request, res: Response) => {
  res.json(await getDuplicateStats());
});

router.get('/duplicates/:id', async (req: Request, res: Response) => {
  const row = await getDuplicateCandidateById(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'Duplicate candidate not found' });
    return;
  }
  res.json(row);
});

router.post('/duplicates/:id/review', async (req: Request, res: Response) => {
  const { decision, reason } = req.body as { decision: string; reason?: string };
  if (!DUPLICATE_REVIEW_STATUSES.includes(decision as DuplicateReviewStatus)) {
    res.status(400).json({ error: `Invalid decision. Must be one of: ${DUPLICATE_REVIEW_STATUSES.join(', ')}` });
    return;
  }
  try {
    const result = await reviewDuplicateCandidate(String(req.params.id), decision as DuplicateReviewStatus, 'admin', reason ?? null);
    res.json(result);
  } catch (e) {
    if (e instanceof WorkflowError) {
      res.status(404).json({ error: e.message });
      return;
    }
    throw e;
  }
});

router.post('/duplicates/merge', async (req: Request, res: Response) => {
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
});

router.post('/duplicates/:id/merge', async (req: Request, res: Response) => {
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
});

export const duplicateRoutes = router;
