import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * DFCC Geo Adapter
 *
 * DFCC offers have extracted addresses in `offer.merchant.addresses` via AddressEngine,
 * or a single locality in `offer.merchant.location`.
 * Multiple addresses reflect distinct outlets/branches.
 * Online categories/deals are filtered from false branch lookups.
 */
export class DFCCGeoAdapter implements IGeoAdapter {
  readonly bank = 'dfcc';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const rawLoc = (offer.merchant.location ?? '').trim();
    const addresses = offer.merchant.addresses ?? [];
    const isOnlineCategory = /online/i.test(offer.category ?? '');

    // Skip generic online markers or dummy dots
    const cleanLocation =
      rawLoc &&
      rawLoc !== '.' &&
      !rawLoc.startsWith('http') &&
      !/online/i.test(rawLoc) &&
      !/all\s+outlets/i.test(rawLoc)
        ? rawLoc
        : null;

    let candidateAddresses: string[] = [];
    if (!isOnlineCategory) {
      if (addresses.length > 0) {
        candidateAddresses = addresses.map((addr) =>
          addr.toLowerCase().includes(name.toLowerCase()) ? addr : `${name}, ${addr}`,
        );
      } else if (cleanLocation) {
        candidateAddresses.push(`${name}, ${cleanLocation}`);
      }
    }

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: null,
      location: cleanLocation,
      address: addresses[0] || null,
      addresses: candidateAddresses,
      branches: candidateAddresses.length > 1 ? candidateAddresses : [],
      phone: offer.merchant.phone.join(', ') || null,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
