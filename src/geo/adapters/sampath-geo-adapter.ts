import { Offer } from '@/core/types/offers';
import { LocationData } from '@/core/types/geo';
import { IGeoAdapter } from './geo-adapter.interface';
import { parseConcatenatedBranches, parseOutletList } from '@/parsing/geo/branch-parser';
import { stripHtml } from '@/parsing/text/html';

/**
 * Sampath Geo Adapter
 *
 * Sampath offers encode address data in `eligible_cards[]`:
 *   [0] = partner name
 *   [1] = address or second name
 * Also checks `promotion_details` for "Participating Outlets" branch lists.
 * Concatenated multi-branch strings are detected and split automatically.
 */
export class SampathGeoAdapter implements IGeoAdapter {
  readonly bank = 'sampath';

  extractLocationData(offer: Offer): LocationData {
    const name = stripHtml(offer.merchant.name ?? '');
    const city = offer.merchant.location ?? '';

    // Extract address from eligible_cards[1] (raw text in the old format)
    // In the new Offer shape, we look at merchant.addresses[0] as the raw addr
    const rawAddr = (offer.merchant.addresses[0] ?? '').trim();
    let address = this.looksLikeAddress(rawAddr) ? rawAddr : '';
    let branches: string[] = [];

    // Detect concatenated multi-branch: "Solar Crab, PamunugamaThe Walden, Nuwara Eliya"
    if (address && address.length > 60 && /[a-z][A-Z]/.test(address)) {
      const splitBranches = parseConcatenatedBranches(address);
      if (splitBranches.length > 1) {
        branches = splitBranches;
        address = '';
      }
    }

    // Check offer description for "Participating Outlets: ..."
    const details = offer.offer.description ?? '';
    if (!branches.length && details) {
      const outletMatch = details.match(
        /participating\s+(?:outlets?|restaurants?)\s*[-–:]\s*([^*]+)/i,
      );
      if (outletMatch) {
        branches = parseOutletList(outletMatch[0], name);
      }
    }

    if (!branches.length && offer.merchant.addresses.length > 1) {
      branches = offer.merchant.addresses;
    }

    // Build final addresses array
    const addresses: string[] = [];
    if (branches.length === 0) {
      if (address) {
        addresses.push(this.appendCityIfMissing(address, city));
      } else if (city) {
        addresses.push(`${name}, ${city}`);
      }
    }

    return {
      offerId: offer.uniqueId,
      merchantName: name,
      city: city || null,
      location: '',
      address: address || null,
      addresses,
      branches,
      phone: offer.merchant.phone.join(', ') || null,
      promotionDetails: details || null,
    };
  }

  private appendCityIfMissing(address: string, city: string): string {
    let cleaned = address.replace(/,\s*([A-Za-z]+)\s*,\s*\1\s*$/i, ', $1');
    if (!city || !city.trim()) return cleaned;
    const c = city.trim();
    if (cleaned.toLowerCase().includes(c.toLowerCase())) {
      return cleaned;
    }
    if (/,\s*Sri\s+Lanka\s*$/i.test(cleaned)) {
      return cleaned.replace(/,\s*Sri\s+Lanka\s*$/i, `, ${c}, Sri Lanka`);
    }
    return `${cleaned}, ${c}`;
  }

  private looksLikeAddress(text: string): boolean {
    if (!text || text.length < 5) return false;
    if (/^\d{1,2}\w*\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text)) return false;
    if (/^valid\s/i.test(text)) return false;
    if (text.startsWith('http') || text.startsWith('www.')) return false;
    if (/^sampath|^for all|^visa|^mastercard/i.test(text)) return false;
    return true;
  }
}
