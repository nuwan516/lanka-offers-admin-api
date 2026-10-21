import { classify } from '@/parsing/geo/branch-classifier';
import { LocationType, LocationData } from '@/core/types/geo';
import { SeylanGeoAdapter } from '@/geo/adapters/seylan-geo-adapter';
import { SampathGeoAdapter } from '@/geo/adapters/sampath-geo-adapter';
import { determineLocationScope, LocationScope } from '@/domain/location-scope';
import { Offer } from '@/core/types/offers';

function mockOffer(overrides: {
  merchant?: Partial<Offer['merchant']>;
  description?: string;
  uniqueId?: string;
} = {}): Offer {
  return {
    uniqueId: overrides.uniqueId ?? 'offer_1',
    source: 'test',
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
      addresses: [],
      phone: [],
      email: [],
      website: null,
      logo: null,
      ...overrides.merchant,
    },
    offer: {
      description: overrides.description ?? 'desc',
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

function mockLocData(overrides: Partial<LocationData> = {}): LocationData {
  return {
    offerId: 'offer_1',
    merchantName: 'Test Merchant',
    city: null,
    location: null,
    address: null,
    addresses: [],
    branches: [],
    phone: null,
    promotionDetails: null,
    ...overrides,
  };
}

describe('Address Pipeline Regressions (Classifier, Adapters, Location Scope)', () => {
  // ─── Bug 7: branch-classifier regexes word boundaries ──────────────────────
  describe('Bug 7: branch-classifier word boundaries on ONLINE and ALL_OUTLETS', () => {
    it('does not classify "Tuberose Hotel" as ONLINE', () => {
      const res = classify(mockLocData({
        merchantName: 'Tuberose Hotel',
        address: 'No 1, Beach Rd, Bentota',
      }));
      expect(res.type).not.toBe(LocationType.ONLINE);
      expect(res.type).toBe(LocationType.SINGLE);
    });

    it('does not classify "Kuberan Restaurant" as ONLINE', () => {
      const res = classify(mockLocData({
        merchantName: 'Kuberan Restaurant',
        address: 'No 10, Station Rd, Jaffna',
      }));
      expect(res.type).not.toBe(LocationType.ONLINE);
      expect(res.type).toBe(LocationType.SINGLE);
    });

    it('still classifies actual online merchants as ONLINE', () => {
      expect(classify(mockLocData({ merchantName: 'Uber' })).type).toBe(LocationType.ONLINE);
      expect(classify(mockLocData({ merchantName: 'Uber Eats' })).type).toBe(LocationType.ONLINE);
      expect(classify(mockLocData({ merchantName: 'Daraz' })).type).toBe(LocationType.ONLINE);
      expect(classify(mockLocData({ merchantName: 'PickMe Food' })).type).toBe(LocationType.ONLINE);
    });

    it('does not match "Mall Outlet" with ALL_OUTLETS_PATTERN', () => {
      const res = classify(mockLocData({
        merchantName: 'Local Cafe',
        location: 'Mall Outlet',
      }));
      // In the old code, ALL_OUTLETS_PATTERN matched "Mall Outlet" and set chainQuery to "Local Cafe Sri Lanka"
      expect(res.chainQuery).not.toBe('Local Cafe Sri Lanka');
    });

    it('still gives chainQuery "<merchant> Sri Lanka" for real "All Outlets"', () => {
      const res = classify(mockLocData({
        merchantName: 'Local Burger',
        location: 'All Outlets',
      }));
      expect(res.type).toBe(LocationType.CHAIN);
      expect(res.chainQuery).toBe('Local Burger Sri Lanka');
    });
  });

  // ─── Bug 8: Town-only addresses preserve merchant in Places query ──────────
  describe('Bug 8: Town-only addresses include merchant in Places chainQuery', () => {
    it('prepends merchantName to town-only address query', () => {
      const res = classify(mockLocData({
        merchantName: 'The Blue Water Hotel',
        addresses: ['Wadduwa, Sri Lanka'],
      }));
      expect(res.type).toBe(LocationType.CHAIN);
      expect(res.chainQuery).toBe('The Blue Water Hotel, Wadduwa, Sri Lanka');
    });

    it('does not repeat merchantName if the query already contains it', () => {
      const res = classify(mockLocData({
        merchantName: 'The Blue Water Hotel',
        addresses: ['The Blue Water Hotel, Wadduwa, Sri Lanka'],
      }));
      expect(res.type).toBe(LocationType.CHAIN);
      expect(res.chainQuery).toBe('The Blue Water Hotel, Wadduwa, Sri Lanka');
    });

    it('treats known cities ("Mirissa") as SINGLE geocoding queries', () => {
      const res = classify(mockLocData({
        merchantName: 'Surf Camp',
        addresses: ['Mirissa, Sri Lanka'],
      }));
      expect(res.type).toBe(LocationType.SINGLE);
      expect(res.addresses).toEqual(['Mirissa, Sri Lanka']);
    });

    it('treats street addresses as SINGLE geocoding queries', () => {
      const res = classify(mockLocData({
        merchantName: 'Surf Camp',
        addresses: ['No. 12, Beach Road, Mirissa, Sri Lanka'],
      }));
      expect(res.type).toBe(LocationType.SINGLE);
      expect(res.addresses).toEqual(['No. 12, Beach Road, Mirissa, Sri Lanka']);
    });
  });

  // ─── Bug 9: seylan-geo-adapter reads all addresses ─────────────────────────
  describe('Bug 9: SeylanGeoAdapter reads and formats all merchant.addresses', () => {
    const adapter = new SeylanGeoAdapter();

    it('geocodes every extracted branch "<name>, <addr>" for each non-empty address', () => {
      const offer = mockOffer({
        merchant: {
          name: 'Keells Super',
          addresses: [
            'No 1, Galle Road, Colombo 03',
            'No 45, Kandy Road, Kadawatha',
            'Main Street, Negombo',
          ],
        },
      });

      const data = adapter.extractLocationData(offer);
      expect(data.addresses).toEqual([
        'Keells Super, No 1, Galle Road, Colombo 03',
        'Keells Super, No 45, Kandy Road, Kadawatha',
        'Keells Super, Main Street, Negombo',
      ]);
    });
  });

  // ─── Bug 10: sampath-geo-adapter city deduplication & concatenation split ───
  describe('Bug 10: SampathGeoAdapter city handling & conditional branch split', () => {
    const adapter = new SampathGeoAdapter();

    it('appends city only once when parser already adds it', () => {
      const offer = mockOffer({
        merchant: {
          name: 'Partner',
          location: 'Colombo 03',
          addresses: ['No 5, Galle Road, Colombo 03'],
        },
      });

      const data = adapter.extractLocationData(offer);
      expect(data.addresses).toEqual(['No 5, Galle Road, Colombo 03']);
    });

    it('inserts city before ", Sri Lanka" for engine-extracted addresses', () => {
      const offer = mockOffer({
        merchant: {
          name: 'Partner',
          location: 'Colombo 03',
          addresses: ['No 5, Galle Road, Sri Lanka'],
        },
      });

      const data = adapter.extractLocationData(offer);
      expect(data.addresses).toEqual(['No 5, Galle Road, Colombo 03, Sri Lanka']);
    });

    it('does not split "McDonald\'s" address into branches when length > 60', () => {
      const offer = mockOffer({
        merchant: {
          name: "McDonald's",
          location: 'Colombo 03',
          addresses: ["McDonald's, No 123, Galle Road, Kollupitiya, Colombo 03, Western Province"],
        },
      });

      const data = adapter.extractLocationData(offer);
      expect(data.branches).toEqual([]);
      expect(data.addresses[0]).toContain("McDonald's");
    });

    it('splits concatenated branches when it yields more than 1 branch', () => {
      const offer = mockOffer({
        merchant: {
          name: 'Resorts',
          location: null,
          addresses: ['Solar Crab, PamunugamaThe Walden, Nuwara Eliya, Central Province, Sri Lanka'],
        },
      });

      const data = adapter.extractLocationData(offer);
      expect(data.branches).toEqual([
        'Solar Crab, Pamunugama',
        'The Walden, Nuwara Eliya, Central Province, Sri Lanka',
      ]);
    });
  });

  // ─── Bug 11: determineLocationScope description punctuation ───────────────
  describe('Bug 11: determineLocationScope free-text description punctuation', () => {
    it('does NOT treat " / " or ";" in description as MULTIPLE_BRANCHES', () => {
      const res = determineLocationScope({
        description: 'Enjoy 20% off. Valid Monday / Tuesday; terms apply',
      });
      expect(res.scope).not.toBe(LocationScope.MULTIPLE_BRANCHES);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });

    it('still counts multiple branches when description explicitly names several branches', () => {
      const res = determineLocationScope({
        description: 'Valid at Colombo 03 branch and Kandy branch.',
      });
      expect(res.scope).toBe(LocationScope.MULTIPLE_BRANCHES);
      expect(res.isGeocodableToCoordinates).toBe(true);
    });

    it('still recognizes " / " and ";" in location as MULTIPLE_BRANCHES', () => {
      const resSlash = determineLocationScope({
        location: 'Colombo 03 / Kandy',
      });
      expect(resSlash.scope).toBe(LocationScope.MULTIPLE_BRANCHES);

      const resSemi = determineLocationScope({
        location: 'Branch A; Branch B',
      });
      expect(resSemi.scope).toBe(LocationScope.MULTIPLE_BRANCHES);
    });
  });
});
