import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GeoCache } from '@/infrastructure/cache/geo-cache';
import { GeoResult } from '@/core/types/geo';

let tmpDir: string;
let cache: GeoCache;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-cache-test-'));
  cache = new GeoCache({ cacheDir: tmpDir, placesTtlDays: 1 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GeoCache — geocode (never expires)', () => {
  const dummyResult: GeoResult = {
    success: true,
    searchAddress: 'Colombo, Sri Lanka',
    formattedAddress: 'Colombo, Western Province, Sri Lanka',
    latitude: 6.927079,
    longitude: 79.861244,
    placeId: 'ChIJA2suEwUSqjsR1b4GatbeOrU',
    types: ['locality'],
    timestamp: new Date().toISOString(),
    source: 'geocoding_api',
  };

  it('returns null on miss', () => {
    expect(cache.getGeocode('does-not-exist')).toBeNull();
  });

  it('returns the result after set', () => {
    cache.setGeocode('Colombo, Sri Lanka', dummyResult);
    const hit = cache.getGeocode<GeoResult>('Colombo, Sri Lanka');
    expect(hit?.success).toBe(true);
    expect(hit?.placeId).toBe(dummyResult.placeId);
  });

  it('normalizes the key (trims + lowercases)', () => {
    cache.setGeocode('  COLOMBO, sri lanka  ', dummyResult);
    const hit = cache.getGeocode<GeoResult>('colombo, sri lanka');
    expect(hit).not.toBeNull();
  });

  it('reads back failed results too', () => {
    const failed: GeoResult = {
      success: false,
      searchAddress: 'XYZ',
      error: 'ZERO_RESULTS',
      timestamp: new Date().toISOString(),
      source: 'geocoding_api',
    };
    cache.setGeocode('XYZ', failed);
    expect(cache.getGeocode<GeoResult>('XYZ')?.success).toBe(false);
  });
});

describe('GeoCache — places (TTL)', () => {
  const results: GeoResult[] = [
    {
      success: true,
      searchAddress: 'SPAR supermarket Sri Lanka',
      formattedAddress: 'SPAR, Kolonnawa, Sri Lanka',
      latitude: 6.9,
      longitude: 79.9,
      placeId: 'abc123',
      types: ['supermarket'],
      timestamp: new Date().toISOString(),
      source: 'places_text_search',
    },
  ];

  it('returns null on miss', () => {
    expect(cache.getPlaces('unknown query')).toBeNull();
  });

  it('returns results after set', () => {
    cache.setPlaces('SPAR supermarket Sri Lanka', results);
    const hit = cache.getPlaces<GeoResult>('SPAR supermarket Sri Lanka');
    expect(hit).toHaveLength(1);
    expect(hit?.[0].placeId).toBe('abc123');
  });

  it('returns null when TTL has expired', () => {
    // Write cache file with a very old timestamp
    const cacheFile = path.join(tmpDir, 'places');
    const key = require('crypto').createHash('md5').update('old query').digest('hex');
    const oldEntry = {
      query: 'old query',
      results,
      cachedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    };
    fs.mkdirSync(cacheFile, { recursive: true });
    fs.writeFileSync(path.join(cacheFile, `${key}.json`), JSON.stringify(oldEntry));

    const expiredCache = new GeoCache({ cacheDir: tmpDir, placesTtlDays: 1 });
    expect(expiredCache.getPlaces('old query')).toBeNull();
  });
});

describe('GeoCache — getStats()', () => {
  it('counts cached files correctly', () => {
    cache.setGeocode('addr1', {} as GeoResult);
    cache.setGeocode('addr2', {} as GeoResult);
    cache.setPlaces('query1', []);

    const stats = cache.getStats();
    expect(stats.geocodeCached).toBe(2);
    expect(stats.placesCached).toBe(1);
  });
});
