import { assessAddressQuality } from '@/geo/address-quality';

describe('Address Quality Assessment', () => {
  it('correctly classifies EXACT_ADDRESS with street number and road', () => {
    const result = assessAddressQuality({
      candidateAddresses: ['No. 20, Beach Road, Colombo 03, Sri Lanka'],
      merchantName: 'Hotel Blue',
    });

    expect(result.quality).toBe('EXACT_ADDRESS');
    expect(result.confidence).toBe('HIGH');
    expect(result.isGeocodableToExactPin).toBe(true);
    expect(result.needsLlmValidation).toBe(false);
  });

  it('correctly classifies BRANCH_OR_VENUE_NAME without street number', () => {
    const result = assessAddressQuality({
      candidateAddresses: ['Courtyard by Marriott Colombo, Sri Lanka'],
      merchantName: 'Courtyard by Marriott',
    });

    expect(result.quality).toBe('BRANCH_OR_VENUE_NAME');
    expect(result.confidence).toBe('MEDIUM');
    expect(result.isGeocodableToExactPin).toBe(false);
    expect(result.needsLlmValidation).toBe(true);
  });

  it('correctly classifies AREA_ONLY for bare cities/districts and prohibits exact pin', () => {
    const result = assessAddressQuality({
      candidateAddresses: ['Panadura, Sri Lanka'],
      merchantName: 'Fashion Center',
    });

    expect(result.quality).toBe('AREA_ONLY');
    expect(result.confidence).toBe('HIGH');
    expect(result.isGeocodableToExactPin).toBe(false);
    expect(result.needsLlmValidation).toBe(false);
  });

  it('correctly classifies ONLINE_ONLY and does not geocode', () => {
    const result = assessAddressQuality({
      candidateAddresses: [],
      rawLocation: 'https://www.ubereats.com',
      merchantName: 'Uber Eats',
      rawText: 'Order via the Uber Eats app with promo code EATS20',
    });

    expect(result.quality).toBe('ONLINE_ONLY');
    expect(result.isGeocodableToExactPin).toBe(false);
    expect(result.needsLlmValidation).toBe(false);
  });

  it('correctly identifies INVALID candidates with card terms or boilerplate', () => {
    const result = assessAddressQuality({
      candidateAddresses: [
        'Both Debit and Credit Cards',
        'General terms & conditions apply',
        'Offer valid at :',
      ],
      merchantName: 'Sample Merchant',
    });

    expect(result.quality).toBe('INVALID');
    expect(result.isGeocodableToExactPin).toBe(false);
    expect(result.needsLlmValidation).toBe(true);
    expect(result.invalidPatternsMatched.length).toBeGreaterThanOrEqual(3);
  });

  it('correctly flags AMBIGUOUS when fragmented or conflicting tokens exist', () => {
    const result = assessAddressQuality({
      candidateAddresses: ['Floor 2', 'Selected Outlets'],
      merchantName: 'Mall Store',
    });

    expect(result.quality === 'AMBIGUOUS' || result.quality === 'INVALID').toBe(true);
    expect(result.needsLlmValidation).toBe(true);
  });
});
