import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { jobManager, VALID_BANKS } from '../services/job-manager';

const router = Router();
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

router.post('/geocode/:bank', (req: Request, res: Response) => {
  const bank = String(req.params.bank);
  try {
    const job = jobManager.startGeocodeJob(bank);
    res.json({ message: `Geocode started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('already running')) {
      res.status(409).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

router.post('/scrape/:bank', (req: Request, res: Response) => {
  const bank = String(req.params.bank);
  const { cache, llm, noValidate, skipDetails, concurrency, maxCategories } = (req.body ?? {}) as {
    cache?: boolean;
    llm?: boolean;
    noValidate?: boolean;
    skipDetails?: boolean;
    concurrency?: number;
    maxCategories?: number;
  };

  try {
    const job = jobManager.startScrapeJob(bank, {
      cache,
      llm,
      noValidate,
      skipDetails,
      concurrency,
      maxCategories,
    });
    res.json({ message: `Scrape started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes('already running') ||
      msg.includes('Cannot run') ||
      msg.includes('Cannot start') ||
      msg.includes('limit reached')
    ) {
      res.status(409).json({ error: msg });
      return;
    }
    res.status(400).json({ error: msg });
  }
});

router.post('/scrape/:bank/cancel', async (req: Request, res: Response) => {
  const bank = String(req.params.bank);
  const result = await jobManager.cancelScrapeJob(bank, 'operator');
  if (!result.cancelled) {
    res.status(404).json({ error: `No active scraper found running for bank: ${bank}` });
    return;
  }
  res.json({ message: `Scraper for ${bank} cancelled successfully`, ...result });
});

router.delete('/scrape/:bank', async (req: Request, res: Response) => {
  const bank = String(req.params.bank);
  const result = await jobManager.cancelScrapeJob(bank, 'operator');
  if (!result.cancelled) {
    res.status(404).json({ error: `No active scraper found running for bank: ${bank}` });
    return;
  }
  res.json({ message: `Scraper for ${bank} cancelled successfully`, ...result });
});

router.post('/scrape/:bank/retry', async (req: Request, res: Response) => {
  const bank = String(req.params.bank);
  const options = (req.body ?? {}) as any;
  try {
    const job = await jobManager.retryScrapeJob(bank, options, 'operator');
    res.json({ message: `Scrape retry started for ${bank}`, ...job });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(409).json({ error: msg });
  }
});

router.get('/scrape/status', (_req: Request, res: Response) => {
  res.json({
    active: jobManager.getActiveJobs(),
    activeGeo: jobManager.getActiveGeoJobs(),
  });
});

interface LogEntry {
  ts: string;
  level: string;
  bank: string;
  tag?: string;
  message: string;
  pid?: number;
  data?: Record<string, unknown>;
}

router.get('/logs', async (req: Request, res: Response) => {
  const rawBank = req.query.bank ? String(req.query.bank).toLowerCase() : undefined;
  const bankFilter = rawBank && VALID_BANKS.includes(rawBank) ? rawBank : rawBank === 'all' ? undefined : rawBank ? 'INVALID' : undefined;

  if (bankFilter === 'INVALID') {
    res.json({ items: [], total: 0 });
    return;
  }

  const levelFilter = req.query.level ? String(req.query.level).toUpperCase() : undefined;
  const tagFilter = req.query.tag ? String(req.query.tag) : undefined;
  const search = req.query.search ? String(req.query.search).toLowerCase() : undefined;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);

  const logsDir = path.resolve(PROJECT_ROOT, 'logs');
  if (!fs.existsSync(logsDir)) {
    res.json({ items: [], total: 0 });
    return;
  }

  const bankDirs = fs.readdirSync(logsDir).filter((d) => {
    const full = path.resolve(logsDir, d);
    if (!full.startsWith(logsDir)) return false;
    if (!fs.statSync(full).isDirectory()) return false;
    if (bankFilter && d.toLowerCase() !== bankFilter) return false;
    return true;
  });

  const entries: LogEntry[] = [];

  for (const bDir of bankDirs) {
    const dirPath = path.resolve(logsDir, bDir);
    if (!dirPath.startsWith(logsDir)) continue;

    const files = fs.readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();

    for (const f of files.slice(0, 3)) {
      const filePath = path.resolve(dirPath, f);
      if (!filePath.startsWith(dirPath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (levelFilter && levelFilter !== 'ALL' && parsed.level?.toUpperCase() !== levelFilter) continue;
          if (tagFilter && tagFilter !== 'ALL' && parsed.tag !== tagFilter) continue;
          if (search && !parsed.message?.toLowerCase().includes(search) && !parsed.tag?.toLowerCase().includes(search)) continue;
          entries.push({
            ts: parsed.ts || parsed.timestamp || new Date().toISOString(),
            level: parsed.level ?? 'INFO',
            bank: parsed.bank ?? bDir,
            tag: parsed.tag ?? 'SYSTEM',
            message: parsed.message ?? (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)),
            pid: parsed.pid,
            data: parsed.data || (parsed.metadata ? parsed.metadata : undefined),
          });
          if (entries.length >= limit * 2) break;
        } catch {
          // ignore malformed lines
        }
      }
      if (entries.length >= limit * 2) break;
    }
  }

  entries.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  res.json({ items: entries.slice(0, limit), total: entries.length });
});

export const scraperRoutes = router;
