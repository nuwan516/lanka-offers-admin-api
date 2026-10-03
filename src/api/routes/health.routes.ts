import { Router, Request, Response } from 'express';
import { statsRepository } from '@/infrastructure/repositories/stats.repository';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  const isHealthy = await statsRepository.checkHealth();
  if (isHealthy) {
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } else {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

router.get('/cost-control/status', async (_req: Request, res: Response) => {
  const status = await statsRepository.getCostControlStatus();
  res.json(status);
});

router.get('/stats', async (_req: Request, res: Response) => {
  const stats = await statsRepository.getAdminStats();
  res.json(stats);
});

export const healthRoutes = router;
