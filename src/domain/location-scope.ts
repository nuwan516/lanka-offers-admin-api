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

const ONLINE_INDICATORS = [
  /\bonline\s+only\b/i,
  /\bvalid\s+(?:only\s+)?(?:for\s+)?online\b/i,
  /\bwebsite\s+only\b/i,
  /\bapp\s+only\b/i,
  /\bvia\s+(?:the\s+)?(?:website|app|mobile\s+app)\b/i,
  /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|singer\.lk|glomark\.lk)\b/i,
  /\b(?:www\.[a-z0-9-]+\.(?:lk|com)|https?:\/\/[^\s]+)\b/i,
];

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
  /\b(?:Hotel|Resort|Villas?|Suites?)\b/i,
];

/**
 * Pure function to classify an offer's location evidence into an accurate LocationScope.
 * Guarantees:
 * - Never returns false precision coordinates for SELECTED_OUTLETS or NATIONWIDE.
 * - Respects ambiguity when branches are not listed.
 */
export function determineLocationScope(input: {
  location?: string | null;
  title?: string | null;
  description?: string | null;
  merchantName?: string | null;
}): LocationScopeResult {
  const loc = (input.location ?? '').trim();
  const title = (input.title ?? '').trim();
  const desc = (input.description ?? '').trim();
  const combined = `${loc} | ${title} | ${desc}`.toLowerCase();

  // 1. ONLINE ONLY check
  const isOnline = ONLINE_INDICATORS.some((pattern) => pattern.test(combined));
  const hasPhysicalVenue = STREET_OR_VENUE_PATTERNS.some((pattern) => pattern.test(loc));

  if (isOnline && !hasPhysicalVenue) {
    return {
      scope: LocationScope.ONLINE,
      rawEvidence: loc || title,
      explanation: 'Digital transaction — purchase on website or mobile app; no physical venue required.',
      isGeocodableToCoordinates: false,
    };
  }

  // 2. SELECTED OUTLETS check (with optional district/region)
  const isSelected = SELECTED_OUTLETS_INDICATORS.some((pattern) => pattern.test(combined));
  if (isSelected) {
    // Check if a specific district is mentioned (e.g. "Selected Colombo outlets")
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
        isGeocodableToCoordinates: false, // DO NOT assign a single coordinate for a whole district!
      };
    }

    return {
      scope: LocationScope.SELECTED_OUTLETS,
      rawEvidence: loc || title,
      explanation: 'Available at selected merchant outlets. The bank does not publish the participating branch list.',
      isGeocodableToCoordinates: false, // DO NOT assign all merchant branches!
    };
  }

  // 3. NATIONWIDE check (Islandwide / All Outlets)
  const isNationwide = NATIONWIDE_INDICATORS.some((pattern) => pattern.test(combined));
  if (isNationwide) {
    return {
      scope: LocationScope.NATIONWIDE,
      rawEvidence: loc || title,
      explanation: 'Applies across all merchant branches islandwide.',
      isGeocodableToCoordinates: false, // Scope is nationwide, not a single pin
    };
  }

  // 4. MULTIPLE EXPLICIT BRANCHES
  const branchSource = loc || desc;
  if (branchSource && (branchSource.includes(' / ') || branchSource.includes(';') || (branchSource.match(/\bbranch(?:es)?\b/gi) && branchSource.match(/\bbranch(?:es)?\b/gi)!.length > 1))) {
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      rawEvidence: loc || desc,
      explanation: 'Multiple specific branches explicitly listed in offer evidence.',
      isGeocodableToCoordinates: true,
    };
  }

  // 5. EXPLICIT SINGLE BRANCH
  if (loc && (STREET_OR_VENUE_PATTERNS.some((pattern) => pattern.test(loc)) || /\b(?:colombo\s*\d{1,2}|kandy|galle|jaffna|negombo)\b/i.test(loc))) {
    // Make sure it's not just a brand name or marketing copy
    if (loc.length > 3 && !/^(?:all|selected|participating)\b/i.test(loc)) {
      return {
        scope: LocationScope.EXPLICIT_BRANCH,
        rawEvidence: loc,
        explanation: 'Specific physical address or named branch venue identified.',
        isGeocodableToCoordinates: true,
      };
    }
  }

  // 6. UNRESOLVED
  return {
    scope: LocationScope.UNRESOLVED,
    rawEvidence: loc || title,
    explanation: 'Insufficient branch-level evidence in bank source.',
    isGeocodableToCoordinates: false,
  };
}
