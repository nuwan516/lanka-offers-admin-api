import axios from 'axios';
import { GeoCache } from '@/infrastructure/cache/geo-cache';
import { ApiTracker } from '@/infrastructure/geo/api-tracker';
import { GeoResult } from '@/core/types/geo';
import { costGuard } from '@/infrastructure/cost-control/cost-guard';
import { recordApiUsage } from '@/infrastructure/db/offer-repository';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PlacesClientConfig {
  apiKey: string;
  cache: GeoCache;
  tracker?: ApiTracker;
  /** Delay between paginated requests (default 2000ms — Google requires ≥2s). */
  pageDelay?: number;
}

// ─── Places API field mask ────────────────────────────────────────────────────

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'nextPageToken',
].join(',');

// ─── PlacesClient ─────────────────────────────────────────────────────────────

/**
 * Wraps the Google Places Text Search (New API) ($32/1K calls).
 * Used to find all branches of a chain merchant.
 *
 * Results are cached with a 60-day TTL (chain branches change occasionally).
 */
export class PlacesClient {
  private readonly apiKey: string;
  private readonly cache: GeoCache;
  private readonly tracker?: ApiTracker;
  private readonly pageDelay: number;
  private placesNew = 0;
  private placesCached = 0;

  constructor(config: PlacesClientConfig) {
    if (!config.apiKey) throw new Error('PlacesClient: Google API key is required');
    this.apiKey = config.apiKey;
    this.cache = config.cache;
    this.tracker = config.tracker;
    this.pageDelay = config.pageDelay ?? 2000;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Find all branches of a chain by text query.
   * Paginates automatically; each page costs one API call.
   * Results are cached for 60 days.
   *
   * @param searchQuery - e.g. "SPAR supermarket Sri Lanka"
   * @returns Array of GeoResult entries (source = 'places_text_search')
   */
  async findChainBranches(searchQuery: string, retryCount = 0): Promise<GeoResult[]> {
    // Cache hit
    const cached = this.cache.getPlaces<GeoResult>(searchQuery);
    if (cached) {
      this.placesCached++;
      return cached;
    }

    const guardDecision = await costGuard.canCall('google_places');
    if (guardDecision.verdict === 'BLOCK') {
      console.warn(`[PlacesClient] Skipping "${searchQuery}": CostGuard blocked google_places (${guardDecision.reason})`);
      return [];
    }

    const allResults: GeoResult[] = [];
    let pageToken: string | null = null;

    try {
      do {
        const body: Record<string, unknown> = {
          textQuery: searchQuery,
          regionCode: 'LK',
          pageSize: 20,
        };
        if (pageToken) {
          body.pageToken = pageToken;
          await this.sleep(this.pageDelay);
        }

        if (this.tracker) {
          this.tracker.record('places', pageToken ? `${searchQuery} [page]` : searchQuery);
        }
        this.placesNew++;
        await recordApiUsage('google', 'google_places').catch(() => null);
        costGuard.invalidate('google_places');

        const response = await axios.post<{
          places?: Array<{
            id: string;
            displayName?: { text: string };
            formattedAddress?: string;
            location?: { latitude: number; longitude: number };
            types?: string[];
            rating?: number;
            userRatingCount?: number;
            businessStatus?: string;
          }>;
          nextPageToken?: string;
        }>(
          'https://places.googleapis.com/v1/places:searchText',
          body,
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': this.apiKey,
              'X-Goog-FieldMask': FIELD_MASK,
            },
            timeout: 15_000,
          },
        );

        if (response.data.places && response.data.places.length > 0) {
          for (const r of response.data.places) {
            allResults.push({
              success: true,
              searchAddress: searchQuery,
              formattedAddress: r.formattedAddress ?? '',
              latitude: r.location?.latitude ?? 0,
              longitude: r.location?.longitude ?? 0,
              placeId: r.id,
              types: r.types ?? [],
              timestamp: new Date().toISOString(),
              source: 'places_text_search',
              branchName: r.displayName?.text ?? '',
              rating: r.rating ?? null,
              userRatingsTotal: r.userRatingCount ?? 0,
              businessStatus: r.businessStatus ?? 'UNKNOWN',
            });
          }
          pageToken = response.data.nextPageToken ?? null;
        } else {
          pageToken = null;
        }
      } while (pageToken);

      this.cache.setPlaces(searchQuery, allResults);
      return allResults;
    } catch (error: unknown) {
      const axiosError = error as {
        response?: { status: number; data?: { error?: { message?: string } } };
        message: string;
      };

      // Retry throttling AND transient network failures (DNS exhaustion under
      // load surfaces as EAI_AGAIN).
      const code = (axiosError as { code?: string }).code ?? '';
      const transient =
        axiosError.response?.status === 429 ||
        ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(code);
      if (transient && retryCount < 3) {
        const backoff = 3000 * Math.pow(2, retryCount);
        await this.sleep(backoff);
        return this.findChainBranches(searchQuery, retryCount + 1);
      }

      const msg =
        axiosError.response?.data?.error?.message ?? axiosError.message;
      console.error(`[PlacesClient] Error for "${searchQuery}": ${msg}`);
      // Never cache failures — with the 60-day TTL a cached error would pin
      // this chain to "no branches" for two months of runs.
      return [];
    }
  }

  getStats(): { placesNew: number; placesCached: number } {
    return { placesNew: this.placesNew, placesCached: this.placesCached };
  }
}
