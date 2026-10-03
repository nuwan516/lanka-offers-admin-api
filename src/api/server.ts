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

const app = express();
const PORT = Number(process.env.API_PORT ?? 3001);

app.use(cors());
app.use(express.json());
app.use(correlationMiddleware);

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
const server = app.listen(PORT, async () => {
  console.log(`Lanka Offers Admin API running on http://localhost:${PORT}`);
  console.log(formatSafePolicySummary());
  try {
    await initDatabaseSchemas();
    console.log('[DB] Schemas and PostGIS extensions initialized successfully');
    await jobManager.recoverStaleRunsOnStartup();
  } catch (e) {
    console.warn('[DB] Could not init database schemas:', (e as Error).message);
  }
});

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
  await jobManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] SIGTERM received, shutting down gracefully...');
  await jobManager.shutdown();
  process.exit(0);
});

export default app;
