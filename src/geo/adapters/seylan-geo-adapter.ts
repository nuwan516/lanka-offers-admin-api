import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * Seylan Geo Adapter
 *
 * Seylan offers store full street addresses in `merchant.addresses[0]` (~28/86 offers).
 * Chain merchants (SPAR, Cargills, etc.) have empty addresses — the classifier will
 * pick those up via known-chains matching.
 */
export class SeylanGeoAdapter implements IGeoAdapter {
  readonly bank = 'seylan';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const address = offer.merchant.addresses[0] ?? '';
    const phone = offer.merchant.phone.join(', ') || null;

    const addresses: string[] = [];
    if (address) {
      // Combine merchant name + address for a better geocoding query
      addresses.push(`${name}, ${address}`);
    }
    // If no address, branch-classifier will check known-chains or use name

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: null,
      address: address || null,
      addresses,
      branches: [],
      phone,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
