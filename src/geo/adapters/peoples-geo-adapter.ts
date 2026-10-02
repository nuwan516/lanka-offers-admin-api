import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';
import { extractCityFromName } from '@/parsing/geo/branch-parser';

/**
 * People's Bank Geo Adapter
 *
 * People's Bank stores location as "Venue Name - City" or "Venue Name City".
 * This adapter parses the dash-separated pattern to extract venue + city.
 */
export class PeoplesGeoAdapter implements IGeoAdapter {
  readonly bank = 'peoples';

  extractLocationData(offer: Offer): LocationData {
    const name = offer.merchant.name ?? '';
    const rawLocation = offer.merchant.location ?? '';
    const addresses: string[] = [];

    const parsed = extractCityFromName(rawLocation);
    if (parsed) {
      addresses.push(`${parsed.name}, ${parsed.city}`);
    } else if (rawLocation) {
      addresses.push(rawLocation);
    } else if (name) {
      addresses.push(name);
    }

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: parsed?.city ?? null,
      location: rawLocation || null,
      address: null,
      addresses,
      branches: [],
      phone: offer.merchant.phone.join(', ') || null,
      promotionDetails: offer.offer.description ?? null,
    };
  }
}
