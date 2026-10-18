#!/usr/bin/env ts-node
/**
 * Safe PostGIS Geometry Backfill Utility (Batch E3)
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/backfill-geometry.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register src/cli/backfill-geometry.ts --commit --batch-size=100
 *   npx ts-node -r tsconfig-paths/register src/cli/backfill-geometry.ts --rollback
 *
 * Safety guarantees:
 * - Dry-run preview enabled by default.
 * - Idempotent: only touches offers where geom IS NULL.
 * - Guarded against malformed, NaN, or non-numeric coordinates.
 * - Respects Sri Lankan geographic envelope (lat: 5.5 - 10.0, lng: 79.5 - 82.0).
 * - Never invents approximate coordinates for ONLINE, NATIONWIDE, or UNRESOLVED offers.
 */

import 'dotenv/config';
import { pool, closePool } from '@/infrastructure/db/db-client';

interface BackfillOptions {
  dryRun: boolean;
  commit: boolean;
  rollback: boolean;
  batchSize: number;
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  const opts: BackfillOptions = {
    dryRun: true,
    commit: false,
    rollback: false,
    batchSize: 100,
  };

  for (const arg of args) {
    if (arg === '--commit') {
      opts.commit = true;
      opts.dryRun = false;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
      opts.commit = false;
    } else if (arg === '--rollback') {
      opts.rollback = true;
      opts.dryRun = false;
      opts.commit = false;
    } else if (arg.startsWith('--batch-size=')) {
      opts.batchSize = Math.max(1, parseInt(arg.split('=')[1], 10) || 100);
    }
  }

  return opts;
}

async function run(): Promise<void> {
  const opts = parseArgs();
  console.log(`[GeometryBackfill] Mode: ${opts.rollback ? 'ROLLBACK' : opts.commit ? 'COMMIT (LIVE UPDATE)' : 'DRY-RUN PREVIEW'}`);
  console.log(`[GeometryBackfill] Batch size: ${opts.batchSize}`);

  if (opts.rollback) {
    console.log('[GeometryBackfill] Executing rollback: resetting backfilled geom values to NULL...');
    const rb = await pool.query(`
      UPDATE offers
      SET geom = NULL
      WHERE geom IS NOT NULL AND geo_status = 'backfilled_postgis'
      RETURNING id
    `);
    console.log(`[GeometryBackfill] Rollback completed: ${rb.rowCount ?? 0} offer geometries cleared.`);
    await closePool().catch(() => {});
    return;
  }

  // 1. Candidate Counts
  const candidateRes = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM offers
    WHERE geom IS NULL
      AND db_status = 'PUBLISHED'
      AND location_scope NOT IN ('ONLINE', 'NATIONWIDE', 'UNRESOLVED')
      AND geo_locations IS NOT NULL
      AND jsonb_typeof(geo_locations) = 'array'
      AND jsonb_array_length(geo_locations) > 0
      AND jsonb_typeof(geo_locations->0) = 'object'
      AND (geo_locations->0->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
      AND (geo_locations->0->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
      AND (geo_locations->0->>'lat')::double precision BETWEEN 5.5 AND 10.0
      AND (geo_locations->0->>'lng')::double precision BETWEEN 79.5 AND 82.0
  `);

  const totalCandidates = parseInt(candidateRes.rows[0]?.count ?? '0', 10);
  console.log(`[GeometryBackfill] Candidate offers eligible for PostGIS point projection: ${totalCandidates}`);

  if (totalCandidates === 0) {
    console.log('[GeometryBackfill] No candidate offers need geometry projection.');
    await closePool().catch(() => {});
    return;
  }

  if (opts.dryRun) {
    console.log('[GeometryBackfill] DRY-RUN PREVIEW COMPLETED. 0 rows mutated.');
    console.log('To apply geometry projection in chunks, re-run with: --commit --batch-size=100');
    await closePool().catch(() => {});
    return;
  }

  // 2. Chunked Execution
  let processed = 0;
  while (processed < totalCandidates) {
    const updateRes = await pool.query(`
      WITH chunk AS (
        SELECT id,
          (geo_locations->0->>'lng')::double precision AS lng,
          (geo_locations->0->>'lat')::double precision AS lat
        FROM offers
        WHERE geom IS NULL
          AND db_status = 'PUBLISHED'
          AND location_scope NOT IN ('ONLINE', 'NATIONWIDE', 'UNRESOLVED')
          AND geo_locations IS NOT NULL
          AND jsonb_typeof(geo_locations) = 'array'
          AND jsonb_array_length(geo_locations) > 0
          AND (geo_locations->0->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
          AND (geo_locations->0->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
          AND (geo_locations->0->>'lat')::double precision BETWEEN 5.5 AND 10.0
          AND (geo_locations->0->>'lng')::double precision BETWEEN 79.5 AND 82.0
        LIMIT $1
      )
      UPDATE offers o
      SET geom = ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography,
          geo_status = 'backfilled_postgis',
          updated_at = NOW()
      FROM chunk c
      WHERE o.id = c.id
      RETURNING o.id
    `, [opts.batchSize]);

    const count = updateRes.rowCount ?? 0;
    if (count === 0) break;

    processed += count;
    console.log(`[GeometryBackfill] Projected chunk of ${count} offers (${processed}/${totalCandidates} total).`);
  }

  // 3. Post-Backfill Verification
  const verifyRes = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM offers
    WHERE geom IS NOT NULL
  `);
  console.log(`[GeometryBackfill] Post-backfill verified: ${verifyRes.rows[0]?.count} total offers now indexed with PostGIS geography point.`);
  await closePool().catch(() => {});
}

run().catch((err) => {
  console.error('[GeometryBackfill] Fatal error:', err);
  process.exit(1);
});
