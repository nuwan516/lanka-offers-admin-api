import { classify } from '@/parsing/geo/branch-classifier';
import { LocationType } from '@/core/types/geo';
import type { LocationData } from '@/core/types/geo';

const base = (): LocationData => ({
  offerId: 'test_001',
  merchantName: 'Test Merchant',
  city: null,
  location: null,
  address: null,
  addresses: [],
  branches: [],
  phone: null,
  promotionDetails: null,
});

describe('classify()', () => {
  // ── SINGLE ────────────────────────────────────────────────────────────────

  describe('SINGLE', () => {
    it('returns SINGLE when addresses[] has exactly one entry', () => {
      const result = classify({ ...base(), addresses: ['Colombo 03, Sri Lanka'] });
      expect(result.type).toBe(LocationType.SINGLE);
      expect(result.addresses).toHaveLength(1);
    });

    it('returns SINGLE when address + city can be combined', () => {
      const result = classify({ ...base(), address: '35 D.R. Wijewardena Mawatha', city: 'Colombo 10' });
      expect(result.type).toBe(LocationType.SINGLE);
      expect(result.addresses[0]).toContain('Colombo 10');
    });

    it('routes merchant name + city (no street address) to Places Text Search', () => {
      // Geocoding API resolves business-name queries to the country centroid;
      // Places Text Search is the API that understands venue names.
      const result = classify({ ...base(), merchantName: 'The Wallawwa', city: 'Ja-Ela' });
      expect(result.type).toBe(LocationType.CHAIN);
      expect(result.chainQuery).toContain('The Wallawwa');
    });
  });

  // ── LISTED ────────────────────────────────────────────────────────────────

  describe('LISTED', () => {
    it('returns LISTED when addresses[] has multiple entries', () => {
      const result = classify({ ...base(), addresses: ['Branch A, Colombo', 'Branch B, Kandy'] });
      expect(result.type).toBe(LocationType.LISTED);
      expect(result.addresses).toHaveLength(2);
    });

    it('returns LISTED when branches[] has multiple entries', () => {
      const result = classify({ ...base(), branches: ['Rajagiriya', 'Wellawatte', 'Dehiwala'] });
      expect(result.type).toBe(LocationType.LISTED);
      expect(result.addresses).toHaveLength(3);
    });
  });

  // ── CHAIN ─────────────────────────────────────────────────────────────────

  describe('CHAIN', () => {
    it('returns CHAIN for known chain merchant with no specific address', () => {
      const result = classify({ ...base(), merchantName: 'SPAR Supermarket' });
      expect(result.type).toBe(LocationType.CHAIN);
      expect(result.chainQuery).toContain('SPAR');
    });

    it('returns CHAIN for "All Outlets" location pattern', () => {
      const result = classify({ ...base(), merchantName: 'Cargills Food City', location: 'All Outlets Island Wide' });
      expect(result.type).toBe(LocationType.CHAIN);
      expect(result.chainQuery).not.toBeNull();
    });

    it('returns CHAIN for known chain case-insensitively', () => {
      const result = classify({ ...base(), merchantName: 'KEELLS FOOD CITY - RAJAGIRIYA' });
      expect(result.type).toBe(LocationType.CHAIN);
    });

    it('does NOT return CHAIN when specific address is provided', () => {
      const result = classify({
        ...base(),
        merchantName: 'KFC',
        address: '42 Galle Rd, Kollupitiya',
        city: 'Colombo 03',
      });
      expect(result.type).not.toBe(LocationType.CHAIN);
    });
  });

  // ── ONLINE ────────────────────────────────────────────────────────────────

  describe('ONLINE', () => {
    it('returns ONLINE for URL location', () => {
      const result = classify({ ...base(), location: 'https://www.daraz.lk' });
      expect(result.type).toBe(LocationType.ONLINE);
    });

    it('returns ONLINE for known online merchant name', () => {
      const result = classify({ ...base(), merchantName: 'Daraz Online Shopping' });
      expect(result.type).toBe(LocationType.ONLINE);
    });

    it('returns ONLINE for Uber', () => {
      const result = classify({ ...base(), merchantName: 'Uber Eats' });
      expect(result.type).toBe(LocationType.ONLINE);
    });
  });

  // ── NONE ──────────────────────────────────────────────────────────────────

  describe('NONE', () => {
    it('returns NONE when all location fields are empty', () => {
      const result = classify({ ...base(), merchantName: '', city: null, address: null });
      expect(result.type).toBe(LocationType.NONE);
    });

    it('returns NONE for dot-only location', () => {
      const result = classify({ ...base(), merchantName: '', location: '.' });
      expect(result.type).toBe(LocationType.NONE);
    });
  });
});
