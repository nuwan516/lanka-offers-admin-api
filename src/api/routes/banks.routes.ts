import { Router, Request, Response } from 'express';
import { bankRepository } from '@/infrastructure/repositories/bank.repository';

const router = Router();

router.get('/banks', async (_req: Request, res: Response) => {
  const items = await bankRepository.getBanksOverview();
  res.json({ items });
});

export const bankRoutes = router;
