import { LocationType, LocationClassification, LocationData } from '@/core/types/geo';
import { matchChain } from '@/core/constants/chains';
import { buildAddress } from '@/parsing/geo/branch-parser';
import { SRI_LANKAN_CITIES } from '@/core/constants/cities';

// ─── Online merchant patterns ─────────────────────────────────────────────────

const ONLINE_PATTERNS = /uber|daraz|pickme|food\s*panda|shopee|lazada/i;

// ─── "All outlets" pattern ────────────────────────────────────────────────────

const ALL_OUTLETS_PATTERN = /all\s+(outlets?|branches)/i;

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify an offer's location data into one of five location types:
 *
 * - SINGLE  → one physical address → one Geocoding API call
 * - LISTED  → multiple explicit branches → batch Geocoding
 * - CHAIN   → known chain or "All Outlets" → Places Text Search
 * - ONLINE  → URL / known online merchant → no geocoding
 * - NONE    → no usable location data
 *
 * This is a pure function — no side effects, fully testable.
 */
export function classify(locData: LocationData): LocationClassification {
  const {
    merchantName,
    city,
    location,
    address,
    addresses,
    branches,
  } = locData;

  const name = (merchantName ?? '').trim();

  // ── 1. Pre-parsed branches (adapter already split them) ──────────────────
  if (branches && branches.length > 0) {
    if (branches.length === 1) {
      return { type: LocationType.SINGLE, addresses: branches, chainQuery: null, merchantForSearch: name };
    }
    return { type: LocationType.LISTED, addresses: branches, chainQuery: null, merchantForSearch: name };
  }

  // ── 2. ONLINE: URL location, domain-style name, campaign, or known
  //      online-only merchant — none of these have a geocodable venue ────────
  if (
    (location ?? '').startsWith('http') ||
    (name ?? '').startsWith('www.') ||
    /\.(?:lk|com|net|org)\b/i.test(name) ||           // "BuyMe.lk", "crazyjets.com"
    /\b(?:visa|mastercard)\b.*\boffers?\b/i.test(name) || // "Visa Concierge Offers 2026"
    ONLINE_PATTERNS.test(name)
  ) {
    return { type: LocationType.ONLINE, addresses: [], chainQuery: null, merchantForSearch: name };
  }

  // ── 3. CHAIN: "All Outlets" / "All Branches" in location ────────────────
  if (ALL_OUTLETS_PATTERN.test(location ?? '')) {
    // But verify it doesn't also contain a "selected" restriction
    if (!/selected|participating/i.test(location ?? '')) {
      const chain = matchChain(name);
      const chainQuery = chain ? chain.query : `${name} Sri Lanka`;
      return { type: LocationType.CHAIN, addresses: [], chainQuery, merchantForSearch: name };
    }
  }

  // ── Selected outlets restriction: NEVER expand to all chain branches ───
  // Knowledge of merchant branches does NOT prove the offer applies to all of them.
  if (
    /selected\s+(?:outlets?|branches?|stores?)|participating\s+(?:outlets?|branches?|stores?)/i.test(location ?? '') ||
    /selected\s+(?:outlets?|branches?|stores?)|participating\s+(?:outlets?|branches?|stores?)/i.test(locData.promotionDetails ?? '')
  ) {
    return { type: LocationType.NONE, addresses: [], chainQuery: null, merchantForSearch: name };
  }

  // ── 4. CHAIN: known chain with no specific address ───────────────────────
  const chain = matchChain(name);
  if (chain && !address && !city && (!addresses || addresses.length === 0)) {
    return { type: LocationType.CHAIN, addresses: [], chainQuery: chain.query, merchantForSearch: name };
  }

  // ── 5. NONE: absolutely nothing ─────────────────────────────────────────
  if (!name && !city && !address && !(addresses && addresses.length)) {
    return { type: LocationType.NONE, addresses: [], chainQuery: null, merchantForSearch: '' };
  }

  // ── 6. Pre-built addresses from adapter ─────────────────────────────────
  if (addresses && addresses.length === 1) {
    // A venue-name query ("Avani Kalutara Resort, Sri Lanka") sent to the
    // Geocoding API only returns the country centroid — Places Text Search
    // is the API that resolves business names.
    if (isVenueNameQuery(addresses[0])) {
      return { type: LocationType.CHAIN, addresses: [], chainQuery: addresses[0], chainResultLimit: 3, merchantForSearch: name };
    }
    return { type: LocationType.SINGLE, addresses, chainQuery: null, merchantForSearch: name };
  }
  if (addresses && addresses.length > 1) {
    return { type: LocationType.LISTED, addresses, chainQuery: null, merchantForSearch: name };
  }

  // ── 7. Build address from parts ─────────────────────────────────────────
  const builtAddr = buildAddress({ merchantName: name, city, location, address });
  if (builtAddr) {
    if (isVenueNameQuery(builtAddr)) {
      return { type: LocationType.CHAIN, addresses: [], chainQuery: builtAddr, chainResultLimit: 3, merchantForSearch: name };
    }
    return { type: LocationType.SINGLE, addresses: [builtAddr], chainQuery: null, merchantForSearch: name };
  }

  return { type: LocationType.NONE, addresses: [], chainQuery: null, merchantForSearch: name };
}

/**
 * True when the "address" is really a business/venue name rather than a
 * street address or bare city — no street number, no road word, and the
 * leading part is not a known Sri Lankan city.
 */
function isVenueNameQuery(addr: string): boolean {
  const withoutCountry = addr.replace(/,\s*Sri\s+Lanka\s*$/i, '').trim();
  if (/\d/.test(withoutCountry)) return false; // street number / district number
  if (/\b(?:road|street|lane|place|avenue|mawatha|junction|rd|st|floor)\b/i.test(withoutCountry)) return false;
  const parts = withoutCountry.split(',').map((p) => p.trim().toLowerCase());
  // "Wadduwa" or "Dehiwala, Mount Lavinia" style — every part is a known city
  if (parts.length > 0 && parts.every((p) => SRI_LANKAN_CITIES.includes(p))) return false;
  return withoutCountry.length > 0;
}
