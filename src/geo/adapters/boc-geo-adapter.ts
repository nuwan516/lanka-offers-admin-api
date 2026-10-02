import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * BOC Geo Adapter
 *
 * BOC offers store location as `merchant.location` (venue name only, e.g. "Centauria Hill Resort").
 * There are no full street addresses; the geocoder will use the merchant name + location
 * or fall back to known-chains for chain merchants.
 */
export class BOCGeoAdapter implements IGeoAdapter {
  readonly bank = 'boc';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const location = offer.merchant.location ?? '';

    const addresses: string[] = location
      ? [location]
      : name
      ? [name]
      : [];

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: location || null,
      address: null,
      addresses,
      branches: [],
      phone: offer.merchant.phone.join(', ') || null,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
