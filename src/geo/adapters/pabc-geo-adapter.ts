import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';

/**
 * Pan Asia Bank (PABC) Geo Adapter
 *
 * PABC offers extract addresses from promotion descriptions via AddressEngine into `merchant.addresses`.
 * Single locality references sit in `merchant.location`.
 * Hotel promotions typically cite exact destination cities/resorts.
 */
export class PABCGeoAdapter implements IGeoAdapter {
  readonly bank = 'pabc';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const rawLoc = (offer.merchant.location ?? '').trim();
    const addresses = offer.merchant.addresses ?? [];
    const isOnlineCategory = /online/i.test(offer.category ?? '');

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
