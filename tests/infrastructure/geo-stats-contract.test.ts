/**
 * Ensures GET /geo/stats shape stays aligned with the dashboard ApiGeoStats contract.
 */
const mockQuery = jest.fn();

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { GeoRepository } from '@/infrastructure/repositories/geo.repository';

describe('GeoRepository.getGeoStats dashboard contract', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns offersWithGeom / coveragePercent / byBank / byLocationScope', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          total_offers: '100',
          with_geom: '40',
          geocoded_offers: '45',
          unresolved_offers: '12',
          postgis_geometries: '40',
          offer_branches: '55',
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { bank: 'hnb', total: '70', with_geom: '30' },
          { bank: 'boc', total: '30', with_geom: '10' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { scope: 'ONLINE', count: '20', with_geom: '0' },
          { scope: 'SINGLE_VENUE', count: '80', with_geom: '40' },
        ],
      });

    const stats = await new GeoRepository().getGeoStats();

    expect(stats.totalOffers).toBe(100);
    expect(stats.offersWithGeom).toBe(40);
    expect(stats.offersWithoutGeom).toBe(60);
    expect(stats.coveragePercent).toBe(40);
    expect(stats.byBank).toEqual([
      { bank: 'hnb', total: 70, withGeom: 30, coveragePercent: 42.9 },
      { bank: 'boc', total: 30, withGeom: 10, coveragePercent: 33.3 },
    ]);
    expect(stats.byLocationScope).toEqual([
      { scope: 'ONLINE', count: 20, withGeom: 0 },
      { scope: 'SINGLE_VENUE', count: 80, withGeom: 40 },
    ]);
    // Legacy aliases preserved
    expect(stats.geocodedOffers).toBe(45);
    expect(stats.unresolvedOffers).toBe(12);
    expect(stats.postgisGeometries).toBe(40);
    expect(stats.offerBranches).toBe(55);
  });
});
