#!/usr/bin/env ts-node
/**
 * Geocode CLI
 *
 * Reads a scraped JSON output file and geocodes all merchant locations.
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx npx ts-node -r tsconfig-paths/register src/cli/geocode.ts --bank=hnb
 *
 * Options:
 *   --bank=<name>       Bank name to geocode: hnb | sampath | boc | peoples | ndb | seylan | nsb | combank | all
 *   --input=<dir>       Directory containing <bank>_all.json (default: ./output)
 *   --output=<dir>      Directory to write geo output (default: ./output/geo)
 *   --cache-dir=<dir>   Geo cache directory (default: ./.geo-cache)
 *   --dry-run           Classify only, no API calls
 *   --stats             Show API usage report after geocoding
 *   --skip-chains       Skip Places API for known chains
 *   --concurrency=<n>   Geocoding concurrency (default: 5)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@/infrastructure/logger/logger';
import { GeoCache } from '@/infrastructure/cache/geo-cache';
import { ApiTracker } from '@/infrastructure/geo/api-tracker';
import { Geocoder } from '@/infrastructure/geo/geocoder';
import { PlacesClient } from '@/infrastructure/geo/places-client';
import { GeoEngine, saveGeoOutput } from '@/geo/geo-engine';
import { getGeoAdapter, listSupportedBanks } from '@/geo/adapter-registry';
import { Offer, GeoLocation } from '@/core/types/offers';
import { GeoSessionStats, LocationType, GeocodedOfferRow, GeoResult } from '@/core/types/geo';
import { updateOfferGeoLocations, GeoStatus } from '@/infrastructure/db/offer-repository';
import { closePool } from '@/infrastructure/db/db-client';
import * as crypto from 'crypto';

// ─── CLI args ─────────────────────────────────────────────────────────────────

interface CliOptions {
  bank: string;
  input: string;
  output: string;
  cacheDir: string;
  dryRun: boolean;
  stats: boolean;
  skipChains: boolean;
  concurrency: number;
  apiKey: string;
}

interface GeocodeBankSummary {
  bank: string;
  totalOffers: number;
  geocodedCount: number;
  totalLocations: number;
  locationTypes: Record<LocationType, number>;
  apiStats: GeoSessionStats;
  outputPath: string | null;
  dryRun: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    bank: 'hnb',
    input: './output',
    output: './output/geo',
    cacheDir: './.geo-cache',
    dryRun: false,
    stats: false,
    skipChains: false,
    concurrency: 5,
    apiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  };

  for (const arg of args) {
    if (arg.startsWith('--bank=')) opts.bank = arg.split('=')[1];
    else if (arg.startsWith('--input=')) opts.input = arg.split('=')[1];
    else if (arg.startsWith('--output=')) opts.output = arg.split('=')[1];
    else if (arg.startsWith('--cache-dir=')) opts.cacheDir = arg.split('=')[1];
    else if (arg.startsWith('--google-api-key=')) opts.apiKey = arg.split('=')[1];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--stats') opts.stats = true;
    else if (arg === '--skip-chains') opts.skipChains = true;
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.split('=')[1], 10);
  }

  return opts;
}

// ─── Load offers JSON ─────────────────────────────────────────────────────────

function loadOffers(bankName: string, inputDir: string): Offer[] {
  const filePath = path.join(inputDir, `${bankName}_all.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}\nRun: npx ts-node src/cli/scrape.ts --bank=${bankName} first.`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { offers: Offer[] };
  return parsed.offers;
}

// ─── Persist geo results back onto the offer row ─────────────────────────────

function toGeoLocation(r: GeoResult): GeoLocation {
  return {
    originalAddress: r.searchAddress,
    formattedAddress: r.formattedAddress,
    latitude: r.latitude ?? 0,
    longitude: r.longitude ?? 0,
    placeId: r.placeId,
    types: r.types,
    source: r.source,
    branchName: r.branchName,
  };
}

function deriveGeoStatus(row: GeocodedOfferRow): GeoStatus {
  if (row.locationType === LocationType.ONLINE || row.locationType === LocationType.NONE) return 'resolved';
  if (row.locations.some((l) => l.error === 'QUOTA_BLOCKED')) return 'quota_blocked';
  return row.locations.length > 0 ? 'resolved' : 'unresolved';
}

/**
 * Zero-cost control (step 11): write resolved geo results into Postgres so
 * they're reusable offer state, not just local `output/*_geo.json` files.
 * `geoCacheKey` is a fingerprint of what was actually geocoded this run —
 * a later run only needs to re-geocode when this input changes.
 */
async function persistGeoResults(rows: GeocodedOfferRow[], logger: Logger): Promise<void> {
  let written = 0;
  for (const row of rows) {
    if (!row.offerId) continue;
    const locations = row.locations.filter((l) => l.success !== false).map(toGeoLocation);
    const status = deriveGeoStatus(row);
    const geoCacheKey = crypto
      .createHash('md5')
      .update(JSON.stringify({ type: row.locationType, addresses: row.locations.map((l) => l.searchAddress).sort() }))
      .digest('hex');
    try {
      await updateOfferGeoLocations(row.offerId, locations, status, geoCacheKey);
      written++;
    } catch (e) {
      logger.warn('DB', `Failed to persist geo result for ${row.offerId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  logger.success('DB', `Persisted geo results for ${written}/${rows.length} offers to Postgres`);
}

// ─── Geocode a single bank ────────────────────────────────────────────────────

async function geocodeBank(bankName: string, opts: CliOptions): Promise<GeocodeBankSummary> {
  const logger = new Logger(`geo:${bankName}`);

  if (!opts.dryRun && !opts.apiKey) {
    logger.error('Setup', 'GOOGLE_MAPS_API_KEY is required. Set env var or pass --google-api-key=<key>');
    process.exit(1);
  }

  const offers = loadOffers(bankName, opts.input);
  logger.info('Load', `Loaded ${offers.length} offers for ${bankName}`);

  const adapter = getGeoAdapter(bankName);
  const cache = new GeoCache({ cacheDir: opts.cacheDir });
  const tracker = new ApiTracker(opts.cacheDir);

  // Check limits before starting
  const geocodeWarning = tracker.checkLimit('geocoding');
  const placesWarning = tracker.checkLimit('places');
  if (geocodeWarning) logger.warn('ApiLimit', geocodeWarning);
  if (placesWarning) logger.warn('ApiLimit', placesWarning);

  const geocoder = new Geocoder({
    apiKey: opts.apiKey,
    cache,
    tracker,
    concurrency: opts.concurrency,
  });

  const placesClient = new PlacesClient({
    apiKey: opts.apiKey,
    cache,
    tracker,
  });

  const engine = new GeoEngine({
    adapter,
    geocoder,
    placesClient,
    logger,
    skipChains: opts.skipChains,
    dryRun: opts.dryRun,
  });

  const output = await engine.run(offers);
  let outPath: string | null = null;

  if (!opts.dryRun) {
    outPath = path.join(opts.output, `${bankName}_geo.json`);
    saveGeoOutput(output, outPath);
    logger.success('Output', `Geo data saved → ${outPath}`);
    logger.success('Stats',
      `Geocoded: ${output.metadata.geocodedCount}/${output.metadata.totalOffers} offers | ` +
      `Locations: ${output.metadata.totalLocations}`
    );
    await persistGeoResults(output.offers, logger).catch((e) =>
      logger.warn('DB', `Geo persistence step failed: ${e instanceof Error ? e.message : e}`)
    );
  }

  if (opts.stats) {
    console.log('\n' + tracker.getReport());
    const cacheStats = cache.getStats();
    console.log(`\n  Cache: ${cacheStats.geocodeCached} geocodes, ${cacheStats.placesCached} places results`);
  }

  return {
    bank: bankName,
    totalOffers: output.metadata.totalOffers,
    geocodedCount: output.metadata.geocodedCount,
    totalLocations: output.metadata.totalLocations,
    locationTypes: output.metadata.locationTypes,
    apiStats: output.metadata.apiStats,
    outputPath: outPath,
    dryRun: opts.dryRun,
  };
}

function mergeStats(left: GeoSessionStats, right: GeoSessionStats): GeoSessionStats {
  return {
    geocodeCached: left.geocodeCached + right.geocodeCached,
    geocodeNew: left.geocodeNew + right.geocodeNew,
    geocodeFailed: left.geocodeFailed + right.geocodeFailed,
    placesCached: left.placesCached + right.placesCached,
    placesNew: left.placesNew + right.placesNew,
  };
}

function printFinalSummary(summaries: GeocodeBankSummary[], opts: CliOptions): void {
  if (summaries.length === 0) return;

  const totalStats = summaries.reduce<GeoSessionStats>(
    (acc, summary) => mergeStats(acc, summary.apiStats),
    { geocodeCached: 0, geocodeNew: 0, geocodeFailed: 0, placesCached: 0, placesNew: 0 },
  );
  const totalOffers = summaries.reduce((sum, summary) => sum + summary.totalOffers, 0);
  const totalLocations = summaries.reduce((sum, summary) => sum + summary.totalLocations, 0);
  const totalGeocoded = summaries.reduce((sum, summary) => sum + summary.geocodedCount, 0);
  const tracker = new ApiTracker(opts.cacheDir);
  const cost = tracker.getSessionCost(totalStats.geocodeNew, totalStats.placesNew);

  console.log('\n  FINAL GEO SUMMARY');
  console.log('  ' + '─'.repeat(50));
  for (const summary of summaries) {
    console.log(
      `  ${summary.bank.toUpperCase().padEnd(8)} ` +
      `${String(summary.geocodedCount).padStart(4)}/${String(summary.totalOffers).padEnd(4)} offers | ` +
      `${String(summary.totalLocations).padStart(4)} locations | ` +
      `S:${summary.locationTypes.SINGLE} L:${summary.locationTypes.LISTED} ` +
      `C:${summary.locationTypes.CHAIN} O:${summary.locationTypes.ONLINE} N:${summary.locationTypes.NONE}`,
    );
    if (summary.outputPath) console.log(`           Output: ${summary.outputPath}`);
  }

  console.log('\n  Session API Usage');
  console.log(`    Geocoding  cached: ${totalStats.geocodeCached}, new: ${totalStats.geocodeNew}, failed: ${totalStats.geocodeFailed}`);
  console.log(`    Places     cached: ${totalStats.placesCached}, new: ${totalStats.placesNew}`);
  console.log(`    Estimated session cost before free-tier accounting: $${cost.total.toFixed(4)}`);
  console.log(`    Total      ${totalGeocoded}/${totalOffers} offers geocoded, ${totalLocations} locations`);
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║   Lanka Offers Geocoder — TypeScript Framework     ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  const opts = parseArgs();

  const banks =
    opts.bank === 'all' ? listSupportedBanks() : [opts.bank];

  console.log(`\n  Banks:      ${banks.join(', ')}`);
  console.log(`  Dry run:    ${opts.dryRun}`);
  console.log(`  Skip chains:${opts.skipChains}`);
  console.log(`  Cache dir:  ${opts.cacheDir}`);
  console.log(`  Input:      ${opts.input}`);
  console.log(`  Output:     ${opts.output}`);
  if (opts.dryRun) console.log(`\n  ℹ️  DRY RUN — no API calls will be made`);

  const start = Date.now();
  const summaries: GeocodeBankSummary[] = [];

  for (const bank of banks) {
    try {
      summaries.push(await geocodeBank(bank, opts));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n  ❌ Error geocoding ${bank}: ${msg}`);
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\n${'═'.repeat(60)}`);
  printFinalSummary(summaries, opts);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✓ Done in ${duration}s`);
  await closePool().catch(() => null);
}

main().catch((err) => {
  console.error('\n  ❌ Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
