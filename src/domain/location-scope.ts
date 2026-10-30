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

export type AddressPrecision =
  | 'EXACT_STREET_ADDRESS'
  | 'VENUE_NAME_ONLY'
  | 'MALL_OR_COMPLEX'
  | 'CITY_OR_DISTRICT_ONLY'
  | 'NO_ADDRESS';

export type CoordinateConfidence =
  | 'VERIFIED_COORDINATES'
  | 'GEOCODABLE'
  | 'NOT_GEOCODABLE';

export type VenueIdentityConfidence =
  | 'SINGLE_CONCRETE_VENUE'
  | 'MULTI_VENUE_CHAIN'
  | 'ONLINE_ONLY'
  | 'UNRESOLVED_VENUE';

export type BranchListCompleteness =
  | 'ALL_OUTLETS_APPLICABLE'
  | 'COMPLETE_BRANCH_LIST'
  | 'INCOMPLETE_RESTRICTION'
  | 'INSUFFICIENT_EVIDENCE';

export interface LocationScopeResult {
  scope: LocationScope;
  region?: string | null;
  rawEvidence: string;
  explanation: string;
  isGeocodableToCoordinates: boolean;
  venueIdentity?: VenueIdentityConfidence;
  addressPrecision?: AddressPrecision;
  coordinateConfidence?: CoordinateConfidence;
  branchListCompleteness?: BranchListCompleteness;
  participatingBranchesCount?: number | null;
  participatingBranches?: string[];
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
  /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans\.com|kapruka|glomark\.lk|foody(?:\.lk)?|wasi\.lk|buyme(?:\.lk)?)\b/i,
  /\bonline\s+orders?\b/i,
  /\bonline\s+purchases?\b/i,
  /\bweb\s+orders?\b/i,
  /\bvia\s+[a-z0-9-]+\.(?:lk|com)\b/i,
  /\bpromo\s*code\b/i,
  /\buse\s+(?:promo\s+)?code\b/i,
  /\be-?commerce\b/i,
  /\bspend\s+and\s+win\b/i,
  /\bpos\s+and\s+e-?commerce\b/i,
];

const KNOWN_ONLINE_MERCHANTS = /\b(?:daraz|pickme|uber\s*eats|food\s*panda|buyabans(?:\.com)?|buyabans\s*com|kapruka(?:\.com)?|kapruka\s*com|glomark\.lk|foody(?:\.lk)?|wasi\.lk|takas\.lk|singersl\.com|keellssuper\.com|buyme(?:\.lk)?)\b/i;

const SELECTED_OUTLETS_INDICATORS = [
  /\bselected\s+(?:outlets?|branches?|stores?|locations?|supermarkets?|restaurants?|properties|hotels?)\b/i,
  /\bselected\s+[a-z0-9-]+\s+(?:outlets?|branches?|stores?|locations?|supermarkets?|restaurants?|properties|hotels?)\b/i,
  /\bparticipating\s+(?:outlets?|branches?|stores?|locations?|supermarkets?|restaurants?|properties|hotels?)\b/i,
  /\bavailable\s+at\s+selected\b/i,
  /\bat\s+selected\s+(?:merchant\s+)?outlets?\b/i,
  /\bvalid\s+at\s+below\s+outlets\s+only\b/i,
  /\bbelow\s+outlets\s+only\b/i,
];

const NATIONWIDE_INDICATORS = [
  /\b(?:all\s+(?:[a-z0-9-]+\s+){0,3}(?:outlets?|branches?|stores?|showrooms?))\s+island\s*wide\b/i,
  /\ball\s+(?:[a-z0-9-]+\s+){0,3}(?:outlets?|branches?|stores?|showrooms?)\b/i,
  /\ball\s+[^.!?\n]{1,60}\b(?:outlets?|branches?|stores?|showrooms?)\b/i,
  /\bisland\s*wide\b/i,
  /\bnation\s*wide\b/i,
  /\bacross\s+sri\s+lanka\b/i,
];

const STREET_PATTERNS = [
  /\bNo\.?\s*\d+/i,
  /\b\d+[A-Z]?\s*[,/]\s*[A-Za-z]/i,
  /\b(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St|Drive)\b/i,
  /\b(?:Floor|Showroom|Building)\b/i,
];

const MALL_PATTERNS = [
  /\b(?:One\s+Galle\s+Face|Colombo\s+City\s+Centre|Crescat\s+Boulevard|Havelock\s+City\s+Mall|Majestic\s+City|Liberty\s+Plaza|Kandy\s+City\s+Centre|Marino\s+Mall|Arcade\s+Independence\s+Square)\b/i,
  /\b(?:Tower|Mall|Complex|Plaza|Arcade|Square)\b/i,
];

const SPECIFIC_LANDMARK_VENUES = [
  /\b(?:Galle\s+Face\s+Hotel|The\s+Kingsbury|Kingsbury\s+Colombo|Hilton\s+Colombo|Cinnamon\s+Grand|Cinnamon\s+Lakeside|Cinnamon\s+Red|Cinnamon\s+Life|Amaya\s+Lake|Amaya\s+Hills|Amaya\s+Beach|Heritance\s+Kandalama|Heritance\s+Ahungalla|Heritance\s+Tea\s+Factory|Water'?s\s+Edge|Mount\s+Lavinia\s+Hotel|Taj\s+Samudra|Shangri-La\s+Colombo|Shangri-La\s+Hambantota|Mövenpick\s+Hotel|Movenpick\s+Colombo|Radisson\s+Hotel\s+Kandy|Radisson\s+Blu\s+Resort|Courtyard\s+by\s+Marriott|Sheraton\s+Colombo|Centauria\s+Wild|Clove\s+Villa|Hotel\s+Casamara|Lotus\s+Estate\s+Colombo|Hillcrest\s+Ella|Hibiscus\s+Beach|Kurundu\s+Wellness|Tangerine\s+Beach|Siddhalepa|Via\s+Torino)\b/i,
];

const GENERIC_VENUE_KEYWORDS = [
  /\b(?:Hotel|Resort|Villas?|Suites?|Inn|Lodge|Boutique|Estate|Chalet|Cottage|Bungalow|Retreat|Palace|Hospital|Ayurveda|Wellness|Clinic|Bakery|Cafe|Café|Restaurant|Kitchen|Pizzeria|Bistro|Lounge)\b/i,
];

const KNOWN_CHAIN_BRANDS = [
  /\b(?:cargills(?:\s+food\s+city)?|keells(?:\s+super)?|glomark(?:\s+supermarket)?|arpico(?:\s+supercentre)?|spar(?:\s+supermarket)?)\b/i,
  /\b(?:abans|singer(?:\s+mega|\s+sri\s+lanka)?|softlogic(?:\s+max)?|damro|damro\s+showrooms)\b/i,
  /\b(?:nolimit|odel|cool\s+planet|house\s+of\s+fashion|kelly\s+felder|amante|dsi(?:\s+footwear)?)\b/i,
  /\b(?:pizza\s+hut|domino'?s|kfc|mcdonald'?s|burger\s+king|barista|coffee\s+bean)\b/i,
  /\b(?:jetwing\s+hotels?(?:\s+&\s+resorts)?|hayleys\s+hotels?|cinnamon\s+hotels?)\b/i,
];

function isKnownChainBrand(name: string): boolean {
  if (!name) return false;
  return KNOWN_CHAIN_BRANDS.some((p) => p.test(name));
}

function hasStreetPattern(text: string): boolean {
  if (!text) return false;
  return STREET_PATTERNS.some((p) => p.test(text));
}

function hasMallPattern(text: string): boolean {
  if (!text) return false;
  return MALL_PATTERNS.some((p) => p.test(text));
}

function hasSpecificLandmarkVenue(text: string): boolean {
  if (!text) return false;
  if (isKnownChainBrand(text)) return false;
  return SPECIFIC_LANDMARK_VENUES.some((p) => p.test(text));
}

function hasConcreteSingleVenue(text: string): boolean {
  if (!text) return false;
  if (isKnownChainBrand(text)) return false;
  return SPECIFIC_LANDMARK_VENUES.some((p) => p.test(text)) || GENERIC_VENUE_KEYWORDS.some((p) => p.test(text));
}

function extractCitiesFromText(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const matched = new Set<string>();
  for (const c of SRI_LANKAN_CITIES) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(lower)) {
      matched.add(c.charAt(0).toUpperCase() + c.slice(1));
    }
  }
  return Array.from(matched);
}

const norm = (v: string) => v.toLowerCase().replace(/,?\s*sri\s*lanka\s*$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * An "address" that is only the merchant's own name (e.g. "Daraz, Sri Lanka") is a search hint,
 * not a venue — it must not make an offer look like it has a physical location.
 * BUT if the merchant itself indicates a concrete physical venue (e.g. "Clove Villa", "Hotel Casamara"),
 * it represents a genuine physical establishment.
 */
export function isMerchantOnlyAddress(address: string, merchantName?: string | null): boolean {
  const a = norm(address);
  if (!a || a === '.' || a === '-') return true;
  if (/\bonline\s*(?:only)?\b/i.test(a) || /\bwebsite\b/i.test(a) || /\bmobile\s*app\b/i.test(a) || /\bvia\s+(?:the\s+)?app\b/i.test(a)) {
    return true;
  }
  const m = norm(merchantName ?? '');
  if (KNOWN_ONLINE_MERCHANTS.test(address) || KNOWN_ONLINE_MERCHANTS.test(merchantName ?? '') || KNOWN_ONLINE_MERCHANTS.test(a) || KNOWN_ONLINE_MERCHANTS.test(m)) {
    return true;
  }
  if (m && a === m) {
    if (hasStreetPattern(m) || hasMallPattern(m) || hasConcreteSingleVenue(m)) {
      return false;
    }
    return true;
  }
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
  terms?: string[];
}): LocationScopeResult {
  let loc = (input.location ?? '').trim();
  // Filter out noise in location string
  if (loc === '.' || loc === '-' || /\bdebit\s+and\s+credit\b/i.test(loc)) {
    loc = '';
  }

  const title = (input.title ?? '').trim();
  const desc = (input.description ?? '').trim();
  const mName = (input.merchantName ?? '').trim();
  const termsText = (input.terms ?? []).join(' ');
  const addresses = (input.addresses ?? []).filter(
    (a) => a && a.trim() && a !== '.' && !a.startsWith('http') && !isMerchantOnlyAddress(a, input.merchantName),
  );
  const hasGeom = Array.isArray(input.geoLocations) && input.geoLocations.length > 0;

  const combined = `${loc} | ${title} | ${desc} | ${termsText} | ${mName}`.toLowerCase();

  // 1. ONLINE ONLY check
  const isOnline = STRICT_ONLINE_INDICATORS.some((pattern) => pattern.test(combined));
  const mentionsPhysicalOutlets = /\b(?:outlets?|branches?|stores?|showrooms?|supermarkets?|restaurants?|hotels?|resorts?)\b/i.test(combined);
  const hasPhysicalVenue =
    hasGeom ||
    addresses.length > 0 ||
    hasStreetPattern(loc) ||
    hasMallPattern(loc) ||
    hasConcreteSingleVenue(loc) ||
    hasStreetPattern(title) ||
    hasMallPattern(title) ||
    hasConcreteSingleVenue(title) ||
    hasStreetPattern(mName) ||
    hasMallPattern(mName) ||
    hasConcreteSingleVenue(mName) ||
    mentionsPhysicalOutlets;

  if (isOnline && !hasPhysicalVenue) {
    return {
      scope: LocationScope.ONLINE,
      venueIdentity: 'ONLINE_ONLY',
      addressPrecision: 'NO_ADDRESS',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'ALL_OUTLETS_APPLICABLE',
      rawEvidence: loc || title || mName,
      explanation: 'Digital transaction — purchase on website or mobile app; no physical venue required.',
      isGeocodableToCoordinates: false,
      participatingBranchesCount: 0,
      participatingBranches: [],
    };
  }

  if (KNOWN_ONLINE_MERCHANTS.test(mName) && !hasGeom && addresses.length === 0 && !hasStreetPattern(loc) && !hasMallPattern(loc)) {
    return {
      scope: LocationScope.ONLINE,
      venueIdentity: 'ONLINE_ONLY',
      addressPrecision: 'NO_ADDRESS',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'ALL_OUTLETS_APPLICABLE',
      rawEvidence: mName,
      explanation: 'Known e-commerce platform with no physical store location.',
      isGeocodableToCoordinates: false,
      participatingBranchesCount: 0,
      participatingBranches: [],
    };
  }

  // 2. MULTIPLE EXPLICIT BRANCHES
  // A. Check for multiple distinct hotel/resort properties
  const hotelPropertyMatches = (desc || title || combined).match(/(?:jetwing|amaya|cinnamon|heritance)\s+(?!(?:resorts?|hotels?|spas?|properties|group|villas?)\b)[a-z]+/gi);
  if (hotelPropertyMatches && new Set(hotelPropertyMatches.map((s) => s.toLowerCase())).size > 1) {
    const branches = Array.from(new Set(hotelPropertyMatches));
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      venueIdentity: 'MULTI_VENUE_CHAIN',
      addressPrecision: 'VENUE_NAME_ONLY',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: branches.join(', '),
      explanation: `Multiple distinct properties listed in offer evidence: ${branches.join(', ')}.`,
      isGeocodableToCoordinates: false,
      participatingBranchesCount: branches.length,
      participatingBranches: branches,
    };
  }

  if (loc && (loc.includes(';') || (loc.includes(' / ') && !loc.includes('http')))) {
    const branches = loc.split(/[;/]/).map((b) => b.trim()).filter(Boolean);
    if (branches.length > 1) {
      return {
        scope: LocationScope.MULTIPLE_BRANCHES,
        venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
        addressPrecision: 'CITY_OR_DISTRICT_ONLY',
        coordinateConfidence: 'NOT_GEOCODABLE',
        branchListCompleteness: 'COMPLETE_BRANCH_LIST',
        rawEvidence: loc,
        explanation: `Multiple branch locations separated by delimiter: ${branches.join(', ')}.`,
        isGeocodableToCoordinates: false,
        participatingBranchesCount: branches.length,
        participatingBranches: branches,
      };
    }
  }

  const citiesInLoc = extractCitiesFromText(loc);
  const citiesInDesc = extractCitiesFromText(desc);
  const branchMentionCount = (desc || title || combined).match(/\b(?:branch(?:es)?|outlets?|stores?|showrooms?)\b/gi)?.length ?? 0;
  const hasMultipleBranchMentions = branchMentionCount > 1 && (citiesInDesc.length > 1 || citiesInLoc.length > 1);

  if (hasMultipleBranchMentions) {
    const branches = citiesInDesc.length > 1 ? citiesInDesc : (citiesInLoc.length > 1 ? citiesInLoc : ['Multiple branches']);
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
      addressPrecision: 'CITY_OR_DISTRICT_ONLY',
      coordinateConfidence: 'GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: desc,
      explanation: `Multiple branches explicitly listed: ${branches.join(', ')}.`,
      isGeocodableToCoordinates: true,
      participatingBranchesCount: branches.length,
      participatingBranches: branches,
    };
  }

  if (citiesInLoc.length > 1) {
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
      addressPrecision: 'CITY_OR_DISTRICT_ONLY',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: loc,
      explanation: `Multiple participating city branches identified: ${citiesInLoc.join(', ')}.`,
      isGeocodableToCoordinates: false,
      participatingBranchesCount: citiesInLoc.length,
      participatingBranches: citiesInLoc,
    };
  }

  const multiCityInBranchContext = (desc || combined).match(/\b(?:branches|outlets|stores|showrooms)\s+(?:in|at)\s+([a-z,\s&]+)\b/i) ||
                                   (desc || combined).match(/\b(?:at|in)\s+(?:[a-z0-9\s-]+\s+)?([a-z,\s&]+)\s+(?:branches|outlets|stores|showrooms)\b/i);

  if ((multiCityInBranchContext || branchMentionCount >= 1) && citiesInDesc.length > 1) {
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
      addressPrecision: 'CITY_OR_DISTRICT_ONLY',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: multiCityInBranchContext ? multiCityInBranchContext[0] : citiesInDesc.join(', '),
      explanation: `Multiple participating city branches explicitly listed in description: ${citiesInDesc.join(', ')}.`,
      isGeocodableToCoordinates: false,
      participatingBranchesCount: citiesInDesc.length,
      participatingBranches: citiesInDesc,
    };
  }

  if (addresses.length > 1) {
    return {
      scope: LocationScope.MULTIPLE_BRANCHES,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
      addressPrecision: 'EXACT_STREET_ADDRESS',
      coordinateConfidence: 'GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: addresses.join(', '),
      explanation: 'Multiple specific branches explicitly listed in address array.',
      isGeocodableToCoordinates: true,
      participatingBranchesCount: addresses.length,
      participatingBranches: addresses,
    };
  }

  // 3. SELECTED OUTLETS check (with optional district/region)
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
        venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'UNRESOLVED_VENUE',
        addressPrecision: 'CITY_OR_DISTRICT_ONLY',
        coordinateConfidence: 'NOT_GEOCODABLE',
        branchListCompleteness: 'INCOMPLETE_RESTRICTION',
        rawEvidence: loc || title,
        explanation: `Restricted to selected outlets in ${matchedDistrict}. Branch list not specified by bank.`,
        isGeocodableToCoordinates: false,
      };
    }

    return {
      scope: LocationScope.SELECTED_OUTLETS,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'UNRESOLVED_VENUE',
      addressPrecision: 'NO_ADDRESS',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'INCOMPLETE_RESTRICTION',
      rawEvidence: loc || title,
      explanation: 'Available at selected merchant outlets. The bank does not publish the participating branch list.',
      isGeocodableToCoordinates: false,
    };
  }

  // 4. NATIONWIDE check (Islandwide / All Outlets)
  const isNationwide = NATIONWIDE_INDICATORS.some((pattern) => pattern.test(combined));
  if (isNationwide) {
    return {
      scope: LocationScope.NATIONWIDE,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'UNRESOLVED_VENUE',
      addressPrecision: 'NO_ADDRESS',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'ALL_OUTLETS_APPLICABLE',
      rawEvidence: loc || title,
      explanation: 'Applies across all merchant branches islandwide.',
      isGeocodableToCoordinates: false,
    };
  }

  // 5. EXPLICIT SINGLE BRANCH vs DISTRICT_REGION vs NAMED VENUE
  if (addresses.length === 1) {
    const singleAddr = addresses[0].toLowerCase().replace(/,?\s*sri\s*lanka\s*$/i, '').trim();
    const isPureDistrictOrCity =
      SRI_LANKAN_DISTRICTS.includes(singleAddr) || SRI_LANKAN_CITIES.includes(singleAddr);
    const hasStreet = hasStreetPattern(addresses[0]);
    const hasMall = hasMallPattern(addresses[0]);
    const hasVenue = hasConcreteSingleVenue(addresses[0]) || hasConcreteSingleVenue(title) || hasConcreteSingleVenue(mName);

    const hasDistrictKeyword = /\b(?:district|province|region|zone)\b/i.test(combined);

    if (isPureDistrictOrCity && !hasStreet && !hasMall && !hasVenue) {
      const regionName = singleAddr.charAt(0).toUpperCase() + singleAddr.slice(1);
      if (hasDistrictKeyword || isKnownChainBrand(mName)) {
        return {
          scope: LocationScope.DISTRICT_REGION,
          region: regionName,
          venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'UNRESOLVED_VENUE',
          addressPrecision: 'CITY_OR_DISTRICT_ONLY',
          coordinateConfidence: 'NOT_GEOCODABLE',
          branchListCompleteness: 'INCOMPLETE_RESTRICTION',
          rawEvidence: addresses[0],
          explanation: isKnownChainBrand(mName)
            ? `Restricted to ${regionName} area for chain merchant ${mName}. Specific branch outlet not specified.`
            : `Restricted to ${regionName} region. Specific street address not provided.`,
          isGeocodableToCoordinates: false,
          participatingBranchesCount: null,
          participatingBranches: [],
        };
      } else {
        return {
          scope: LocationScope.EXPLICIT_BRANCH,
          venueIdentity: 'SINGLE_CONCRETE_VENUE',
          addressPrecision: 'CITY_OR_DISTRICT_ONLY',
          coordinateConfidence: 'NOT_GEOCODABLE',
          branchListCompleteness: 'COMPLETE_BRANCH_LIST',
          rawEvidence: addresses[0],
          explanation: `Single physical branch located in ${singleAddr}. Exact street address not specified.`,
          isGeocodableToCoordinates: false,
          participatingBranchesCount: 1,
          participatingBranches: [addresses[0]],
        };
      }
    }

    return {
      scope: LocationScope.EXPLICIT_BRANCH,
      venueIdentity: hasVenue ? 'SINGLE_CONCRETE_VENUE' : (isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE'),
      addressPrecision: hasStreet ? 'EXACT_STREET_ADDRESS' : (hasMall ? 'MALL_OR_COMPLEX' : 'VENUE_NAME_ONLY'),
      coordinateConfidence: hasStreet || hasMall ? 'GEOCODABLE' : 'NOT_GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: addresses[0],
      explanation: 'Specific physical address or named branch venue identified.',
      isGeocodableToCoordinates: hasStreet || hasMall || hasGeom,
      participatingBranchesCount: 1,
      participatingBranches: [addresses[0]],
    };
  }

  // Check concrete single venue in merchant name or location
  const hasLandmark = hasSpecificLandmarkVenue(mName) || hasSpecificLandmarkVenue(loc) || hasSpecificLandmarkVenue(title);
  const hasGenericWithLoc = (hasConcreteSingleVenue(mName) || hasConcreteSingleVenue(loc) || hasConcreteSingleVenue(title)) && (Boolean(loc) || addresses.length > 0 || extractCitiesFromText(combined).length > 0);

  if (hasLandmark || hasGenericWithLoc) {
    const venueName = hasSpecificLandmarkVenue(mName) ? mName : (hasSpecificLandmarkVenue(loc) ? loc : (loc || mName || title));
    return {
      scope: LocationScope.EXPLICIT_BRANCH,
      venueIdentity: 'SINGLE_CONCRETE_VENUE',
      addressPrecision: hasStreetPattern(loc) ? 'EXACT_STREET_ADDRESS' : (hasMallPattern(loc) ? 'MALL_OR_COMPLEX' : 'VENUE_NAME_ONLY'),
      coordinateConfidence: hasStreetPattern(loc) || hasMallPattern(loc) ? 'GEOCODABLE' : (hasGeom ? 'VERIFIED_COORDINATES' : 'NOT_GEOCODABLE'),
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: venueName,
      explanation: 'Single concrete landmark venue identified.',
      isGeocodableToCoordinates: hasGeom || hasStreetPattern(loc) || hasMallPattern(loc),
      participatingBranchesCount: 1,
      participatingBranches: [venueName],
    };
  }

  // If merchant is a known multi-branch chain and NO location/address was provided:
  if (isKnownChainBrand(mName) && !loc && addresses.length === 0) {
    return {
      scope: LocationScope.UNRESOLVED,
      venueIdentity: 'MULTI_VENUE_CHAIN',
      addressPrecision: 'NO_ADDRESS',
      coordinateConfidence: 'NOT_GEOCODABLE',
      branchListCompleteness: 'INSUFFICIENT_EVIDENCE',
      rawEvidence: mName,
      explanation: `Merchant ${mName} is a multi-branch retail chain, but bank source does not state participating branch list or location.`,
      isGeocodableToCoordinates: false,
      participatingBranchesCount: null,
      participatingBranches: [],
    };
  }

  // Check loc with street or mall pattern
  if (loc && (hasStreetPattern(loc) || hasMallPattern(loc))) {
    return {
      scope: LocationScope.EXPLICIT_BRANCH,
      venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'SINGLE_CONCRETE_VENUE',
      addressPrecision: hasStreetPattern(loc) ? 'EXACT_STREET_ADDRESS' : 'MALL_OR_COMPLEX',
      coordinateConfidence: 'GEOCODABLE',
      branchListCompleteness: 'COMPLETE_BRANCH_LIST',
      rawEvidence: loc,
      explanation: 'Specific street address or mall identified in location.',
      isGeocodableToCoordinates: true,
      participatingBranchesCount: 1,
      participatingBranches: [loc],
    };
  }

  // Check loc for single city or district
  if (loc) {
    const cleanLoc = loc.toLowerCase().replace(/,?\s*sri\s*lanka\s*$/i, '').trim();
    const isPureCity = SRI_LANKAN_CITIES.includes(cleanLoc);
    const isPureDistrict = SRI_LANKAN_DISTRICTS.includes(cleanLoc);
    if ((isPureCity || isPureDistrict) && !hasStreetPattern(loc) && !hasMallPattern(loc)) {
      const hasDistrictKeyword = /\b(?:district|province|region|zone)\b/i.test(combined);
      const regionName = cleanLoc.charAt(0).toUpperCase() + cleanLoc.slice(1);
      if (hasDistrictKeyword || isKnownChainBrand(mName)) {
        return {
          scope: LocationScope.DISTRICT_REGION,
          region: regionName,
          venueIdentity: isKnownChainBrand(mName) ? 'MULTI_VENUE_CHAIN' : 'UNRESOLVED_VENUE',
          addressPrecision: 'CITY_OR_DISTRICT_ONLY',
          coordinateConfidence: 'NOT_GEOCODABLE',
          branchListCompleteness: 'INCOMPLETE_RESTRICTION',
          rawEvidence: loc,
          explanation: isKnownChainBrand(mName)
            ? `Restricted to ${regionName} area for chain merchant ${mName}. Specific branch outlet not specified.`
            : `Restricted to ${regionName} region. Specific street address not provided.`,
          isGeocodableToCoordinates: false,
          participatingBranchesCount: null,
          participatingBranches: [],
        };
      } else {
        return {
          scope: LocationScope.EXPLICIT_BRANCH,
          venueIdentity: 'SINGLE_CONCRETE_VENUE',
          addressPrecision: 'CITY_OR_DISTRICT_ONLY',
          coordinateConfidence: 'NOT_GEOCODABLE',
          branchListCompleteness: 'COMPLETE_BRANCH_LIST',
          rawEvidence: loc,
          explanation: `Single physical branch located in ${cleanLoc}. Exact street address not specified.`,
          isGeocodableToCoordinates: false,
          participatingBranchesCount: 1,
          participatingBranches: [loc],
        };
      }
    }
  }

  // 6. UNRESOLVED
  return {
    scope: LocationScope.UNRESOLVED,
    venueIdentity: 'UNRESOLVED_VENUE',
    addressPrecision: 'NO_ADDRESS',
    coordinateConfidence: 'NOT_GEOCODABLE',
    branchListCompleteness: 'INSUFFICIENT_EVIDENCE',
    rawEvidence: loc || title,
    explanation: 'Insufficient branch-level evidence in bank source.',
    isGeocodableToCoordinates: false,
    participatingBranchesCount: null,
    participatingBranches: [],
  };
}
