import { GeocodingVerifier } from '@/geo/geocoding-verifier';
import { GeoResult } from '@/core/types/geo';
import { LocationScope } from '@/domain/location-scope';

describe('Coordinate & Geocoding Verifier', () => {
  it('approves verified exact premise pins within Sri Lanka', () => {
    const geoResult: GeoResult = {
      success: true,
      searchAddress: 'No. 20, Beach Road, Colombo, Sri Lanka',
      formattedAddress: '20 Beach Rd, Colombo 00300, Sri Lanka',
      latitude: 6.9012,
      longitude: 79.8524,
      types: ['street_address', 'premise'],
      timestamp: new Date().toISOString(),
      source: 'geocoding_api',
    };

    const verification = GeocodingVerifier.verifyResult(
      geoResult,
      'No. 20, Beach Road, Colombo, Sri Lanka',
      'EXACT_ADDRESS',
      LocationScope.EXPLICIT_BRANCH
    );

    expect(verification.isVerifiedExactPin).toBe(true);
    expect(verification.isVerifiedAreaCentroid).toBe(false);
    expect(verification.granularity).toBe('EXACT_PREMISE');
    expect(verification.confidenceScore).toBeGreaterThanOrEqual(0.7);
  });

  it('rejects coordinates outside Sri Lanka bounds', () => {
    const geoResult: GeoResult = {
      success: true,
      searchAddress: 'Fake Street',
      formattedAddress: 'Some Street, India',
      latitude: 18.5204, // India!
      longitude: 73.8567,
      types: ['street_address'],
      timestamp: new Date().toISOString(),
      source: 'geocoding_api',
    };

    const verification = GeocodingVerifier.verifyResult(
      geoResult,
      'Fake Street',
      'EXACT_ADDRESS',
      LocationScope.EXPLICIT_BRANCH
    );

    expect(verification.isVerifiedExactPin).toBe(false);
    expect(verification.rejectionReason).toContain('outside Sri Lanka bounds');
  });

  it('rejects nationwide country-level centroid results', () => {
    const geoResult: GeoResult = {
      success: true,
      searchAddress: 'Unresolved Venue',
      formattedAddress: 'Sri Lanka',
      latitude: 7.8731,
      longitude: 80.7718,
      types: ['country', 'political'],
      timestamp: new Date().toISOString(),
      source: 'geocoding_api',
    };

    const verification = GeocodingVerifier.verifyResult(
      geoResult,
      'Unresolved Venue',
      'BRANCH_OR_VENUE_NAME',
      LocationScope.EXPLICIT_BRANCH
    );

    expect(verification.isVerifiedExactPin).toBe(false);
    expect(verification.granularity).toBe('COUNTRY_CENTROID');
    expect(verification.rejectionReason).toContain('country centroid only');
  });

  it('prevents exact pins for AREA_ONLY scopes, retaining them as area centroids only', () => {
    const geoResult: GeoResult = {
      success: true,
      searchAddress: 'Panadura, Sri Lanka',
      formattedAddress: 'Panadura, Sri Lanka',
      latitude: 6.7132,
      longitude: 79.9074,
      types: ['locality', 'political'],
      timestamp: new Date().toISOString(),
      source: 'geocoding_api',
    };

    const verification = GeocodingVerifier.verifyResult(
      geoResult,
      'Panadura, Sri Lanka',
      'AREA_ONLY',
      LocationScope.DISTRICT_REGION
    );

    expect(verification.isVerifiedExactPin).toBe(false);
    expect(verification.isVerifiedAreaCentroid).toBe(true);
    expect(verification.granularity).toBe('AREA_CENTROID');
  });

  it('detects branch collisions when multiple addresses map to the exact same pin', () => {
    const results = [
      {
        address: 'Branch Alpha, Main Street',
        verification: {
          isVerifiedExactPin: true,
          isVerifiedAreaCentroid: false,
          latitude: 6.9271,
          longitude: 79.8612,
          formattedAddress: 'Colombo, Sri Lanka',
          granularity: 'EXACT_PREMISE' as const,
          confidenceScore: 0.8,
        },
      },
      {
        address: 'Branch Beta, Galle Road',
        verification: {
          isVerifiedExactPin: true,
          isVerifiedAreaCentroid: false,
          latitude: 6.9271,
          longitude: 79.8612,
          formattedAddress: 'Colombo, Sri Lanka',
          granularity: 'EXACT_PREMISE' as const,
          confidenceScore: 0.8,
        },
      },
    ];

    const warnings = GeocodingVerifier.detectBranchCollisions(results);
    expect(warnings.length).toBe(2);
    expect(warnings[0].warning).toContain('Collapsed into same coordinates');
  });
});
