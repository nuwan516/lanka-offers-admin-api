import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Places results have a 60-day TTL (branches open/close).
// Geocoding results never expire — addresses don't move.
const DEFAULT_PLACES_TTL_DAYS = 60;

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface GeoCacheConfig {
  cacheDir: string;
  placesTtlDays?: number;
}

export interface CacheStats {
  geocodeCached: number;
  placesCached: number;
}

/** Same normalization/hash used for both the local file cache and the
 *  Postgres-backed cache tier, so a lookup key means the same thing in both. */
export function normalizeGeoKey(key: string): string {
  return crypto
    .createHash('md5')
    .update(key.toLowerCase().trim().replace(/\s+/g, ' '))
    .digest('hex');
}

// ─── GeoCache ─────────────────────────────────────────────────────────────────

/**
 * Persistent two-tier file cache for geocoding results.
 *
 * - `geocode/` subdirectory: never expires — physical addresses don't move.
 * - `places/`  subdirectory: 60-day TTL — chain branch lists change over time.
 */
export class GeoCache {
  private readonly geocodeDir: string;
  private readonly placesDir: string;
  private readonly placesTtlMs: number;

  constructor(config: GeoCacheConfig) {
    const { cacheDir, placesTtlDays = DEFAULT_PLACES_TTL_DAYS } = config;
    this.geocodeDir = path.join(cacheDir, 'geocode');
    this.placesDir = path.join(cacheDir, 'places');
    this.placesTtlMs = placesTtlDays * 24 * 60 * 60 * 1000;

    [this.geocodeDir, this.placesDir].forEach((d) => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private hash(key: string): string {
    return normalizeGeoKey(key);
  }

  private readFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private writeFile(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  // ── Geocoding API cache (never expires) ────────────────────────────────────

  getGeocode<T>(address: string): T | null {
    const stored = this.readFile<{ result: T }>(
      path.join(this.geocodeDir, `${this.hash(address)}.json`)
    );
    return stored?.result ?? null;
  }

  setGeocode<T>(address: string, result: T): void {
    this.writeFile(path.join(this.geocodeDir, `${this.hash(address)}.json`), {
      address,
      result,
      cachedAt: new Date().toISOString(),
    });
  }

  // ── Places Text Search cache (TTL) ─────────────────────────────────────────

  getPlaces<T>(query: string): T[] | null {
    const stored = this.readFile<{ results: T[]; cachedAt: string }>(
      path.join(this.placesDir, `${this.hash(query)}.json`)
    );
    if (!stored) return null;

    // Check TTL
    if (stored.cachedAt) {
      const age = Date.now() - new Date(stored.cachedAt).getTime();
      if (age > this.placesTtlMs) return null; // expired
    }
    return stored.results;
  }

  setPlaces<T>(query: string, results: T[]): void {
    this.writeFile(path.join(this.placesDir, `${this.hash(query)}.json`), {
      query,
      results,
      cachedAt: new Date().toISOString(),
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): CacheStats {
    const countFiles = (dir: string): number =>
      fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length
        : 0;

    return {
      geocodeCached: countFiles(this.geocodeDir),
      placesCached: countFiles(this.placesDir),
    };
  }
}
