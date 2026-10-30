/**
 * Lanka Offers — Coordinate & Geocoding Verifier
 *
 * Implements Section 10 of the Intelligent Address Validation Pipeline.
 * Performs rigorous deterministic verification on geocoded results before allowing
 * exact map pin publication:
 * - Bounds verification (within Sri Lanka)
 * - Country / Town centroid rejection (never show a town centroid as an exact branch pin)
 * - Area-only protection (never invent exact pins for AREA_ONLY or UNRESOLVED scopes)
 * - Token & component consistency checks between query and geocoded formatted_address
 * - Branch collision detection (collapsing multiple distinct branches into 1 pin)
 */

import { GeoResult } from '@/core/types/geo';
import { AddressQuality } from '@/geo/address-quality';
import { LocationScope } from '@/domain/location-scope';

export interface CoordinateVerificationResult {
  isVerifiedExactPin: boolean;
  isVerifiedAreaCentroid: boolean;
  latitude: number | null;
  longitude: number | null;
  formattedAddress: string | null;
  rejectionReason?: string;
  granularity: 'EXACT_PREMISE' | 'STREET_LEVEL' | 'AREA_CENTROID' | 'COUNTRY_CENTROID' | 'INVALID';
  confidenceScore: number; // 0.0 to 1.0
}

const SRI_LANKA_BOUNDS = {
  minLat: 5.9,
  maxLat: 10.0,
  minLng: 79.5,
  maxLng: 82.0,
};

// Generic town/area types that represent centroids rather than physical merchant venues
const AREA_CENTROID_TYPES = new Set([
  'locality',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality',
  'postal_code',
]);

// Exact premise / establishment types
const EXACT_VENUE_TYPES = new Set([
  'street_address',
  'premise',
  'subpremise',
  'point_of_interest',
  'establishment',
  'lodging',
  'restaurant',
  'food',
  'store',
]);

export class GeocodingVerifier {
  /**
   * Checks if latitude and longitude coordinates fall strictly inside Sri Lanka.
   */
  static isInSriLanka(lat: number, lng: number): boolean {
    return (
      lat >= SRI_LANKA_BOUNDS.minLat &&
      lat <= SRI_LANKA_BOUNDS.maxLat &&
      lng >= SRI_LANKA_BOUNDS.minLng &&
      lng <= SRI_LANKA_BOUNDS.maxLng
    );
  }

  /**
   * Verifies a Geocoder result against the requested address, address quality, and location scope.
   */
  static verifyResult(
    geoResult: GeoResult | null | undefined,
    queryAddress: string,
    quality: AddressQuality,
    scope: LocationScope
  ): CoordinateVerificationResult {
    if (!geoResult || !geoResult.success || geoResult.latitude == null || geoResult.longitude == null) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: false,
        latitude: null,
        longitude: null,
        formattedAddress: null,
        rejectionReason: geoResult?.message ?? 'No successful geocoding result',
        granularity: 'INVALID',
        confidenceScore: 0.0,
      };
    }

    const { latitude: lat, longitude: lng, formattedAddress = '', types = [] } = geoResult;

    // 1. Sri Lanka bounds check
    if (!this.isInSriLanka(lat, lng)) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: false,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: `Coordinates (${lat}, ${lng}) outside Sri Lanka bounds`,
        granularity: 'INVALID',
        confidenceScore: 0.0,
      };
    }

    // 2. Country-level centroid check
    const isCountry = types.includes('country') || (Math.abs(lat - 7.8731) < 0.05 && Math.abs(lng - 80.7718) < 0.05);
    if (isCountry) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: false,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: 'Resolved to nationwide/country centroid only',
        granularity: 'COUNTRY_CENTROID',
        confidenceScore: 0.1,
      };
    }

    // 3. Area-only and digital restriction: AREA_ONLY and ONLINE never receive an exact map pin
    // Note: Both SELECTED_OUTLETS and NATIONWIDE allow exact pins when the specific branch has verified physical premises coordinates.
    if (quality === 'AREA_ONLY' || quality === 'ONLINE_ONLY' || quality === 'INVALID' ||
        scope === LocationScope.ONLINE) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: true,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: `Exact pin prohibited for quality=${quality} scope=${scope}`,
        granularity: 'AREA_CENTROID',
        confidenceScore: 0.5,
      };
    }

    // 3b. Corporate headquarters rejection:
    // If the query is for a specific branch outlet, but geocoder resolved to corporate/head office
    const isCorporateHqResult = /\b(?:head\s*office|corporate\s*office|registered\s*office|group\s*headquarters)\b/i.test(formattedAddress);
    const isQuerySpecificOutlet = !/\b(?:head\s*office|corporate\s*office)\b/i.test(queryAddress);
    if (isCorporateHqResult && isQuerySpecificOutlet) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: false,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: 'Rejected corporate headquarters coordinates for branch query',
        granularity: 'INVALID',
        confidenceScore: 0.2,
      };
    }

    // 4. Check granularity types
    const hasExactType = types.some((t) => EXACT_VENUE_TYPES.has(t));
    const isPureArea = types.length > 0 && types.every((t) => AREA_CENTROID_TYPES.has(t) || t === 'political');

    if (isPureArea) {
      // Query was supposed to be an exact address or venue, but Google only resolved a city/area centroid
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: true,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: 'Address query resolved only to generic area/locality centroid, not exact premise',
        granularity: 'AREA_CENTROID',
        confidenceScore: 0.6,
      };
    }

    // 5. Query-to-formatted address token consistency check
    const queryTokens = queryAddress
      .toLowerCase()
      .replace(/sri\s+lanka/g, '')
      .split(/[\s,]+/)
      .filter((t) => t.length >= 4);

    const formattedLower = formattedAddress.toLowerCase();
    const matchedTokens = queryTokens.filter((t) => formattedLower.includes(t));
    const tokenMatchRatio = queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 1.0;

    if (tokenMatchRatio < 0.3) {
      return {
        isVerifiedExactPin: false,
        isVerifiedAreaCentroid: false,
        latitude: lat,
        longitude: lng,
        formattedAddress,
        rejectionReason: `Low textual consistency between query ("${queryAddress.slice(0, 30)}") and result ("${formattedAddress.slice(0, 30)}")`,
        granularity: hasExactType ? 'EXACT_PREMISE' : 'STREET_LEVEL',
        confidenceScore: 0.4,
      };
    }

    const isExactPremise = hasExactType;
    return {
      isVerifiedExactPin: isExactPremise,
      isVerifiedAreaCentroid: false,
      latitude: lat,
      longitude: lng,
      formattedAddress,
      granularity: isExactPremise ? 'EXACT_PREMISE' : 'STREET_LEVEL',
      confidenceScore: Math.min(0.95, 0.7 + tokenMatchRatio * 0.25),
      rejectionReason: isExactPremise
        ? undefined
        : 'Uncertain street-level result only; exact premise verification requires premise or establishment type',
    };
  }

  /**
   * Detects branch collisions (e.g. multiple distinct addresses returning identical coordinates).
   */
  static detectBranchCollisions(
    results: Array<{ address: string; verification: CoordinateVerificationResult }>
  ): Array<{ address: string; warning: string }> {
    const warnings: Array<{ address: string; warning: string }> = [];
    const coordMap = new Map<string, string[]>();

    for (const r of results) {
      if (!r.verification.latitude || !r.verification.longitude) continue;
      const key = `${r.verification.latitude.toFixed(4)},${r.verification.longitude.toFixed(4)}`;
      const list = coordMap.get(key) ?? [];
      list.push(r.address);
      coordMap.set(key, list);
    }

    for (const [key, addresses] of coordMap.entries()) {
      if (addresses.length > 1) {
        for (const addr of addresses) {
          warnings.push({
            address: addr,
            warning: `Collapsed into same coordinates (${key}) as ${addresses.length - 1} other branch(es)`,
          });
        }
      }
    }

    return warnings;
  }
}
