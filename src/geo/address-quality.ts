/**
 * Lanka Offers — Address Quality Classification & Assessment
 *
 * Provides deterministic classification of address candidates and location strings:
 * - EXACT_ADDRESS: Street-level detail (number, road, postal zone)
 * - BRANCH_OR_VENUE_NAME: Named business/hotel/outlet without street address
 * - AREA_ONLY: Bare city, town, or district reference (NO exact pin permitted)
 * - ONLINE_ONLY: Digital, e-commerce, delivery app, website promo
 * - INVALID: Boilerplate terms, card tiers, emails, phone-only, or garbage
 * - AMBIGUOUS: Conflicting or fragmented address tokens requiring validation
 */

import { SRI_LANKAN_CITIES } from '@/core/constants/cities';
import { SRI_LANKA_DISTRICTS } from '@/core/constants/sri-lanka-geo-catalog';

export type AddressQuality =
  | 'EXACT_ADDRESS'
  | 'BRANCH_OR_VENUE_NAME'
  | 'AREA_ONLY'
  | 'ONLINE_ONLY'
  | 'INVALID'
  | 'AMBIGUOUS';

export interface AddressQualityAssessment {
  quality: AddressQuality;
  score: number; // 0.0 to 1.0
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  needsLlmValidation: boolean;
  reasons: string[];
  invalidPatternsMatched: string[];
  cleanAddresses: string[];
  isGeocodableToExactPin: boolean;
}

// ─── Regex Rules ───────────────────────────────────────────────────────────────

const INVALID_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:both\s+)?(?:debit|credit)\s+cards?\b/i, reason: 'Card product description' },
  { pattern: /\b(?:visa|mastercard|amex)\b.*\b(?:cards?|holders?)\b/i, reason: 'Card network eligibility' },
  { pattern: /\bgeneral\s+terms\s*(?:and|&)\s*conditions\b/i, reason: 'Terms and conditions boilerplate' },
  { pattern: /\boffer\s+valid\s+at\s*:\s*$/i, reason: 'Dangling offer valid marker' },
  { pattern: /\bterms\s+apply\b/i, reason: 'Generic terms statement' },
  { pattern: /\bmaximum\s+discount\b/i, reason: 'Discount restriction' },
  { pattern: /\bminimum\s+bill\b/i, reason: 'Bill restriction' },
  { pattern: /\bvalid\s+(?:till|until|from)\b/i, reason: 'Validity date snippet' },
  { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, reason: 'Email address only' },
  { pattern: /^(?:\+?94|0)\s*(?:\d[\s-]?){8,10}$/, reason: 'Phone number only' },
  { pattern: /^https?:\/\/\S+$/i, reason: 'Standalone URL' },
  { pattern: /^[.,\-_/\\:;\s]+$/, reason: 'Punctuation only' },
  { pattern: /^\s*(?:selected|participating)\s+(?:outlets?|branches?|stores?)\s*$/i, reason: 'Selected outlets restriction placeholder' },
];

const ONLINE_PATTERNS = [
  /\b(?:uber\s*eats|pickme(?:\s*food)?|daraz|food\s*panda|kapruka|glomark\.lk|buyabans\.com)\b/i,
  /\bonline\s+only\b/i,
  /\bvalid\s+(?:only\s+)?(?:for\s+)?online\b/i,
  /\bwebsite\s+only\b/i,
  /\bapp\s+only\b/i,
  /\bvia\s+(?:the\s+)?(?:website|app|mobile\s+app)\b/i,
  /\bdownload\s+(?:the\s+)?(?:mobile\s+)?app\b/i,
  /\bpromo\s*code\b/i,
  /\buse\s+(?:promo\s+)?code\b/i,
  /\be-?commerce\b/i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}\b/i,
];

const STREET_OR_NUMBER_PATTERNS = [
  /\bNo\.?\s*\d+/i,
  /\b\d+[A-Z]?\s*[,/]\s*[A-Za-z]/i,
  /\b\d+\s*,\s*[A-Za-z]/,
  /\b[A-Za-z]+\s+(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St)\b/i,
  /\bColombo\s+(?:0?[1-9]|1[0-5])\b/i,
  /\b\d{5}\b/, // Sri Lankan postal code
];

const VENUE_PATTERNS = [
  /\b(?:Hotel|Resort|Villas?|Suites?|Inn|Lodge|Boutique)\b/i,
  /\b(?:Courtyard|Marriott|Cinnamon|Hilton|Shangri-La|Jetwing|Heritance|Amaya|Radisson)\b/i,
  /\b(?:Restaurant|Café|Cafe|Bakery|Bistro|Lounge|Pub|Bar)\b/i,
  /\b(?:Showroom|Outlet|Arcade|Plaza|Mall|Centre|Center|Complex|Tower)\b/i,
];

/**
 * Clean an individual address string of trailing noise, punctuation, and markers.
 */
export function sanitizeAddressString(addr: string): string {
  let cleaned = addr.trim();
  // Strip common leading markers
  cleaned = cleaned.replace(/^(?:address|location|branch|outlets?|venue|visit\s+us\s+at|find\s+us\s+at)\s*:\s*/i, '');
  // Strip trailing punctuation
  cleaned = cleaned.replace(/[,;.\s]+$/, '').trim();
  return cleaned;
}

/**
 * Assesses the quality of an address candidate or set of address candidates.
 */
export function assessAddressQuality(input: {
  candidateAddresses?: string[];
  rawLocation?: string;
  merchantName?: string;
  rawText?: string;
}): AddressQualityAssessment {
  const merchant = (input.merchantName ?? '').trim();
  const rawLocation = (input.rawLocation ?? '').trim();
  const candidates = (input.candidateAddresses ?? [])
    .map(sanitizeAddressString)
    .filter((a) => a.length > 0);

  const matchedInvalid: string[] = [];
  const reasons: string[] = [];

  // Check candidate validity
  const validCandidates: string[] = [];
  for (const c of candidates) {
    let isInvalid = false;
    for (const rule of INVALID_PATTERNS) {
      if (rule.pattern.test(c)) {
        matchedInvalid.push(`"${c.slice(0, 40)}" matched ${rule.reason}`);
        isInvalid = true;
        break;
      }
    }
    if (!isInvalid) {
      validCandidates.push(c);
    }
  }

  // 1. Check ONLINE_ONLY
  const combinedContext = [merchant, rawLocation, ...validCandidates, input.rawText ?? ''].join(' ');
  const isOnline = ONLINE_PATTERNS.some((p) => p.test(combinedContext)) ||
    rawLocation.startsWith('http') ||
    merchant.startsWith('www.') ||
    /\.(?:lk|com|net|org)\b/i.test(merchant);

  const hasPhysicalVenue =
    VENUE_PATTERNS.some((p) => p.test(combinedContext)) ||
    /\b(?:Hotel|Resort|Villas?|Suites?|Inn|Lodge|Boutique|Estate|Spa|Wellness|Clinics?|Hospital|Ayurveda)\b/i.test(combinedContext);

  if (isOnline && validCandidates.length === 0 && !hasPhysicalVenue) {
    return {
      quality: 'ONLINE_ONLY',
      score: 0.95,
      confidence: 'HIGH',
      needsLlmValidation: false,
      reasons: ['Merchant or promotion context matches online-only indicators'],
      invalidPatternsMatched: matchedInvalid,
      cleanAddresses: [],
      isGeocodableToExactPin: false,
    };
  }

  // 2. Check if all candidates were INVALID or empty
  if (validCandidates.length === 0) {
    if (matchedInvalid.length > 0) {
      return {
        quality: 'INVALID',
        score: 0.1,
        confidence: 'HIGH',
        needsLlmValidation: true,
        reasons: matchedInvalid,
        invalidPatternsMatched: matchedInvalid,
        cleanAddresses: [],
        isGeocodableToExactPin: false,
      };
    }
    return {
      quality: 'INVALID',
      score: 0.0,
      confidence: 'HIGH',
      needsLlmValidation: true,
      reasons: ['No address candidates provided or extracted'],
      invalidPatternsMatched: [],
      cleanAddresses: [],
      isGeocodableToExactPin: false,
    };
  }

  // 3. Evaluate each valid candidate
  let hasExactStreet = false;
  let hasVenue = false;
  let hasAreaOnly = false;
  let hasAmbiguity = false;

  for (const addr of validCandidates) {
    const withoutCountry = addr.replace(/,\s*Sri\s+Lanka\s*$/i, '').trim();

    // Check street or postal number
    const isStreet = STREET_OR_NUMBER_PATTERNS.some((p) => p.test(withoutCountry));
    if (isStreet) {
      hasExactStreet = true;
      continue;
    }

    // Check venue
    const isVenue = VENUE_PATTERNS.some((p) => p.test(withoutCountry));
    if (isVenue) {
      hasVenue = true;
      continue;
    }

    // Check if it's purely city or district
    const districtNames = SRI_LANKA_DISTRICTS.map((d) => d.name.toLowerCase());
    const parts = withoutCountry.split(',').map((p) => p.trim().toLowerCase());
    const isPureCity = parts.length > 0 && parts.every((p) =>
      SRI_LANKAN_CITIES.includes(p) || districtNames.includes(p)
    );

    if (isPureCity) {
      hasAreaOnly = true;
      continue;
    }

    // If none of the above, it's ambiguous
    hasAmbiguity = true;
  }

  // Determine overall quality
  if (hasExactStreet) {
    const confidence = hasAmbiguity ? 'MEDIUM' : 'HIGH';
    return {
      quality: 'EXACT_ADDRESS',
      score: hasAmbiguity ? 0.8 : 0.95,
      confidence,
      needsLlmValidation: hasAmbiguity,
      reasons: ['Contains street number, road name, or postal zone'],
      invalidPatternsMatched: matchedInvalid,
      cleanAddresses: validCandidates,
      isGeocodableToExactPin: true,
    };
  }

  if (hasVenue && !hasAmbiguity) {
    return {
      quality: 'BRANCH_OR_VENUE_NAME',
      score: 0.75,
      confidence: 'MEDIUM',
      needsLlmValidation: true, // Needs Places/venue verification
      reasons: ['Contains hotel, restaurant, or venue name without full street details'],
      invalidPatternsMatched: matchedInvalid,
      cleanAddresses: validCandidates,
      isGeocodableToExactPin: false, // Must be verified by venue search before exact pin
    };
  }

  if (hasAreaOnly && !hasAmbiguity) {
    return {
      quality: 'AREA_ONLY',
      score: 0.7,
      confidence: 'HIGH',
      needsLlmValidation: false, // Area-only is clear; do not invent a pin
      reasons: ['Contains only city or district names (no street or venue specified)'],
      invalidPatternsMatched: matchedInvalid,
      cleanAddresses: validCandidates,
      isGeocodableToExactPin: false, // Strictly NO exact pin for area-only
    };
  }

  return {
    quality: 'AMBIGUOUS',
    score: 0.4,
    confidence: 'LOW',
    needsLlmValidation: true,
    reasons: ['Extracted address does not clearly match street, venue, or pure locality'],
    invalidPatternsMatched: matchedInvalid,
    cleanAddresses: validCandidates,
    isGeocodableToExactPin: false,
  };
}
