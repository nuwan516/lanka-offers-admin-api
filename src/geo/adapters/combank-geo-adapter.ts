import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * ComBank Geo Adapter
 *
 * ComBank has no structured address field either — combank-parser.ts
 * already runs AddressEngine over the offer-specific detail sections, so
 * `merchant.addresses` is the already-cleaned source (DHL/NCG-style table
 * rows and " / "-separated branch lists both become multiple entries
 * upstream). Multiple addresses mean distinct branches.
 */
export class ComBankGeoAdapter implements IGeoAdapter {
  readonly bank = 'combank';

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
