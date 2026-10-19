#!/usr/bin/env ts-node
/**
 * Geo backfill from the database (not from scrape output files).
 *
 * Walks PUBLISHED offers, cleans each offer's stored addresses with the current address
 * engine rules (raw_offer is never modified), recomputes the truthful location scope, and
 * geocodes only offers that (a) have a real physical address and (b) have no coordinates yet.
 *
 * Guarantees:
 *  - ONLINE / NATIONWIDE / SELECTED_OUTLETS / DISTRICT_REGION / UNRESOLVED offers are never pinned.
 *  - Chain / Places lookups are not used (those are venue-name guesses).
 *  - Offers with a manual_override for location_scope or geo_locations are left alone.
 *  - Provider calls are bounded by --max-calls and the existing cost guard; every address goes
 *    through the file + Postgres geo cache first, so repeats cost nothing.
 *
 * Usage (dry run is the default):
 *   npx ts-node -r tsconfig-paths/register src/cli/geo-backfill.ts
 *   ... --apply-scope --backup=<file.json>   write corrected location_scope (old values backed up)
 *   ... --geocode --max-calls=200            geocode and persist coordinates
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pool, closePool } from '@/infrastructure/db/db-client';
import { Offer, GeoLocation } from '@/core/types/offers';
import { GeoResult, LocationType } from '@/core/types/geo';
import { getGeoAdapter, listSupportedBanks } from '@/geo/adapter-registry';
import { classify } from '@/parsing/geo/branch-classifier';
import { AddressEngine } from '@/parsing/address/address-engine';
import { determineLocationScope, isMerchantOnlyAddress, LocationScope } from '@/domain/location-scope';
import { GeoCache, normalizeGeoKey } from '@/infrastructure/cache/geo-cache';
import { Geocoder } from '@/infrastructure/geo/geocoder';
import { Logger } from '@/infrastructure/logger/logger';
import { getGeoCacheEntry, updateOfferGeoLocations } from '@/infrastructure/db/offer-repository';
import { getAddressRejectPatterns, preloadBankRules } from '@/banks/bank-rules-loader';

const PHYSICAL_SCOPES = new Set<string>([LocationScope.EXPLICIT_BRANCH, LocationScope.MULTIPLE_BRANCHES]);

interface Row {
  id: string;
  unique_id: string;
  bank: string;
  title: string;
  merchant_name: string | null;
  merchant_location: string | null;
  location_scope: string | null;
  geo_status: string | null;
  geo_locations: unknown;
  manual_override: Record<string, unknown> | null;
  raw_offer: Offer;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : (hit.split('=')[1] ?? 'true');
}

function hasGeo(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/** The offer as the geo adapters should see it: junk and merchant-name-only addresses removed. */
function withCleanAddresses(row: Row, engine: AddressEngine): Offer {
  const raw = row.raw_offer;
  const merchant = raw.merchant ?? ({} as Offer['merchant']);
  const cleaned = (merchant.addresses ?? [])
    .map((a) => engine.normalize(a, merchant.name ?? ''))
    .filter((a): a is string => !!a && !isMerchantOnlyAddress(a, merchant.name));
  return {
    ...raw,
    uniqueId: row.unique_id,
    merchant: { ...merchant, phone: merchant.phone ?? [], addresses: [...new Set(cleaned)] },
    offer: raw.offer ?? ({} as Offer['offer']),
  } as Offer;
}

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

async function main(): Promise<void> {
  const logger = new Logger('geo-backfill');
  const applyScope = arg('apply-scope') !== undefined;
  const geocode = arg('geocode') !== undefined;
  const maxCalls = Number(arg('max-calls') ?? 0);
  const backup = arg('backup');
  if (applyScope && !backup) throw new Error('--apply-scope requires --backup=<file.json>');
  if (geocode && !(maxCalls > 0)) throw new Error('--geocode requires --max-calls=<n> (hard cap on provider calls)');

  const banks = listSupportedBanks();
  for (const b of banks) await preloadBankRules(b).catch(() => null);

  const res = await pool.query<Row>(
    `SELECT id, unique_id, bank, title, merchant_name, merchant_location, location_scope, geo_status,
            geo_locations, manual_override, raw_offer
     FROM offers WHERE db_status = 'PUBLISHED' ORDER BY bank, unique_id`,
  );
  logger.info('Load', `${res.rows.length} published offers`);

  const scopeChanges: { id: string; from: string | null; to: string }[] = [];
  const targets: { row: Row; offer: Offer; scope: string }[] = [];
  const skipped = { manual: 0, unsupportedBank: 0, alreadyGeo: 0, nonPhysical: 0, noAddress: 0 };

  for (const row of res.rows) {
    const mo = row.manual_override ?? {};
    if (mo.location_scope || mo.geo_locations) { skipped.manual++; continue; }
    if (!banks.includes(row.bank)) { skipped.unsupportedBank++; continue; }

    const engine = new AddressEngine({
      country: 'Sri Lanka',
      fallbackToMerchant: false,
      rejectPatterns: () => getAddressRejectPatterns(row.bank),
    });
    const offer = withCleanAddresses(row, engine);
    const scopeRes = determineLocationScope({
      location: row.merchant_location,
      addresses: offer.merchant.addresses,
      geoLocations: hasGeo(row.geo_locations) ? (row.geo_locations as unknown[]) : [],
      title: row.title,
      description: offer.offer?.description ?? '',
      merchantName: row.merchant_name ?? '',
    });
    if (scopeRes.scope !== row.location_scope) scopeChanges.push({ id: row.id, from: row.location_scope, to: scopeRes.scope });

    if (hasGeo(row.geo_locations)) { skipped.alreadyGeo++; continue; }
    if (!PHYSICAL_SCOPES.has(scopeRes.scope)) { skipped.nonPhysical++; continue; }
    if (offer.merchant.addresses.length === 0) { skipped.noAddress++; continue; }
    targets.push({ row, offer, scope: scopeRes.scope });
  }

  // Classify targets and count what would actually reach the provider.
  const queries = new Map<string, number>();
  let uncached = 0;
  const typeCounts: Record<string, number> = {};
  const geocodable: typeof targets = [];
  for (const t of targets) {
    const loc = getGeoAdapter(t.row.bank).extractLocationData(t.offer);
    const cls = classify(loc);
    typeCounts[cls.type] = (typeCounts[cls.type] ?? 0) + 1;
    if (cls.type !== LocationType.SINGLE && cls.type !== LocationType.LISTED) continue;
    geocodable.push(t);
    for (const a of cls.addresses) {
      const full = /sri lanka/i.test(a) ? a : `${a}, Sri Lanka`;
      const key = normalizeGeoKey(full);
      if (queries.has(key)) continue;
      const hit = await getGeoCacheEntry(key).catch(() => null);
      queries.set(key, hit ? 1 : 0);
      if (!hit) uncached++;
    }
  }

  const transitions: Record<string, number> = {};
  for (const c of scopeChanges) {
    const k = `${c.from} -> ${c.to}`;
    transitions[k] = (transitions[k] ?? 0) + 1;
  }
  console.log(JSON.stringify({
    published: res.rows.length,
    skipped,
    scopeChanges: scopeChanges.length,
    transitions,
    geocodeCandidates: targets.length,
    classification: typeCounts,
    uniqueAddresses: queries.size,
    uncachedProviderCalls: uncached,
  }, null, 2));

  if (applyScope) {
    fs.writeFileSync(backup!, JSON.stringify(scopeChanges, null, 1));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of scopeChanges) {
        await client.query(
          `UPDATE offers SET location_scope = $1 WHERE id = $2 AND location_scope IS NOT DISTINCT FROM $3`,
          [c.to, c.id, c.from],
        );
      }
      await client.query('COMMIT');
      logger.success('Scope', `updated ${scopeChanges.length} offers (backup: ${backup})`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  if (geocode) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';
    if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is not set');
    const geocoder = new Geocoder({ apiKey, cache: new GeoCache({ cacheDir: './.geo-cache' }), concurrency: 3 });
    let written = 0;
    for (const t of geocodable) {
      if (geocoder.getStats().geocodeNew + geocoder.getStats().geocodeFailed >= maxCalls) {
        logger.warn('Cap', `--max-calls=${maxCalls} reached; remaining offers left for a later run`);
        break;
      }
      const cls = classify(getGeoAdapter(t.row.bank).extractLocationData(t.offer));
      const found: GeoResult[] = [];
      for (const addr of cls.addresses) {
        const r = await geocoder.geocodeAddress(addr);
        if (r.success !== false) found.push({ ...r, branchName: cls.type === LocationType.LISTED ? addr : undefined });
      }
      if (found.length === 0) continue; // leave as-is; the negative answer is cached for next time
      const key = crypto.createHash('md5').update(JSON.stringify(cls.addresses.slice().sort())).digest('hex');
      await updateOfferGeoLocations(t.row.unique_id, found.map(toGeoLocation), 'resolved', key);
      written++;
    }
    logger.success('Geo', `persisted coordinates for ${written} offers; provider stats ${JSON.stringify(geocoder.getStats())}`);
  }

  await closePool().catch(() => null);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
