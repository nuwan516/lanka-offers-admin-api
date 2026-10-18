/**
 * Lanka Offers — Sri Lankan Address Normalizer & Geospatial Disambiguator
 *
 * Implements strict rules for local Sri Lankan addresses:
 * - Recognizes Colombo postal zones (Colombo 03 <-> Kollupitiya / Colpetty).
 * - Distinguishes exact physical branches from approximate city-level references.
 * - Handles Sinhala, Tamil, and English place names and road abbreviations.
 * - Never invents false precision or treats city centroids as exact branch locations.
 */

import {
  COLOMBO_POSTAL_ZONES,
  SRI_LANKA_DISTRICTS,
  findColomboPostalZone,
  findCommercialHub,
  ColomboPostalZone,
  LocationEntry,
} from '@/core/constants/sri-lanka-geo-catalog';

export type GeoPrecision = 'EXACT_BRANCH' | 'APPROXIMATE_CITY' | 'DISTRICT' | 'UNRESOLVED';

export interface NormalizedSriLankanLocation {
  rawAddress: string;
  normalizedAddress: string;
  district: string | null;
  province: string | null;
  city: string | null;
  postalZone: string | null;
  landmarkOrMall: string | null;
  precision: GeoPrecision;
  confidence: number; // 0.0 to 1.0
  isJunction: boolean;
  warnings: string[];
}

const ROAD_EXPANSIONS: Record<string, string> = {
  'rd': 'Road',
  'rd.': 'Road',
  'st': 'Street',
  'st.': 'Street',
  'mw': 'Mawatha',
  'mw.': 'Mawatha',
  'ave': 'Avenue',
  'ave.': 'Avenue',
  'ln': 'Lane',
  'ln.': 'Lane',
  'jct': 'Junction',
  'jct.': 'Junction',
  'junc': 'Junction',
  'junc.': 'Junction',
  'cbo': 'Colombo',
  'kdy': 'Kandy',
};

const EXACT_BRANCH_INDICATORS = [
  /\bNo\.?\s*\d+/i,
  /\b\d+[A-Z]?\s*[,/]\s*[A-Za-z]/i,
  /\b\d+\s*,\s*[A-Za-z]/i,
  /\b(?:Floor|Level)\s*\d+/i,
  /\b\d+(?:st|nd|rd|th)\s+(?:Floor|Level|Lane)/i,
  /\b(?:Mall|Complex|Tower|Plaza|Centre|Center|Arcade|Square|Showroom|Outlet|Branch)\b/i,
];

/**
 * Normalizes Sri Lankan address strings into canonical, structured location records.
 */
export function normalizeSriLankanAddress(raw: string | null | undefined): NormalizedSriLankanLocation {
  const original = (raw ?? '').trim();
  const warnings: string[] = [];

  if (!original) {
    return {
      rawAddress: '',
      normalizedAddress: '',
      district: null,
      province: null,
      city: null,
      postalZone: null,
      landmarkOrMall: null,
      precision: 'UNRESOLVED',
      confidence: 0.0,
      isJunction: false,
      warnings: ['Empty address provided'],
    };
  }

  let cleaned = original
    .replace(/\s+/g, ' ')
    .replace(/^No\.?\s*/i, 'No. ')
    .replace(/\s*,\s*/g, ', ')
    .trim();

  // 1. Expand common street / road abbreviations safely at word boundaries
  cleaned = cleaned.replace(/\b([A-Za-z.]+)\b/g, (match) => {
    const lower = match.toLowerCase();
    return ROAD_EXPANSIONS[lower] ?? match;
  });

  // 2. Identify Colombo Postal Zones (e.g. "Colombo 03", "Colpetty", "Kollupitiya")
  const pz: ColomboPostalZone | null = findColomboPostalZone(cleaned);
  let district: string | null = pz ? 'Colombo' : null;
  let province: string | null = pz ? 'Western' : null;
  let city: string | null = pz ? pz.primaryName : null;
  const postalZone: string | null = pz ? pz.zone : null;

  // 3. Identify Commercial Hubs, Towns & Malls
  const hub: LocationEntry | null = findCommercialHub(cleaned);
  let landmarkOrMall: string | null = null;
  const isJunction =
    /\b(?:junction|jct|junc)\b/i.test(cleaned) ||
    /හන්දිය|සන්ධිය/.test(cleaned);

  if (hub) {
    district = district ?? hub.district;
    province = province ?? hub.province;
    if (!city) {
      city = hub.canonicalName;
    }
    if (hub.isMall) {
      landmarkOrMall = hub.canonicalName;
    }
  }

  // 4. District reference search if not yet resolved
  if (!district) {
    for (const d of SRI_LANKA_DISTRICTS) {
      if (new RegExp(`\\b${d.name}\\b`, 'i').test(cleaned) || cleaned.includes(d.sinhala) || cleaned.includes(d.tamil)) {
        district = d.name;
        province = d.province;
        if (!city) city = d.capital;
        break;
      }
    }
  }

  // 5. Determine precision: EXACT_BRANCH vs APPROXIMATE_CITY vs DISTRICT
  let precision: GeoPrecision = 'UNRESOLVED';
  let confidence = 0.5;

  const hasExactMarker = EXACT_BRANCH_INDICATORS.some((pat) => pat.test(cleaned));
  if (hasExactMarker || (hub?.isMall && cleaned.length > 5)) {
    precision = 'EXACT_BRANCH';
    confidence = 0.95;
  } else if (pz) {
    // A specific Colombo postal zone (e.g. Colombo 03 / Kollupitiya) without a street number
    precision = 'APPROXIMATE_CITY';
    confidence = 0.85;
  } else if (city && city.toLowerCase() !== district?.toLowerCase()) {
    // Known city or town
    precision = 'APPROXIMATE_CITY';
    confidence = 0.8;
  } else if (district) {
    precision = 'DISTRICT';
    confidence = 0.6;
    warnings.push(`Address only specifies district level: ${district}`);
  } else {
    precision = 'UNRESOLVED';
    confidence = 0.2;
    warnings.push('Could not establish administrative district or city for address');
  }

  // 6. Build canonical normalized address string
  const parts: string[] = [];
  // Preserve street portion if present
  const streetPart = cleaned
    .replace(/,\s*Sri\s+Lanka\.?$/i, '')
    .replace(new RegExp(`,?\\s*${district ?? ''}$`, 'i'), '')
    .trim();

  if (streetPart && precision === 'EXACT_BRANCH') {
    parts.push(streetPart);
  } else if (city) {
    if (postalZone && district === 'Colombo') {
      parts.push(`${city} (${postalZone})`);
    } else {
      parts.push(city);
    }
  }

  if (district && !parts.some((p) => p.includes(district!))) {
    parts.push(district);
  }

  parts.push('Sri Lanka');
  const normalizedAddress = parts.join(', ');

  return {
    rawAddress: original,
    normalizedAddress,
    district,
    province,
    city,
    postalZone,
    landmarkOrMall,
    precision,
    confidence,
    isJunction,
    warnings,
  };
}
