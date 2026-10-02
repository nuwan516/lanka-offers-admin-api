import axios from 'axios';
import { GeoCache, normalizeGeoKey } from '@/infrastructure/cache/geo-cache';
import { ApiTracker } from '@/infrastructure/geo/api-tracker';
import { GeoResult, GeoSessionStats } from '@/core/types/geo';
import { costGuard } from '@/infrastructure/cost-control/cost-guard';
import { getGeoCacheEntry, setGeoCacheEntry, recordApiUsage } from '@/infrastructure/db/offer-repository';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GeocoderConfig {
  apiKey: string;
  cache: GeoCache;
  tracker?: ApiTracker;
  /** Max parallel geocode requests (default 5). */
  concurrency?: number;
  /** Milliseconds to wait between geocode requests (default 150ms). */
  requestDelay?: number;
  /** Persist/read results through the Postgres geo_cache table (default true). */
  usePgCache?: boolean;
}

// ─── Bounds ───────────────────────────────────────────────────────────────────

const SRI_LANKA_BOUNDS = {
  minLat: 5.9,
  maxLat: 10.0,
  minLng: 79.5,
  maxLng: 82.0,
};

// ─── Geocoder ─────────────────────────────────────────────────────────────────

/**
 * Wraps the Google Geocoding API ($5/1K calls).
 * - Uses GeoCache for persistent never-expire caching.
 * - Tracks usage via ApiTracker.
 * - Validates that results fall within Sri Lanka bounds.
 * - Supports batch geocoding with configurable concurrency.
 */
export class Geocoder {
  private readonly apiKey: string;
  private readonly cache: GeoCache;
  private readonly tracker?: ApiTracker;
  private readonly concurrency: number;
  private readonly requestDelay: number;
  private readonly usePgCache: boolean;
  private readonly stats: GeoSessionStats;
  /** In-process request dedup: two concurrent lookups for the same address
   *  share one provider call instead of both hitting Google. */
  private readonly inFlight = new Map<string, Promise<GeoResult>>();

  constructor(config: GeocoderConfig) {
    if (!config.apiKey) throw new Error('Geocoder: Google API key is required');
    this.apiKey = config.apiKey;
    this.cache = config.cache;
    this.tracker = config.tracker;
    this.concurrency = config.concurrency ?? 5;
    this.requestDelay = config.requestDelay ?? 150;
    this.usePgCache = config.usePgCache ?? true;
    this.stats = {
      geocodeCached: 0,
      geocodeNew: 0,
      geocodeFailed: 0,
      placesCached: 0,
      placesNew: 0,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private isInSriLanka(lat: number, lng: number): boolean {
    return (
      lat >= SRI_LANKA_BOUNDS.minLat &&
      lat <= SRI_LANKA_BOUNDS.maxLat &&
      lng >= SRI_LANKA_BOUNDS.minLng &&
      lng <= SRI_LANKA_BOUNDS.maxLng
    );
  }

  private ensureSriLanka(address: string): string {
    return address.toLowerCase().includes('sri lanka')
      ? address
      : `${address}, Sri Lanka`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Geocode a single address. Returns a GeoResult (may have success=false).
   * Retries up to 3 times on rate-limit (429).
   */
  async geocodeAddress(address: string, retryCount = 0): Promise<GeoResult> {
    const searchAddress = this.ensureSriLanka(address);
    const cacheKey = normalizeGeoKey(searchAddress);

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const promise = this.doGeocodeAddress(searchAddress, cacheKey, retryCount).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async doGeocodeAddress(searchAddress: string, cacheKey: string, retryCount = 0): Promise<GeoResult> {
    // Tier 1: local file cache (fast, sync).
    const cached = this.cache.getGeocode<GeoResult>(searchAddress);
    if (cached) {
      this.stats.geocodeCached++;
      return cached;
    }

    // Tier 2: Postgres-backed cache (survives across machines/processes).
    if (this.usePgCache) {
      try {
        const pgHit = await getGeoCacheEntry(cacheKey);
        if (pgHit) {
          const result = pgHit.resultJson as GeoResult;
          this.cache.setGeocode(searchAddress, result); // backfill local tier
          this.stats.geocodeCached++;
          return result;
        }
      } catch {
        // Postgres cache is best-effort — fall through to the provider.
      }
    }

    // Cost guard: an exhausted/disabled quota stops the optional call
    // instead of silently generating cost. Geo stays unresolved, not crashed.
    const guardDecision = await costGuard.canCall('google_geocoding');
    if (guardDecision.verdict === 'BLOCK') {
      return {
        success: false,
        searchAddress,
        error: 'QUOTA_BLOCKED',
        message: `Geocoding skipped: CostGuard blocked google_geocoding (${guardDecision.reason})`,
        timestamp: new Date().toISOString(),
        source: 'geocoding_api',
      };
    }

    try {
      const response = await axios.get<{
        status: string;
        results: Array<{
          formatted_address: string;
          geometry: { location: { lat: number; lng: number } };
          place_id: string;
          types: string[];
          address_components: Array<{
            long_name: string;
            short_name: string;
            types: string[];
          }>;
        }>;
        error_message?: string;
      }>('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address: searchAddress,
          key: this.apiKey,
          region: 'lk',
          components: 'country:LK',
        },
        timeout: 10_000,
      });

      if (this.tracker) this.tracker.record('geocoding', searchAddress);
      await recordApiUsage('google', 'google_geocoding').catch(() => null);
      costGuard.invalidate('google_geocoding');

      let result: GeoResult;

      if (response.data.status === 'OK' && response.data.results.length > 0) {
        const r = response.data.results[0];
        const { lat, lng } = r.geometry.location;

        // A country-level match means Google couldn't resolve the query and
        // returned the Sri Lanka centroid — useless as a merchant location.
        const isCountryCentroid = (r.types ?? []).includes('country');

        result = {
          success: !isCountryCentroid && this.isInSriLanka(lat, lng),
          searchAddress,
          formattedAddress: r.formatted_address,
          latitude: lat,
          longitude: lng,
          placeId: r.place_id,
          types: r.types,
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
        };

        if (!result.success) {
          result.error = isCountryCentroid ? 'COUNTRY_CENTROID' : 'OUT_OF_BOUNDS';
          result.message = isCountryCentroid
            ? 'Query resolved to country level only — not a usable location'
            : 'Coordinates outside Sri Lanka bounds';
          this.stats.geocodeFailed++;
        } else {
          this.stats.geocodeNew++;
        }
      } else {
        result = {
          success: false,
          searchAddress,
          error: response.data.status,
          message: response.data.error_message ?? 'Not found',
          timestamp: new Date().toISOString(),
          source: 'geocoding_api',
        };
        this.stats.geocodeFailed++;
      }

      this.cache.setGeocode(searchAddress, result);
      if (this.usePgCache) {
        // Geocodes are physical addresses — they don't move, so never expire.
        await setGeoCacheEntry(cacheKey, searchAddress, 'geocoding_api', result, null).catch(() => null);
      }
      await this.sleep(this.requestDelay);
      return result;
    } catch (error: unknown) {
      const axiosError = error as { response?: { status: number }; code?: string; message: string };

      // Retry throttling AND transient network failures (DNS exhaustion under
      // load surfaces as EAI_AGAIN) — these are not answers about the address.
      const transient =
        axiosError.response?.status === 429 ||
        ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(axiosError.code ?? '');
      if (transient && retryCount < 3) {
        const backoffMs = 2000 * Math.pow(2, retryCount);
        await this.sleep(backoffMs);
        return this.doGeocodeAddress(searchAddress, cacheKey, retryCount + 1);
      }

      const result: GeoResult = {
        success: false,
        searchAddress,
        error: 'API_ERROR',
        message: axiosError.message,
        timestamp: new Date().toISOString(),
        source: 'geocoding_api',
      };
      this.stats.geocodeFailed++;
      // Never cache transport errors — a later run must retry the address.
      return result;
    }
  }

  /**
   * Geocode multiple addresses with concurrency limiting.
   * Returns a Map<address, GeoResult>.
   */
  async geocodeBatch(addresses: string[]): Promise<Map<string, GeoResult>> {
    const results = new Map<string, GeoResult>();
    const semaphore = this.buildSemaphore(this.concurrency);

    await Promise.all(
      addresses.map((addr) =>
        semaphore(async () => {
          results.set(addr, await this.geocodeAddress(addr));
        }),
      ),
    );

    return results;
  }

  /** Simple concurrency semaphore (no external dep required). */
  private buildSemaphore(
    limit: number,
  ): <T>(fn: () => Promise<T>) => Promise<T> {
    let active = 0;
    const queue: Array<() => void> = [];

    const next = () => {
      if (queue.length > 0 && active < limit) {
        active++;
        const run = queue.shift()!;
        run();
      }
    };

    return <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const run = () => {
          fn()
            .then((v) => {
              active--;
              resolve(v);
              next();
            })
            .catch((e) => {
              active--;
              reject(e);
              next();
            });
        };
        if (active < limit) {
          active++;
          run();
        } else {
          queue.push(run);
        }
      });
  }

  getStats(): Readonly<GeoSessionStats> {
    return { ...this.stats };
  }
}
