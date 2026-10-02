import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';

/**
 * Contract for bank-specific geo adapters.
 *
 * Each adapter knows how to extract normalized LocationData from that bank's
 * Offer shape. The GeoEngine calls extractLocationData() for each offer, then
 * passes the result to the branch classifier and geocoder.
 */
export interface IGeoAdapter {
  /** The bank name this adapter handles, e.g. 'hnb' */
  readonly bank: string;

  /**
   * Extract normalized location data from a bank's Offer.
   * Must be a pure function — no I/O or API calls.
   */
  extractLocationData(offer: Offer): LocationData;
}
