import { Router, Request, Response } from 'express';
import { scraperScheduler } from '../services/scraper-scheduler';

const router = Router();

router.get('/schedule', (_req: Request, res: Response) => {
  try {
    const status = scraperScheduler.getStatus();
    res.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post('/schedule/toggle-global', (req: Request, res: Response) => {
  try {
    const { enabled, operator } = (req.body ?? {}) as { enabled: boolean; operator?: string };
    const result = scraperScheduler.toggleGlobal(Boolean(enabled), operator || 'operator');
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

router.post('/schedule/:id/toggle', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { enabled, operator } = (req.body ?? {}) as { enabled: boolean; operator?: string };
    const updated = scraperScheduler.toggleSchedule(id, Boolean(enabled), operator || 'operator');
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

router.post('/schedule/:id/run-now', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const { operator } = (req.body ?? {}) as { operator?: string };
    const job = await scraperScheduler.triggerRunNow(id, operator || 'operator');
    res.json({ message: `Triggered manual execution for ${id}`, ...job });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already running')) {
      res.status(409).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

export default router;
