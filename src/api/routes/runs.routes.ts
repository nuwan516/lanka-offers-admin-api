import { Router, Request, Response } from 'express';
import { scrapeRunRepository } from '@/infrastructure/repositories/scrape-run.repository';

const router = Router();

router.get('/runs', async (req: Request, res: Response) => {
  const { bank, status, limit = '50' } = req.query as Record<string, string>;
  const items = await scrapeRunRepository.getRuns({
    bank,
    status,
    limit: parseInt(limit, 10),
  });
  res.json({ items, total: items.length });
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  const run = await scrapeRunRepository.getRunById(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const offers = await scrapeRunRepository.getOffersForRun(String(req.params.id));
  res.json({ run, offers });
});

router.post('/runs/:id/rollback', async (req: Request, res: Response) => {
  const { actor = 'admin:rollback', reason } = req.body ?? {};
  const { rollbackScrapeRun } = await import('@/infrastructure/db/rollback-operations');
  const result = await rollbackScrapeRun(String(req.params.id), { actor, reason });
  if (result.outcome === 'not_found') {
    res.status(404).json(result);
    return;
  }
  res.json(result);
});

export const runRoutes = router;
