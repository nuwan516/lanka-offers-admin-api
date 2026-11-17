import * as fs from 'fs';
import * as path from 'path';
import { Offer } from '@/core/types/offers';
import {
  LocationType,
  GeoResult,
  GeocodedOfferRow,
  GeoOutput,
  GeoOutputMetadata,
  GeoSessionStats,
} from '@/core/types/geo';
import { IGeoAdapter } from '@/geo/adapters/geo-adapter.interface';
import { classify } from '@/parsing/geo/branch-classifier';
import { Geocoder } from '@/infrastructure/geo/geocoder';
import { PlacesClient } from '@/infrastructure/geo/places-client';
import { Logger } from '@/infrastructure/logger/logger';
import { LocationScope } from '@/domain/location-scope';
import { assessAddressQuality } from '@/geo/address-quality';
import { GeocodingVerifier } from '@/geo/geocoding-verifier';
import { confirmPlacesMatches } from '@/geo/places-confirmation';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GeoEngineConfig {
  adapter: IGeoAdapter;
  geocoder: Geocoder;
  placesClient: PlacesClient;
  logger: Logger;
  skipChains?: boolean;
  dryRun?: boolean;
}

// ─── GeoEngine ────────────────────────────────────────────────────────────────

/**
 * Orchestrates the geocoding pipeline for a bank's scraped offers:
 *
 * 1. Extract location data via the bank's IGeoAdapter
 * 2. Classify each offer (SINGLE / LISTED / CHAIN / ONLINE / NONE)
 * 3. Geocode or Places-search based on classification
 * 4. Deduplicate results by offerId
 * 5. Return structured GeoOutput for JSON serialization
 */
export class GeoEngine {
  private readonly adapter: IGeoAdapter;
  private readonly geocoder: Geocoder;
  private readonly placesClient: PlacesClient;
  private readonly logger: Logger;
  private readonly skipChains: boolean;
  private readonly dryRun: boolean;

  constructor(config: GeoEngineConfig) {
    this.adapter = config.adapter;
    this.geocoder = config.geocoder;
    this.placesClient = config.placesClient;
    this.logger = config.logger;
    this.skipChains = config.skipChains ?? false;
    this.dryRun = config.dryRun ?? false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async run(offers: Offer[]): Promise<GeoOutput> {
    this.logger.info('GeoEngine', `Processing ${offers.length} offers for bank: ${this.adapter.bank}`);

    const typeCounts: Record<LocationType, number> = {
      [LocationType.SINGLE]: 0,
      [LocationType.LISTED]: 0,
      [LocationType.CHAIN]: 0,
      [LocationType.ONLINE]: 0,
      [LocationType.NONE]: 0,
    };

    const rawResults: GeocodedOfferRow[] = [];

    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const progress = `[${i + 1}/${offers.length}]`;
      const locData = this.adapter.extractLocationData(offer);
      const classification = classify(locData);
      typeCounts[classification.type]++;

      const safeName = (locData.merchantName ?? '').substring(0, 30);

      if (this.dryRun) {
        const preview =
          classification.addresses.length > 0
            ? classification.addresses[0].substring(0, 60)
            : classification.chainQuery ?? '(none)';
        this.logger.info(
          'DryRun',
          `${progress} ${classification.type.padEnd(7)} ${safeName.padEnd(32)} ${preview}`,
        );
        rawResults.push({
          offerId: locData.offerId,
          merchantName: locData.merchantName,
          locationType: classification.type,
          locations: [],
        });
        continue;
      }

      const locations = await this.geocodeClassification(classification, safeName, progress);
      rawResults.push({
        offerId: locData.offerId,
        merchantName: locData.merchantName,
        locationType: classification.type,
        locations,
      });
    }

    const { dedupedResults, duplicatesRemoved } = this.deduplicateResults(rawResults);
    const geoStats = this.geocoder.getStats();
    const placesStats = this.placesClient.getStats();

    const sessionStats: GeoSessionStats = {
      geocodeCached: geoStats.geocodeCached,
      geocodeNew: geoStats.geocodeNew,
      geocodeFailed: geoStats.geocodeFailed,
      placesCached: placesStats.placesCached,
      placesNew: placesStats.placesNew,
    };

    const metadata: GeoOutputMetadata = {
      source: this.adapter.bank,
      geocodedAt: new Date().toISOString(),
      totalOffers: offers.length,
      locationTypes: typeCounts,
      geocodedCount: dedupedResults.filter((r) => r.locations.length > 0).length,
      totalLocations: dedupedResults.reduce((sum, r) => sum + r.locations.length, 0),
      duplicateRowsRemoved: duplicatesRemoved,
      apiStats: sessionStats,
      dryRun: this.dryRun,
    };

    this.logger.success(
      'GeoEngine',
      `Done — ${metadata.geocodedCount} geocoded, ${metadata.totalLocations} locations`,
    );

    return { metadata, offers: dedupedResults };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async geocodeClassification(
    classification: ReturnType<typeof classify>,
    safeName: string,
    progress: string,
  ): Promise<GeoResult[]> {
    const locations: GeoResult[] = [];

    switch (classification.type) {
      case LocationType.SINGLE: {
        const addr = classification.addresses[0];
        this.logger.info('Geo', `${progress} SINGLE  ${safeName.padEnd(32)} → ${addr.substring(0, 50)}`);
        const result = await this.geocoder.geocodeAddress(addr);
        const stamped = stampGeocodeConfirmation(result, addr, LocationScope.EXPLICIT_BRANCH);
        if (stamped.confirmed) locations.push(stamped);
        break;
      }

      case LocationType.LISTED: {
        this.logger.info('Geo', `${progress} LISTED  ${safeName.padEnd(32)} → ${classification.addresses.length} branches`);
        const batch = await this.geocoder.geocodeBatch(classification.addresses);
        for (const addr of classification.addresses) {
          const result = batch.get(addr);
          if (!result) continue;
          const stamped = stampGeocodeConfirmation(
            { ...result, branchName: addr },
            addr,
            LocationScope.MULTIPLE_BRANCHES,
          );
          if (stamped.confirmed) locations.push(stamped);
        }
        break;
      }

      case LocationType.CHAIN: {
        if (classification.emitConfirmedCoordinates === false) {
          this.logger.info('Geo', `${progress} CHAIN   ${safeName.padEnd(32)} → unconfirmed (no branch pins)`);
        } else if (this.skipChains) {
          this.logger.info('Geo', `${progress} CHAIN   ${safeName.padEnd(32)} → SKIPPED`);
        } else {
          const query = classification.chainQuery!;
          this.logger.info('Geo', `${progress} CHAIN   ${safeName.padEnd(32)} → "${query}"`);
          const branches = await this.placesClient.findChainBranches(query);
          // Venue-name queries keep only the top relevance-ranked hits —
          // 20 pins for one hotel is noise, not coverage.
          const limited = classification.chainResultLimit
            ? branches.slice(0, classification.chainResultLimit)
            : branches;
          const decisions = confirmPlacesMatches(
            query,
            limited.map((b) => ({
              placeId: b.placeId,
              name: b.branchName,
              formattedAddress: b.formattedAddress,
              latitude: b.latitude,
              longitude: b.longitude,
              types: b.types,
              businessStatus: b.businessStatus,
            })),
          );
          const confirmedIds = new Set(decisions.filter((d) => d.confirmed).map((d) => d.placeId));
          for (const branch of limited) {
            if (branch.placeId && confirmedIds.has(branch.placeId)) {
              locations.push({ ...branch, confirmed: true });
            }
          }
          this.logger.debug('Geo', `Found ${branches.length} branches, confirmed ${locations.length}`);
        }
        break;
      }

      case LocationType.ONLINE:
        this.logger.info('Geo', `${progress} ONLINE  ${safeName}`);
        break;

      case LocationType.NONE:
        this.logger.info('Geo', `${progress} NONE    ${safeName}`);
        break;
    }

    return locations;
  }

  private deduplicateResults(
    results: GeocodedOfferRow[],
  ): { dedupedResults: GeocodedOfferRow[]; duplicatesRemoved: number } {
    const dedupedMap = new Map<string, GeocodedOfferRow>();
    let duplicatesRemoved = 0;

    for (const row of results) {
      const key = row.offerId;
      if (!key) continue;

      const existing = dedupedMap.get(key);
      if (!existing) {
        dedupedMap.set(key, row);
        continue;
      }

      duplicatesRemoved++;
      if (row.locations.length > 0) {
        existing.locations.push(...row.locations);
        // Deduplicate locations by placeId / lat+lng
        const seen = new Set<string>();
        existing.locations = existing.locations.filter((loc) => {
          const locKey = [
            loc.placeId ?? '',
            loc.latitude ?? '',
            loc.longitude ?? '',
            loc.formattedAddress ?? '',
          ].join('|');
          if (seen.has(locKey)) return false;
          seen.add(locKey);
          return true;
        });
      }
    }

    return {
      dedupedResults: [...dedupedMap.values()],
      duplicatesRemoved,
    };
  }
}

/**
 * A geocode hit becomes a confirmed branch coordinate only when the verifier
 * accepts an exact pin. Area centroids, country centroids, and rejected
 * matches stay unconfirmed and are not returned as pins.
 */
export function stampGeocodeConfirmation(
  result: GeoResult,
  query: string,
  scope: LocationScope,
): GeoResult {
  const quality = assessAddressQuality({ candidateAddresses: [query] }).quality;
  const verification = GeocodingVerifier.verifyResult(result, query, quality, scope);
  return { ...result, confirmed: verification.isVerifiedExactPin };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Save a GeoOutput to a JSON file, creating directories as needed.
 */
export function saveGeoOutput(output: GeoOutput, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
}
