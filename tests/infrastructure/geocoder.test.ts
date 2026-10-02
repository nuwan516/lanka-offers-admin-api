import axios from 'axios';
import { Geocoder } from '@/infrastructure/geo/geocoder';
import type { GeoCache } from '@/infrastructure/cache/geo-cache';
import { costGuard } from '@/infrastructure/cost-control/cost-guard';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('@/infrastructure/db/offer-repository', () => ({
  getGeoCacheEntry: jest.fn().mockResolvedValue(null),
  setGeoCacheEntry: jest.fn().mockResolvedValue(undefined),
  recordApiUsage: jest.fn().mockResolvedValue(1),
  getServiceUsage: jest.fn().mockResolvedValue(0),
}));
import { getGeoCacheEntry, setGeoCacheEntry, getServiceUsage } from '@/infrastructure/db/offer-repository';

function makeFakeCache(): jest.Mocked<GeoCache> {
  return {
    getGeocode: jest.fn().mockReturnValue(null),
    setGeocode: jest.fn(),
    getPlaces: jest.fn(),
    setPlaces: jest.fn(),
    getStats: jest.fn(),
  } as unknown as jest.Mocked<GeoCache>;
}

const OK_RESPONSE = {
  data: {
    status: 'OK',
    results: [
      {
        formatted_address: '123 Main St, Colombo, Sri Lanka',
        geometry: { location: { lat: 6.9271, lng: 79.8612 } },
        place_id: 'place-123',
        types: ['establishment'],
        address_components: [],
      },
    ],
  },
};

describe('Geocoder — zero-cost geo layer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getGeoCacheEntry as jest.Mock).mockResolvedValue(null);
    (getServiceUsage as jest.Mock).mockResolvedValue(0);
    costGuard.invalidate('google_geocoding');
  });

  it('skips the provider entirely on a local file-cache hit', async () => {
    const cache = makeFakeCache();
    cache.getGeocode.mockReturnValue({ success: true, searchAddress: 'x', timestamp: 't', source: 'geocoding_api' } as never);
    const geocoder = new Geocoder({ apiKey: 'key', cache });

    const result = await geocoder.geocodeAddress('123 Main St');

    expect(result.success).toBe(true);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(getGeoCacheEntry).not.toHaveBeenCalled();
  });

  it('falls through to the Postgres cache tier on a local miss, and backfills the local cache', async () => {
    const cache = makeFakeCache();
    (getGeoCacheEntry as jest.Mock).mockResolvedValue({
      cacheKey: 'k', queryNormalized: 'x', provider: 'geocoding_api',
      resultJson: { success: true, searchAddress: 'x', timestamp: 't', source: 'geocoding_api' },
      expiresAt: null,
    });
    const geocoder = new Geocoder({ apiKey: 'key', cache });

    const result = await geocoder.geocodeAddress('123 Main St');

    expect(result.success).toBe(true);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(cache.setGeocode).toHaveBeenCalled(); // backfilled into the local tier
  });

  it('calls the provider once and caches the result in both tiers on a full miss', async () => {
    mockedAxios.get.mockResolvedValueOnce(OK_RESPONSE as never);
    const cache = makeFakeCache();
    const geocoder = new Geocoder({ apiKey: 'key', cache, requestDelay: 0 });

    const result = await geocoder.geocodeAddress('123 Main St');

    expect(result.success).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(cache.setGeocode).toHaveBeenCalled();
    expect(setGeoCacheEntry).toHaveBeenCalled();
  });

  it('deduplicates concurrent identical requests into a single provider call', async () => {
    let resolveAxios!: (v: unknown) => void;
    mockedAxios.get.mockReturnValueOnce(new Promise((resolve) => { resolveAxios = resolve; }) as never);
    const cache = makeFakeCache();
    const geocoder = new Geocoder({ apiKey: 'key', cache, requestDelay: 0 });

    const p1 = geocoder.geocodeAddress('Same Address, Colombo');
    const p2 = geocoder.geocodeAddress('Same Address, Colombo');

    resolveAxios(OK_RESPONSE);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it('CostGuard BLOCK stops the provider call and returns an unresolved (not crashed) result', async () => {
    (getServiceUsage as jest.Mock).mockResolvedValue(1_000_000); // far over any configured limit
    const cache = makeFakeCache();
    const geocoder = new Geocoder({ apiKey: 'key', cache });

    const result = await geocoder.geocodeAddress('123 Main St');

    expect(result.success).toBe(false);
    expect(result.error).toBe('QUOTA_BLOCKED');
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
