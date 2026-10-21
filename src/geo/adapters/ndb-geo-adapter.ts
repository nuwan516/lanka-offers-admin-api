import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * NDB Geo Adapter
 *
 * NDB offers store location in `merchant.location`:
 *  - "All Outlets"  → 17/55 offers (CHAIN)
 *  - "Colombo 02"   → city name (SINGLE)
 *  - "http://..."   → URL (ONLINE)
 *  - "."            → useless dot (NONE)
 * This adapter skips URLs/dots/"All Outlets" for direct geocoding.
 */
export class NDBGeoAdapter implements IGeoAdapter {
  readonly bank = 'ndb';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const location = (offer.merchant.location ?? '').trim();
    const phone = offer.merchant.phone.join(', ') || null;

    const rawAddresses = (offer.merchant.addresses ?? []).filter(
      (a) => a && a.trim() && a !== '.' && !a.startsWith('http') && !/all\s+outlets/i.test(a)
    );

    const addresses: string[] = [];
    if (rawAddresses.length > 0) {
      for (const addr of rawAddresses) {
        addresses.push(addr.toLowerCase().includes(name.toLowerCase()) ? addr : `${name}, ${addr}`);
      }
    } else if (
      location &&
      location !== '.' &&
      !location.startsWith('http') &&
      !/all\s+outlets/i.test(location)
    ) {
      addresses.push(`${name}, ${location}`);
    }

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: location || null,
      address: addresses[0] || null,
      addresses,
      branches: addresses.length > 1 ? addresses : [],
      phone,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
