/**
 * Lanka Offers Admin API server.
 * Run: npx ts-node -r tsconfig-paths/register src/api/server.ts
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';

import { correlationMiddleware } from './middleware/correlation';
import { errorHandler } from './middleware/error-handler';
import { formatSafePolicySummary } from '@/config/cost-control';
import { jobManager } from './services/job-manager';
import { initDatabaseSchemas } from '@/infrastructure/db/db-init';

import { healthRoutes } from './routes/health.routes';
import { offerRoutes } from './routes/offers.routes';
import { duplicateRoutes } from './routes/duplicates.routes';
import { syncRoutes } from './routes/sync.routes';
import { runRoutes } from './routes/runs.routes';
import { validationRoutes } from './routes/validation.routes';
import { bankRoutes } from './routes/banks.routes';
import { bankParserRulesRoutes } from './routes/bank-parser-rules.routes';
import { goldenCasesRoutes } from './routes/golden-cases.routes';
import { scraperRoutes } from './routes/scraper.routes';
import { geoRoutes } from './routes/geo.routes';
import scheduleRoutes from './routes/schedule.routes';
import { scraperScheduler } from './services/scraper-scheduler';
import { adminNetworkGuard } from './middleware/admin-network-guard';

const app = express();
const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 3002);
const HOST = process.env.ADMIN_HOST ?? '127.0.0.1';

const allowedAdminOrigins = (process.env.ADMIN_CORS_ORIGINS ?? 'http://localhost:3002,http://127.0.0.1:3002,http://localhost:5174,http://127.0.0.1:5174,http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim());

// Reject untrusted reverse proxy spoofing by default (Batch F2)
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedAdminOrigins.includes('*') || allowedAdminOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for unauthorized admin origin: ${origin}`));
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(correlationMiddleware);
app.use(adminNetworkGuard);

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api', healthRoutes);
app.use('/api', offerRoutes);
app.use('/api', duplicateRoutes);
app.use('/api', syncRoutes);
app.use('/api', runRoutes);
app.use('/api', validationRoutes);
app.use('/api', bankRoutes);
app.use('/api', bankParserRulesRoutes);
app.use('/api', goldenCasesRoutes);
app.use('/api', scraperRoutes);
app.use('/api', geoRoutes);
app.use('/api', scheduleRoutes);

// ─── Admin Dashboard Static Assets ────────────────────────────────────────────
const CANDIDATE_DISTS = [
  path.resolve(__dirname, '../../../dashboard/dist'),
  path.resolve(__dirname, '../../../../admin/dashboard/dist'),
  path.resolve(__dirname, '../../../dist'),
];

const ADMIN_DIST = CANDIDATE_DISTS.find((p) => fs.existsSync(p)) ?? CANDIDATE_DISTS[0];
const adminIndexHtml = path.join(ADMIN_DIST, 'index.html');

app.use(express.static(ADMIN_DIST));

// SPA fallback for admin dashboard
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(adminIndexHtml, (err) => {
    if (err) {
      res.type('html').send(
        '<pre style="font-family:monospace;padding:2rem">' +
        '<strong>Admin Dashboard UI not built.</strong>\n\n' +
        'Run: cd admin/dashboard &amp;&amp; npm run build\n\n' +
        'API is running at <a href="/api/health">/api/health</a>' +
        '</pre>'
      );
    } else {
      next(err);
    }
  });
});

// Centralized error handling
app.use(errorHandler);

// ─── Server Startup ───────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, async () => {
  console.log(`Lanka Offers Admin API running on http://${HOST}:${PORT}`);
  console.log(formatSafePolicySummary());
  try {
    await initDatabaseSchemas();
    console.log('[DB] Schemas and PostGIS extensions initialized successfully');
    await jobManager.recoverStaleRunsOnStartup();
    await scraperScheduler.init();

    // ─── Configurable Expiry Reconciliation Policy ──────────────────────────
    // Disabled by default to protect production against unintended mutations.
    // Set ENABLE_EXPIRY_RECONCILIATION=true and EXPIRY_RECONCILIATION_MODE=mutate in .env to authorize mutations.
    const enableReconciliation = process.env.ENABLE_EXPIRY_RECONCILIATION === 'true';
    const isMutateMode = process.env.EXPIRY_RECONCILIATION_MODE === 'mutate';

    if (!enableReconciliation) {
      console.log('[Lifecycle] Automatic background expiry reconciliation is DISABLED by policy (default safe state).');
    } else {
      const { reconcileExpiredOffers } = await import('@/infrastructure/db/offer-workflow-repository');
      const startupResult = await reconcileExpiredOffers({ dryRun: !isMutateMode });
      if (startupResult.skippedDueToLock) {
        console.log('[Lifecycle] Startup reconciliation skipped: another instance holds the distributed advisory lock.');
      } else if (startupResult.mode === 'preview') {
        console.log(`[Lifecycle] Startup reconciliation (READ-ONLY PREVIEW): ${startupResult.expiredCount} expired offer(s) identified (zero DB mutations).`);
      } else {
        console.log(`[Lifecycle] Startup reconciliation (AUTHORIZED MUTATE): ${startupResult.expiredCount} expired offer(s) transitioned to EXPIRED.`);
      }

      // Schedule periodic reconciliation every 6 hours if authorized
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      expiryInterval = setInterval(async () => {
        try {
          const { reconcileExpiredOffers: runReconcile } = await import('@/infrastructure/db/offer-workflow-repository');
          const res = await runReconcile({ dryRun: !isMutateMode });
          if (!res.skippedDueToLock && res.expiredCount > 0) {
            console.log(`[Lifecycle] Periodic reconciliation (${res.mode}): ${res.expiredCount} expired offer(s) processed.`);
          }
        } catch (err) {
          console.warn('[Lifecycle] Periodic expiry reconciliation error:', err);
        }
      }, SIX_HOURS_MS);
      expiryInterval.unref();
    }
  } catch (e) {
    console.warn('[DB] Startup task warning:', (e as Error).message);
  }
});

let expiryInterval: NodeJS.Timeout | null = null;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Port ${PORT} is already in use. Kill the existing process or set API_PORT in .env`);
  } else {
    console.error('[FATAL] Server error:', err.message);
  }
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n[Server] SIGINT received, shutting down gracefully...');
  if (expiryInterval) clearInterval(expiryInterval);
  scraperScheduler.shutdown();
  await jobManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] SIGTERM received, shutting down gracefully...');
  if (expiryInterval) clearInterval(expiryInterval);
  scraperScheduler.shutdown();
  await jobManager.shutdown();
  process.exit(0);
});

export default app;
