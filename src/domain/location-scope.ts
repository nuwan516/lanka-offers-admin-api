/**
 * Location Scope & Evidence Certainty for Lanka Offers.
 *
 * Preserves the core principle:
 *   "Never create geographic or merchant certainty that the source evidence does not support."
 *
 * Distinguishes:
 * - EXPLICIT_BRANCH   → specific physical address or branch explicitly named
 * - MULTIPLE_BRANCHES → multiple named branches explicitly listed
 * - SELECTED_OUTLETS  → "selected outlets" without branch list (PRESERVE UNCERTAINTY!)
 * - DISTRICT_REGION   → regional restriction, e.g. "selected Colombo outlets"
 * - NATIONWIDE        → applies islandwide / all merchant outlets
 * - ONLINE            → online purchase / mobile app / digital only (no physical venue)
 * - UNRESOLVED        → insufficient evidence in source
 */

import { SRI_LANKAN_CITIES } from '@/core/constants/cities';

export enum LocationScope {
  EXPLICIT_BRANCH = 'EXPLICIT_BRANCH',
  MULTIPLE_BRANCHES = 'MULTIPLE_BRANCHES',
  SELECTED_OUTLETS = 'SELECTED_OUTLETS',
  DISTRICT_REGION = 'DISTRICT_REGION',
  NATIONWIDE = 'NATIONWIDE',
  ONLINE = 'ONLINE',
  UNRESOLVED = 'UNRESOLVED',
}

export interface LocationScopeResult {
  scope: LocationScope;
  region?: string | null;
  rawEvidence: string;
  explanation: string;
  isGeocodableToCoordinates: boolean;
}

const SRI_LANKAN_DISTRICTS = [
  'colombo', 'gampaha', 'kalutara', 'kandy', 'matale', 'nuwara eliya',
  'galle', 'matara', 'hambantota', 'jaffna', 'kilinochchi', 'mannar',
  'vavuniya', 'mullaitivu', 'batticaloa', 'ampara', 'trincomalee',
  'kurunegala', 'puttalam', 'anuradhapura', 'polonnaruwa', 'badulla',
  'monaragala', 'ratnapura', 'kegalle',
];

const STRICT_ONLINE_INDICATORS = [
  /\bonline\s+only\b/i,
  /\bvalid\s+(?:only\s+)?(?:for\s+)?online\b/i,
  /\bwebsite\s+only\b/i,
  /\bapp\s+only\b/i,
  /\bvia\s+(?:the\s+)?(?:website|app|mobile\s+app)\b/i,
  /\bdownload\s+(?:the\s+)?(?:mobile\s+)?app\b/i,
  /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|glomark\.lk)\b/i,
  /\bpromo\s*code\b/i,
  /\buse\s+(?:promo\s+)?code\b/i,
  /\be-?commerce\b/i,
];

const KNOWN_ONLINE_MERCHANTS = /^(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|glomark\.lk)$/i;

const SELECTED_OUTLETS_INDICATORS = [
  /\bselected\s+(?:outlets?|branches?|stores?|locations?|restaurants?|properties|hotels?)\b/i,
  /\bparticipating\s+(?:outlets?|branches?|stores?|locations?|restaurants?|properties|hotels?)\b/i,
  /\bavailable\s+at\s+selected\b/i,
  /\bat\s+selected\s+(?:merchant\s+)?outlets?\b/i,
];

const NATIONWIDE_INDICATORS = [
  /\b(?:all\s+outlets?|all\s+branches?|all\s+stores?)\s+island\s*wide\b/i,
  /\ball\s+(?:outlets?|branches?|stores?)\b/i,
  /\bisland\s*wide\b/i,
  /\bnation\s*wide\b/i,
  /\bacross\s+sri\s+lanka\b/i,
];

const STREET_OR_VENUE_PATTERNS = [
  /\bNo\.?\s*\d+/i,
  /\b\d+[A-Z]?\s*[,/]\s*[A-Za-z]/i,
  /\b(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St)\b/i,
  /\b(?:Tower|Mall|Centre|Center|Complex|Plaza|Floor|Showroom|Arcade|Square)\b/i,
  /\b(?:Hotel|Resort|Villas?|Suites?|Inn|Lodge|Boutique)\b/i,
  /\b(?:Restaurant|Café|Cafe|Bakery|Kitchen|Pub|Bar|Dine|Lounge)\b/i,
  /\b(?:Hospital|Dental|Clinic|Medicare|Pharmacy)\b/i,
];

function hasPhysicalIndicator(text: string): boolean {
  if (!text) return false;
  if (STREET_OR_VENUE_PATTERNS.some((p) => p.test(text))) return true;
  const lower = text.toLowerCase();
  if (SRI_LANKAN_DISTRICTS.some((d) => new RegExp(`\\b${d}\\b`, 'i').test(lower))) return true;
  if (SRI_LANKAN_CITIES.some((c) => lower.includes(c))) return true;
  return false;
}

/**
 * Pure function to classify an offer's location evidence into an accurate LocationScope.
 * Guarantees:
 * - Never returns false precision coordinates for SELECTED_OUTLETS or NATIONWIDE.
 * - Respects ambiguity when branches are not listed.
 * - Never classifies physical venues as ONLINE simply because terms contain a URL.
 */
export function determineLocationScope(input: {
  location?: string | null;
  title?: string | null;
  description?: string | null;
  merchantName?: string | null;
  addresses?: string[];
  geoLocations?: any[];
}): LocationScopeResult {
  const loc = (input.location ?? '').trim();
  const title = (input.title ?? '').trim();
  const desc = (input.description ?? '').trim();
  const mName = (input.merchantName ?? '').trim();
  const addresses = (input.addresses ?? []).filter((a) => a && a.trim() && !a.startsWith('http'));
  const hasGeom = Array.isArray(input.geoLocations) && input.geoLocations.length > 0;

  const combined = `${loc} | ${title} | ${desc}`.toLowerCase();

  // 1. ONLINE ONLY check
  const isOnline = STRICT_ONLINE_INDICATORS.some((pattern) => pattern.test(combined));
  const hasPhysicalVenue =
    hasGeom ||
    addresses.length > 0 ||
    hasPhysicalIndicator(loc) ||
    hasPhysicalIndicator(title) ||
    hasPhysicalIndicator(mName);

  if (isOnline && !hasPhysicalVenue) {
    return {
      scope: LocationScope.ONLINE,
      rawEvidence: loc || title,
      explanation: 'Digital transaction — purchase on website or mobile app; no physical venue required.',
      isGeocodableToCoordinates: false,
    };
  }

  if (KNOWN_ONLINE_MERCHANTS.test(mName) && !hasGeom && addresses.length === 0 && !hasPhysicalIndicator(loc)) {
    return {
      scope: LocationScope.ONLINE,
      rawEvidence: mName,
      explanation: 'Known e-commerce platform with no physical store location.',
      isGeocodableToCoordinates: false,
    };
  }

  // 2. SELECTED OUTLETS check (with optional district/region)
  const isSelected = SELECTED_OUTLETS_INDICATORS.some((pattern) => pattern.test(combined));
  if (isSelected) {
    let matchedDistrict: string | null = null;
    for (const d of SRI_LANKAN_DISTRICTS) {
      if (new RegExp(`\\b${d}\\b`, 'i').test(combined)) {
        matchedDistrict = d.charAt(0).toUpperCase() + d.slice(1);
        break;
      }
    }

    if (matchedDistrict) {
      return {
        scope: LocationScope.DISTRICT_REGION,
        region: matchedDistrict,
        rawEvidence: loc || title,
        explanation: `Restricted to selected outlets in ${matchedDistrict}. Branch list not specified by bank.`,
        isGeocodableToCoordinates: false,
      };
    }

    return {
      scope: LocationScope.SELECTED_OUTLETS,
      rawEvidence: loc || title,
      explanation: 'Available at selected merchant outlets. The bank does not publish the participating branch list.',
      isGeocodableToCoordinates: false,
    };
  }

  // 3. NATIONWIDE check (Islandwide / All Outlets)
  const isNationwide = NATIONWIDE_INDICATORS.some((pattern) => pattern.test(combined));
  if (isNationwide) {
    return {
      scope: LocationScope.NATIONWIDE,
      rawEvidence: loc || title,
      explanation: 'Applies across all merchant branches islandwide.',
      isGeocodableToCoordinates: false,
    };
  }

  // 4. MULTIPLE EXPLICIT BRANCHES
  const branchSource = loc || addresses.join(' ; ') || desc;
  if (
    addresses.length > 1 ||
    (branchSource && (branchSource.includes(' / ') || branchSource.includes(';') || (branchSource.match(/\bbranch(?:es)?\b/gi) && branchSource.match(/\bbranch(?:es)?\b/gi)!.length > 1)))
  ) {
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      rawEvidence: loc || (addresses.length > 0 ? addresses.join(', ') : desc),
      explanation: 'Multiple specific branches explicitly listed in offer evidence.',
      isGeocodableToCoordinates: true,
    };
  }

  // 5. EXPLICIT SINGLE BRANCH
  if (
    addresses.length === 1 ||
    hasGeom ||
    (loc && hasPhysicalIndicator(loc) && loc.length > 3 && !/^(?:all|selected|participating)\b/i.test(loc))
  ) {
    return {
      scope: LocationScope.EXPLICIT_BRANCH,
      rawEvidence: addresses.length === 1 ? addresses[0] : (loc || title),
      explanation: 'Specific physical address or named branch venue identified.',
      isGeocodableToCoordinates: true,
    };
  }

  // 6. UNRESOLVED
  return {
    scope: LocationScope.UNRESOLVED,
    rawEvidence: loc || title,
    explanation: 'Insufficient branch-level evidence in bank source.',
    isGeocodableToCoordinates: false,
  };
}
