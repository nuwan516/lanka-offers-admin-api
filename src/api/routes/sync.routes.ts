import { Router, Request, Response } from 'express';
import {
  getSyncPreview,
  syncApprovedOffer,
  bulkSyncApprovedOffers,
} from '@/infrastructure/db/offer-workflow-repository';
import { scrapeRunRepository } from '@/infrastructure/repositories/scrape-run.repository';

const router = Router();

router.get('/sync/preview', async (_req: Request, res: Response) => {
  res.json(await getSyncPreview());
});

router.post('/sync/:id', async (req: Request, res: Response) => {
  res.json(await syncApprovedOffer(String(req.params.id)));
});

router.post('/sync', async (_req: Request, res: Response) => {
  res.json(await bulkSyncApprovedOffers('admin'));
});

router.get('/sync/runs', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const rows = await scrapeRunRepository.getSyncRuns(limit);
  res.json({ items: rows });
});

export const syncRoutes = router;
