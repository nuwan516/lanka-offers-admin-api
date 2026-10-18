import { Router, Request, Response } from 'express';
import { statsRepository } from '@/infrastructure/repositories/stats.repository';
import { jobManager } from '../services/job-manager';
import { scraperScheduler } from '../services/scraper-scheduler';
import { bankRepository } from '@/infrastructure/repositories/bank.repository';
import { evaluateOperationalAlerts, BankHealthInput } from '@/domain/operational-alerts';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  const t0 = Date.now();
  const isHealthy = await statsRepository.checkHealth();
  const dbLatencyMs = Date.now() - t0;

  if (!isHealthy) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      components: {
        process: { status: 'up', uptimeSeconds: Math.floor(process.uptime()), pid: process.pid },
        database: { status: 'disconnected', latencyMs: dbLatencyMs },
        workers: { activeCount: jobManager.getActiveJobs().length, status: 'unknown' },
        scheduler: { status: scraperScheduler.getStatus().enabled ? 'active' : 'disabled' },
      },
      alerts: [
        {
          id: 'alert-db-down',
          level: 'critical',
          component: 'database',
          title: 'Database connection failed',
          description: 'PostgreSQL connection check failed.',
          triggeredAt: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  // Gather bank operational data for alert evaluation
  const schedulerStatus = scraperScheduler.getStatus();
  const bankOverviews = await bankRepository.getBankOverviews().catch(() => []);

  const healthInputs: BankHealthInput[] = bankOverviews.map((b) => ({
    bank: b.bank,
    consecutiveFailures: b.failed_count,
    lastSuccessAt: b.last_success_at,
    lastAttemptAt: b.last_attempted_at,
    lastError: b.error_message,
  }));

  const alerts = evaluateOperationalAlerts(healthInputs);
  const overallStatus = alerts.some((a) => a.level === 'critical')
    ? 'degraded'
    : alerts.length > 0
      ? 'degraded'
      : 'healthy';

  res.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    components: {
      process: {
        status: 'up',
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
        memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      },
      database: {
        status: 'connected',
        latencyMs: dbLatencyMs,
      },
      workers: {
        activeCount: jobManager.getActiveJobs().length,
        maxConcurrent: 3,
        status: 'operational',
      },
      scheduler: {
        status: schedulerStatus.enabled ? 'active' : 'disabled',
        globalEnabled: schedulerStatus.enabled,
        activeSchedules: schedulerStatus.activeSchedules,
        totalSchedules: schedulerStatus.totalSchedules,
      },
      security: {
        autoPublishingEnabled: false,
        autoApprovalEnabled: false,
      },
    },
    alerts,
  });
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
