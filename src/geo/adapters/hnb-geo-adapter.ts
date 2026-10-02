import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * HNB Geo Adapter
 *
 * HNB offers store address data in `merchant.addresses[]`.
 * These addresses sometimes contain promotional prefixes like:
 *   "15% off on HB and FB basis at Amagi Beach Marawila, Sri Lanka"
 * This adapter strips those prefixes to return clean geocodable addresses.
 */
export class HNBGeoAdapter implements IGeoAdapter {
  readonly bank = 'hnb';

  extractLocationData(offer: Offer): LocationData {
    const m = offer.merchant;
    const name = m.name ?? '';
    const rawAddresses = m.addresses ?? [];
    const phone = m.phone.join(', ') || null;

    const addresses: string[] = [];
    for (const rawAddr of rawAddresses) {
      let cleaned = rawAddr;

      // Strip promo prefix: "15% off ... at <venue>"
      const atMatch = cleaned.match(/\bat\s+(.+)/i);
      if (atMatch) cleaned = atMatch[1];

      // Remove trailing ", Sri Lanka" (re-added by geocoder)
      cleaned = cleaned.replace(/,\s*Sri\s*Lanka\s*$/i, '').trim();
      if (cleaned) addresses.push(cleaned);
    }

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: m.location,
      address: null,
      addresses,
      branches: [],
      phone,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
