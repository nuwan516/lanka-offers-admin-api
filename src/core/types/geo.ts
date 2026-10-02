// ─── Location Types ──────────────────────────────────────────────────────────

/** How an offer's merchant is located spatially. */
export enum LocationType {
  /** Single known address — one Geocoding API call. */
  SINGLE = 'SINGLE',
  /** Multiple branches listed explicitly — one call per branch. */
  LISTED = 'LISTED',
  /** Known chain (SPAR, KFC, etc.) — Places Text Search. */
  CHAIN = 'CHAIN',
  /** Online-only merchant (URL, Daraz, Uber, etc.) */
  ONLINE = 'ONLINE',
  /** No usable address or name found. */
  NONE = 'NONE',
}

// ─── Geo Result ───────────────────────────────────────────────────────────────

export type GeoSource = 'geocoding_api' | 'places_text_search';

export interface GeoResult {
  /** Whether the API call succeeded and coords are valid. */
  success: boolean;
  /** The address string sent to the API. */
  searchAddress: string;
  /** Google-formatted address (on success). */
  formattedAddress?: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  types?: string[];
  error?: string;
  message?: string;
  timestamp: string;
  source: GeoSource;
  /** Branch label for LISTED type. */
  branchName?: string;
  /** For Places results. */
  rating?: number | null;
  userRatingsTotal?: number;
  businessStatus?: string;
}

// ─── Chain Config ─────────────────────────────────────────────────────────────

export interface ChainConfig {
  /** Google Places query string, e.g. "Keells Food City Sri Lanka" */
  query: string;
  /** Google Places type, e.g. "supermarket" */
  type: string;
}

// ─── Location Data (adapter output) ──────────────────────────────────────────

/**
 * Normalized location data extracted by a bank's geo adapter.
 * This is the contract between adapters and the classifier/geocoder.
 */
export interface LocationData {
  offerId: string;
  merchantName: string;
  /** A specific city name if available, e.g. "Colombo 03" */
  city: string | null;
  /** A single-line location string (venue name, city, etc.) */
  location: string | null;
  /** A full street address if available */
  address: string | null;
  /** Pre-parsed list of address strings (ready to geocode) */
  addresses: string[];
  /** Pre-parsed individual branch addresses */
  branches: string[];
  phone: string | null;
  promotionDetails: string | null;
}

// ─── Classification Result ────────────────────────────────────────────────────

export interface LocationClassification {
  type: LocationType;
  /** For SINGLE / LISTED: the addresses to geocode. */
  addresses: string[];
  /** For CHAIN: the Places API search query. */
  chainQuery: string | null;
  /**
   * Cap on Places results to keep. Venue-name queries (a single hotel routed
   * through Places because Geocoding can't resolve business names) should keep
   * only the top few relevance-ranked hits; true chains keep everything.
   */
  chainResultLimit?: number;
  merchantForSearch: string;
}

// ─── Geocoded Offer Row ───────────────────────────────────────────────────────

export interface GeocodedOfferRow {
  offerId: string;
  merchantName: string;
  locationType: LocationType;
  locations: GeoResult[];
}

// ─── Geo Engine Output ────────────────────────────────────────────────────────

export interface GeoOutputMetadata {
  source: string;
  geocodedAt: string;
  totalOffers: number;
  locationTypes: Record<LocationType, number>;
  geocodedCount: number;
  totalLocations: number;
  duplicateRowsRemoved: number;
  apiStats: GeoSessionStats;
  dryRun: boolean;
}

export interface GeoOutput {
  metadata: GeoOutputMetadata;
  offers: GeocodedOfferRow[];
}

// ─── API Stats ────────────────────────────────────────────────────────────────

export interface GeoSessionStats {
  geocodeCached: number;
  geocodeNew: number;
  geocodeFailed: number;
  placesCached: number;
  placesNew: number;
}
