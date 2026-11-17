/**
 * NSB stores the address engine's first comma token as merchant.location.
 * Card brands and the offer title must never be that token. A real street
 * or town in the same text must still be returned. The parser guard stays.
 */
import { AddressEngine } from '@/parsing/address/address-engine';
import fixture from './fixtures/nsb-card-brand-locations.json';

const CARD_OR_TITLE = /^(?:mastercard|master\s*card|visa|credit|debit|all\s+cards?|cards?|both\s+debit)$/i;

function firstLocationToken(addresses: string[]): string | null {
  return addresses[0]?.split(',')[0]?.trim() ?? null;
}

/** Same predicate the NSB parser uses before it nulls location. */
function guardWouldClear(location: string | null, merchant: string, title: string): boolean {
  if (!location) return false;
  return (
    CARD_OR_TITLE.test(location) ||
    location.toLowerCase() === merchant.toLowerCase() ||
    location.toLowerCase() === title.toLowerCase()
  );
}

describe('NSB card-brand and title tokens are not locations', () => {
  const engine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });
  const merchant = fixture.kellyFelder.merchant;
  const title = fixture.kellyFelder.title;

  it('keeps the Kelly Felder branch list and does not lead with a card brand or the title', () => {
    const addresses = engine.extract(fixture.kellyFelder.text, merchant, title);
    expect(addresses).toEqual([
      'Colombo 03, Sri Lanka',
      'Nugegoda, Sri Lanka',
      'Colombo City Centre, Level 02, Sri Lanka',
      'Wattala, Sri Lanka',
    ]);
    const token = firstLocationToken(addresses);
    expect(token).toBe('Colombo 03');
    expect(guardWouldClear(token, merchant, title)).toBe(false);
  });

  it.each(fixture.cardBrandLabels)('does not emit %s', (text) => {
    const addresses = engine.extract(text, merchant, title);
    expect(addresses).toEqual([]);
    expect(guardWouldClear(firstLocationToken(addresses), merchant, title)).toBe(false);
  });

  it('drops a Visa list item and keeps the street address', () => {
    const addresses = engine.extract(fixture.streetBesideCardBrand, merchant, title);
    expect(addresses).toEqual(['No. 15, Galle Road, Colombo 03, Sri Lanka']);
    expect(guardWouldClear(firstLocationToken(addresses), merchant, title)).toBe(false);
  });

  it('strips a leading Mastercard token and keeps the street', () => {
    const addresses = engine.extract(fixture.streetAfterCardToken, merchant, title);
    expect(addresses).toEqual(['No. 10, Flower Road, Colombo 07, Sri Lanka']);
    expect(firstLocationToken(addresses)).toBe('No. 10');
  });

  it('strips a leading Credit token and keeps the towns', () => {
    const addresses = engine.extract(fixture.townsAfterCardToken, merchant, title);
    expect(addresses).toEqual(['Nugegoda, Sri Lanka', 'Maharagama, Sri Lanka']);
    expect(guardWouldClear(firstLocationToken(addresses), merchant, title)).toBe(false);
  });

  it('does not emit the offer title as a location', () => {
    const addresses = engine.extract(fixture.headline, merchant, title);
    expect(addresses).toEqual([]);
    const asTitle = engine.extract(`Location: ${title}`, merchant, title);
    expect(asTitle).toEqual([]);
    expect(guardWouldClear(firstLocationToken(asTitle), merchant, title)).toBe(false);
  });

  it('does not emit the merchant name alone as a location', () => {
    expect(engine.extract(`Location: ${merchant}`, merchant, title)).toEqual([]);
  });

  it('still extracts a prose street address that mentions a credit card', () => {
    const addresses = engine.extract(
      'Use your Credit card at No. 15, Galle Road, Colombo 03',
      merchant,
      title,
    );
    expect(addresses).toEqual(['No. 15, Galle Road, Colombo 03, Sri Lanka']);
  });
});
