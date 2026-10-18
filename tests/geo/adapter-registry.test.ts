import { getGeoAdapter } from '@/geo/adapter-registry';
import { Offer } from '@/core/types/offers';

// getGeoAdapter previously threw "No geo adapter registered" for nsb/combank
// even though their BANK_CONFIGS entries claim geocode:true — confirmed live
// 2026-08-01 when a geocode run crashed immediately on startup.
function sampleOffer(overrides: Partial<Offer['merchant']> = {}): Offer {
  return {
    uniqueId: 'x_1',
    source: 'x',
    sourceId: '1',
    sourceUrl: null,
    title: 'Test Offer',
    category: 'General',
    categoryId: null,
    cardType: '',
    scrapedAt: new Date().toISOString(),
    merchant: {
      name: 'Test Merchant',
      location: null,
      addresses: ['No 5, Galle Road, Colombo 03, Sri Lanka'],
      phone: [],
      email: [],
      website: null,
      logo: null,
      ...overrides,
    },
    offer: {
      description: 'desc',
      discountPercentage: 10,
      applicableCards: [],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [],
    contentHash: 'hash',
  };
}

describe('getGeoAdapter — every geocode:true bank has a registered adapter', () => {
  it('nsb resolves and extracts merchant.addresses directly', () => {
    const adapter = getGeoAdapter('nsb');
    const data = adapter.extractLocationData(sampleOffer());
    expect(data.addresses).toEqual(['No 5, Galle Road, Colombo 03, Sri Lanka']);
  });

  it('combank resolves and extracts merchant.addresses directly', () => {
    const adapter = getGeoAdapter('combank');
    const data = adapter.extractLocationData(sampleOffer());
    expect(data.addresses).toEqual(['No 5, Galle Road, Colombo 03, Sri Lanka']);
  });

  it('multiple addresses are treated as distinct branches', () => {
    const adapter = getGeoAdapter('nsb');
    const data = adapter.extractLocationData(sampleOffer({
      addresses: ['Branch A, Colombo, Sri Lanka', 'Branch B, Kandy, Sri Lanka'],
    }));
    expect(data.branches).toHaveLength(2);
  });

  it('falls back to merchant name when no addresses exist', () => {
    const adapter = getGeoAdapter('combank');
    const data = adapter.extractLocationData(sampleOffer({ addresses: [] }));
    expect(data.addresses).toEqual(['Test Merchant']);
  });

  it('dfcc adapter resolves and extracts addresses or falls back to clean location', () => {
    const adapter = getGeoAdapter('dfcc');
    const data = adapter.extractLocationData(sampleOffer());
    expect(data.addresses).toEqual(['Test Merchant, No 5, Galle Road, Colombo 03, Sri Lanka']);

    const singleLoc = adapter.extractLocationData(sampleOffer({ addresses: [], location: 'Kollupitiya' }));
    expect(singleLoc.addresses).toEqual(['Test Merchant, Kollupitiya']);
  });

  it('pabc adapter resolves and extracts addresses or falls back to clean location', () => {
    const adapter = getGeoAdapter('pabc');
    const data = adapter.extractLocationData(sampleOffer());
    expect(data.addresses).toEqual(['Test Merchant, No 5, Galle Road, Colombo 03, Sri Lanka']);

    const singleLoc = adapter.extractLocationData(sampleOffer({ addresses: [], location: 'Kandy' }));
    expect(singleLoc.addresses).toEqual(['Test Merchant, Kandy']);
  });

  it('registers all 10 production banks for geocoding', () => {
    const allBanks = ['hnb', 'sampath', 'boc', 'peoples', 'seylan', 'ndb', 'nsb', 'combank', 'dfcc', 'pabc'];
    for (const bank of allBanks) {
      const adapter = getGeoAdapter(bank);
      expect(adapter).toBeDefined();
      expect(adapter.bank).toBe(bank);
    }
  });
});

