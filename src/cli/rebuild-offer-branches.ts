#!/usr/bin/env ts-node
/**
 * Rebuild denormalized offer_branches from offers.geo_locations.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/rebuild-offer-branches.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register src/cli/rebuild-offer-branches.ts --commit
 *
 * Requires PostGIS. Does not invent coordinates for ONLINE/NATIONWIDE/UNRESOLVED.
 */

import 'dotenv/config';
import { closePool } from '@/infrastructure/db/db-client';
import { rebuildAllOfferBranches } from '@/infrastructure/db/offer-branches';
import { pool } from '@/infrastructure/db/db-client';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`[OfferBranches] Mode: ${commit ? 'COMMIT' : 'DRY-RUN'}`);

  const countRes = await pool.query<{ c: string }>(`
    SELECT COUNT(*)::text AS c FROM offers
    WHERE geo_locations IS NOT NULL
      AND jsonb_typeof(geo_locations) = 'array'
      AND jsonb_array_length(geo_locations) > 0
  `);
  console.log(`[OfferBranches] Offers with geo_locations arrays: ${countRes.rows[0]?.c ?? 0}`);

  if (!commit) {
    console.log('[OfferBranches] DRY-RUN complete. Re-run with --commit to rebuild.');
    await closePool().catch(() => {});
    return;
  }

  const result = await rebuildAllOfferBranches();
  console.log(
    `[OfferBranches] Rebuilt ${result.branches} branch rows from ${result.offers} offers.`
  );
  await closePool().catch(() => {});
}

main().catch((err) => {
  console.error('[OfferBranches] Fatal:', err);
  process.exit(1);
});
