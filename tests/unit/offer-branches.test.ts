import { extractBranchPoints } from '../../src/infrastructure/db/offer-branches';

describe('extractBranchPoints', () => {
  it('accepts public API lat/lng shape', () => {
    const points = extractBranchPoints([
      { name: 'Keells Fort', address: 'Chatham St', lat: 6.934, lng: 79.845, confidence: 0.9 },
    ]);
    expect(points).toEqual([
      {
        branchName: 'Keells Fort',
        branchAddress: 'Chatham St',
        lat: 6.934,
        lng: 79.845,
        confidence: 0.9,
      },
    ]);
  });

  it('accepts admin GeoLocation latitude/longitude shape', () => {
    const points = extractBranchPoints([
      {
        branchName: 'Waters Edge',
        formattedAddress: 'Battaramulla',
        latitude: 6.8988,
        longitude: 79.9167,
        source: 'geocoding_api',
      },
    ]);
    expect(points[0].lat).toBe(6.8988);
    expect(points[0].lng).toBe(79.9167);
    expect(points[0].branchName).toBe('Waters Edge');
    expect(points[0].branchAddress).toBe('Battaramulla');
  });

  it('does not turn an unconfirmed or rejected hit into a branch', () => {
    expect(
      extractBranchPoints([
        { latitude: 6.91, longitude: 79.85, confirmed: false, success: true },
        { latitude: 6.92, longitude: 79.86, success: false },
        { lat: 6.93, lng: 79.87, coordinate_status: 'UNVERIFIED' },
        { lat: 6.94, lng: 79.88, participation_status: 'UNCONFIRMED' },
        { lat: 7.8731, lng: 80.7718 },
        { lat: 19.07, lng: 72.87 },
      ])
    ).toEqual([]);
  });

  it('keeps a confirmed Sri Lankan premise', () => {
    const points = extractBranchPoints([
      {
        name: 'Racecourse',
        address: 'Colombo 07',
        lat: 6.9044,
        lng: 79.8654,
        confirmed: true,
        coordinate_status: 'VERIFIED',
        participation_status: 'SOURCE_VERIFIED',
        types: ['premise', 'establishment'],
      },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].lat).toBe(6.9044);
  });

  it('skips malformed or out-of-range coordinates', () => {
    expect(
      extractBranchPoints([
        { lat: 91, lng: 79 },
        { lat: 6.9, lng: 200 },
        { lat: 'not-a-number', lng: 79.8 },
        null,
        'x',
      ])
    ).toEqual([]);
  });
});
