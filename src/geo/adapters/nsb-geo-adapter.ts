import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * NSB Geo Adapter
 *
 * NSB has no structured address field — nsb-parser.ts already runs
 * AddressEngine over the free-text body, so `merchant.addresses` is the
 * already-cleaned source (pipe-delimited multi-branch lists become
 * multiple entries; named-property-as-location and city-only mentions are
 * both handled upstream). Multiple addresses mean distinct branches.
 */
export class NSBGeoAdapter implements IGeoAdapter {
  readonly bank = 'nsb';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const addresses = offer.merchant.addresses ?? [];

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: offer.merchant.location ?? null,
      address: null,
      addresses: addresses.length > 0 ? addresses : name ? [name] : [],
      branches: addresses.length > 1 ? addresses : [],
      phone: offer.merchant.phone.join(', ') || null,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
