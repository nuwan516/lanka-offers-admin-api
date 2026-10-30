/**
 * Lanka Offers — Branch-Level Participation & Verification Model
 *
 * Implements Section 2 & 3 of the Geospatial Architecture:
 * - Each participating branch carries its own evidence, participation status, and coordinate status.
 * - Prevents blanket offer-level suppression: source-verified branches under SELECTED_OUTLETS
 *   can be displayed while unknown or unlisted chain branches remain hidden.
 * - Preserves zero-fabrication invariant: unknown branches are never invented.
 */

import { LocationScope } from './location-scope';
import { SRI_LANKAN_CITIES } from '@/core/constants/cities';

export type ParticipationStatus =
  | 'SOURCE_VERIFIED'  // Explicitly enumerated or confirmed participating in bank source
  | 'UNCONFIRMED'      // Known merchant branch, but unconfirmed for this specific promo
  | 'EXCLUDED';        // Explicitly excluded by promotion terms

export type CoordinateStatus =
  | 'VERIFIED'         // High-confidence, verified physical premises coordinates
  | 'CANDIDATE'        // Preliminary geocoded coordinates awaiting verification
  | 'UNRESOLVED';      // No verified coordinates available (e.g. city-only or geocoding failed)

export interface BranchCoordinateProvenance {
  provider: 'google' | 'osm' | 'cache' | 'manual_verified';
  retrievedAt: string;
  granularity: 'EXACT_PREMISE' | 'STREET_LEVEL' | 'AREA_CENTROID' | 'COUNTRY_CENTROID' | 'INVALID';
  confidenceScore: number;
  matchedVenueName: string | null;
  formattedAddress: string | null;
  rejectionReason?: string;
}

export interface ParticipatingBranch {
  merchantId: string;
  branchName: string | null;
  sourceAddress: string | null;
  city: string | null;
  district: string | null;
  participationEvidenceIds: string[];
  participationStatus: ParticipationStatus;
  coordinateStatus: CoordinateStatus;
  latitude?: number | null;
  longitude?: number | null;
  provenance?: BranchCoordinateProvenance | null;
}

export interface BranchExtractionInput {
  merchantName?: string | null;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  addresses?: string[];
  generalTerms?: string[];
  restrictions?: string[];
  rawHtml?: string | null;
  locationScope?: LocationScope | string;
}

// Common Sri Lankan Districts
const SRI_LANKAN_DISTRICTS = [
  'Colombo', 'Gampaha', 'Kalutara', 'Kandy', 'Matale', 'Nuwara Eliya',
  'Galle', 'Matara', 'Hambantota', 'Jaffna', 'Kilinochchi', 'Mannar',
  'Vavuniya', 'Mullaitivu', 'Batticaloa', 'Ampara', 'Trincomalee',
  'Kurunegala', 'Puttalam', 'Anuradhapura', 'Polonnaruwa', 'Badulla',
  'Monaragala', 'Ratnapura', 'Kegalle',
];

export class BranchParticipationService {
  /**
   * Extracts source-verified participating branches from an offer's raw evidence.
   * Strictly respects source boundaries: never invents branches not found in evidence.
   */
  static extractParticipatingBranches(input: BranchExtractionInput): ParticipatingBranch[] {
    const branches: ParticipatingBranch[] = [];
    const merchantId = (input.merchantName ?? 'unknown-merchant').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const combinedTerms = [
      input.description ?? '',
      ...(input.generalTerms ?? []),
      ...(input.restrictions ?? []),
    ].join('\n');

    // 1. Check for numbered or bulleted branch lists in terms/rawHtml (e.g. AMANTE, ODEL, Cool Planet, Spa Ceylon, Barista, etc.)
    const listPattern = /(?:valid\s+(?:exclusively\s+)?at\s+(?:the\s+)?(?:below|following)\s+[^:\n]*(?:outlets?|showrooms?|boutiques?|cafes?|branches?|stores?|mansions?|centres?|centers?|locations?|restaurants?|supermarkets?)(?:\s+only)?|participating\s+[^:\n]*(?:outlets?|showrooms?|boutiques?|cafes?|branches?|stores?|locations?|supermarkets?)(?:\s+only)?)\s*[:\n]\s*((?:(?:[0-9]{1,2}[.)]|[-•*])\s*[^\n]+(?:\n|$))+)/i;
    const listMatch = (combinedTerms + '\n' + (input.rawHtml ?? '')).match(listPattern);

    if (listMatch && listMatch[1]) {
      const rawLines = listMatch[1].split('\n');
      const items: string[] = [];
      for (const line of rawLines) {
        const inlineParts = line.split(/(?=[0-9]{1,2}[.)]\s*)/).map((p) => p.trim()).filter((p) => p.length > 0);
        for (const part of inlineParts) {
          const cleaned = part
            .replace(/^(?:[0-9]{1,2}[.)]|[-•*])\s*/, '')
            .replace(/[;,]\s*$/, '')
            .trim();
          if (cleaned.length > 3 && !/^(?:general|terms|validity|offer\s+valid)/i.test(cleaned)) {
            items.push(cleaned);
          }
        }
      }

      for (const item of items) {
        const detectedCity = this.detectCity(item);
        const detectedDistrict = this.detectDistrict(item) || detectedCity;
        branches.push({
          merchantId,
          branchName: this.extractCleanBranchName(item, input.merchantName),
          sourceAddress: item,
          city: detectedCity,
          district: detectedDistrict,
          participationEvidenceIds: ['selected_outlet_list_evidence'],
          participationStatus: this.isOutletExplicitlyExcluded(item, combinedTerms) ? 'EXCLUDED' : 'SOURCE_VERIFIED',
          coordinateStatus: 'UNRESOLVED', // Awaits coordinate verification pipeline
        });
      }
    }

    // 2. Check for HTML table branch entries in rawHtml
    if (branches.length === 0 && input.rawHtml && /<table[^>]*>[\s\S]*?<\/table>/i.test(input.rawHtml)) {
      const rowMatches = input.rawHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
      for (const match of rowMatches) {
        const cells = Array.from(match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
          .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
          .filter((text) => text.length > 2);
        if (cells.length >= 1) {
          const rowText = cells.join(', ');
          if (!/^(?:branch|outlet|location|no|address)/i.test(cells[0])) {
            const detectedCity = this.detectCity(rowText);
            const detectedDistrict = this.detectDistrict(rowText) || detectedCity;
            branches.push({
              merchantId,
              branchName: this.extractCleanBranchName(cells[0], input.merchantName),
              sourceAddress: rowText,
              city: detectedCity,
              district: detectedDistrict,
              participationEvidenceIds: ['html_table_outlet_row'],
              participationStatus: 'SOURCE_VERIFIED',
              coordinateStatus: 'UNRESOLVED',
            });
          }
        }
      }
    }

    // 3. If explicit addresses array is provided
    if (branches.length === 0 && input.addresses && input.addresses.length > 0) {
      for (const addr of input.addresses) {
        if (!addr || addr.length < 3) continue;
        const detectedCity = this.detectCity(addr);
        const detectedDistrict = this.detectDistrict(addr) || detectedCity;
        branches.push({
          merchantId,
          branchName: this.extractCleanBranchName(addr, input.merchantName),
          sourceAddress: addr,
          city: detectedCity,
          district: detectedDistrict,
          participationEvidenceIds: ['scraped_addresses_array'],
          participationStatus: this.isOutletExplicitlyExcluded(addr, combinedTerms) ? 'EXCLUDED' : 'SOURCE_VERIFIED',
          coordinateStatus: 'UNRESOLVED',
        });
      }
    }

    // 4. If delimited branches exist in location field (e.g. "Kandy ; Galle ; Colombo")
    if (branches.length === 0 && input.location && (input.location.includes(';') || (input.location.includes(' / ') && !input.location.includes('http')))) {
      const tokens = input.location.split(/[;/]/).map((t) => t.trim()).filter((t) => t.length > 2);
      if (tokens.length > 1) {
        for (const token of tokens) {
          const detectedCity = this.detectCity(token);
          const detectedDistrict = this.detectDistrict(token) || detectedCity;
          branches.push({
            merchantId,
            branchName: this.extractCleanBranchName(token, input.merchantName),
            sourceAddress: token,
            city: detectedCity,
            district: detectedDistrict,
            participationEvidenceIds: ['delimited_location_field'],
            participationStatus: this.isOutletExplicitlyExcluded(token, combinedTerms) ? 'EXCLUDED' : 'SOURCE_VERIFIED',
            coordinateStatus: 'UNRESOLVED',
          });
        }
      }
    }

    // 5. Single concrete venue or physical location (reject pure city names to prevent false single-branch assumptions)
    if (branches.length === 0 && input.location && input.location.trim().length > 3) {
      const loc = input.location.trim();
      const cleanLoc = loc.toLowerCase().replace(/,?\s*sri\s*lanka\s*$/i, '').trim();
      const isPureCity = SRI_LANKAN_CITIES.some((c) => c.toLowerCase() === cleanLoc);
      const isAreaScope = /\b(?:district|region|province|islandwide|all\s+island|area)\b/i.test(loc);
      if (!isPureCity && !isAreaScope) {
        const detectedCity = this.detectCity(loc);
        const detectedDistrict = this.detectDistrict(loc) || detectedCity;
        branches.push({
          merchantId,
          branchName: this.extractCleanBranchName(loc, input.merchantName),
          sourceAddress: loc,
          city: detectedCity,
          district: detectedDistrict,
          participationEvidenceIds: ['single_location_field'],
          participationStatus: this.isOutletExplicitlyExcluded(loc, combinedTerms) ? 'EXCLUDED' : 'SOURCE_VERIFIED',
          coordinateStatus: 'UNRESOLVED',
        });
      }
    }

    return branches;
  }

  /**
   * Detects whether an outlet or venue is explicitly marked as excluded in terms.
   */
  private static isOutletExplicitlyExcluded(branchText: string, termsText: string): boolean {
    const lowerBranch = branchText.toLowerCase();
    const lowerTerms = termsText.toLowerCase();
    // Negative exclusion checks
    if (lowerBranch.includes('airport') || lowerBranch.includes('katunayake') || lowerBranch.includes('bia')) {
      if (/(?:excluding|except|not\s+valid\s+at)\s+[^.\n]*(?:airport|katunayake|bia)/i.test(lowerTerms)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cleans branch name by removing repetitive merchant name prefixes or formatting noise.
   */
  private static extractCleanBranchName(addressOrName: string, merchantName?: string | null): string {
    let name = addressOrName.replace(/<[^>]+>/g, '').trim();
    if (merchantName) {
      const cleanMerchant = merchantName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const cleanAddress = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const regex = new RegExp(`^${cleanMerchant}\\s*[,:-]?\\s*`, 'i');
      if (regex.test(cleanAddress)) {
        name = cleanAddress.replace(regex, '');
      }
    }
    return name.slice(0, 100).trim();
  }

  private static detectCity(text: string): string | null {
    const lower = text.toLowerCase();
    for (const city of SRI_LANKAN_CITIES) {
      const pat = new RegExp(`\\b${city}\\b`, 'i');
      if (pat.test(lower)) {
        return city.charAt(0).toUpperCase() + city.slice(1);
      }
    }
    return null;
  }

  private static detectDistrict(text: string): string | null {
    const lower = text.toLowerCase();
    for (const dist of SRI_LANKAN_DISTRICTS) {
      const pat = new RegExp(`\\b${dist}\\b`, 'i');
      if (pat.test(lower)) {
        return dist;
      }
    }
    return null;
  }

  /**
   * Converts verified ParticipatingBranch records to backend-api geo_locations format.
   * Only branches with verified coordinates and verified participation receive map pins.
   */
  static toGeoLocationsJson(branches: ParticipatingBranch[]): any[] {
    return branches
      .filter((b) => b.participationStatus === 'SOURCE_VERIFIED' && b.coordinateStatus === 'VERIFIED' && b.latitude != null && b.longitude != null)
      .map((b) => ({
        name: b.branchName,
        address: b.sourceAddress,
        city: b.city,
        district: b.district,
        lat: b.latitude,
        lng: b.longitude,
        participation_status: b.participationStatus,
        coordinate_status: b.coordinateStatus,
        confidence: b.provenance?.confidenceScore ?? 0.9,
      }));
  }
}
