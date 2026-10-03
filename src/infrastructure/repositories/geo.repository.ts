import { pool } from '../db/db-client';

export interface PostgisNearbyOffer {
  id: string;
  unique_id: string;
  bank: string;
  source_url: string | null;
  title: string;
  category: string | null;
  card_type: string | null;
  merchant_name: string | null;
  merchant_location: string | null;
  canonical_merchant: string | null;
  location_scope: string | null;
  discount_percentage: string | null;
  valid_from: string | null;
  valid_to: string | null;
  card_eligibility: unknown;
  geo_locations: unknown;
  geo_status: string | null;
  db_status: string;
  distance_km: number;
  created_at: string;
  updated_at: string;
}

export interface NearbyQueryOptions {
  lat: number;
  lng: number;
  radiusKm?: number;
  bank?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GeoStats {
  totalOffers: number;
  geocodedOffers: number;
  unresolvedOffers: number;
  postgisGeometries: number;
  resolvedPercentage: number;
}

export class GeoRepository {
  /**
   * PostGIS high-speed proximity query using GIST spatial index and ST_DWithin / ST_Distance.
   */
  public async findNearbyOffers(options: NearbyQueryOptions): Promise<{
    items: PostgisNearbyOffer[];
    total: number;
    radiusKm: number;
  }> {
    const radiusKm = Math.min(Math.max(options.radiusKm ?? 25, 0.5), 100);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: string[] = [
      "o.db_status = 'PUBLISHED'",
      "(o.valid_to IS NULL OR o.valid_to >= CURRENT_DATE)",
      "o.geom IS NOT NULL",
      "ST_DWithin(o.geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3 * 1000)",
    ];

    const params: unknown[] = [options.lat, options.lng, radiusKm];
    let paramIndex = 4;

    if (options.bank) {
      conditions.push(`o.bank = $${paramIndex++}`);
      params.push(options.bank.toLowerCase());
    }

    if (options.category) {
      conditions.push(`o.category ILIKE $${paramIndex++}`);
      params.push(options.category);
    }

    if (options.search) {
      conditions.push(
        `(o.title ILIKE $${paramIndex} OR o.merchant_name ILIKE $${paramIndex} OR o.canonical_merchant ILIKE $${paramIndex})`
      );
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;

    const dataSql = `
      SELECT 
        o.id, o.unique_id, o.bank, o.source_url, o.title, o.category, o.card_type,
        o.merchant_name, o.merchant_location, o.canonical_merchant, o.location_scope,
        o.discount_percentage, o.valid_from, o.valid_to, o.card_eligibility,
        o.geo_locations, o.geo_status, o.db_status, o.created_at, o.updated_at,
        ROUND((ST_Distance(o.geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000.0)::numeric, 1)::float AS distance_km
      FROM offers o
      ${whereSql}
      ORDER BY o.geom <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM offers o
      ${whereSql}
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query<PostgisNearbyOffer>(dataSql, [...params, limit, offset]),
      pool.query<{ count: number }>(countSql, params),
    ]);

    return {
      items: dataRes.rows,
      total: countRes.rows[0]?.count ?? 0,
      radiusKm,
    };
  }

  /**
   * Aggregate statistics about geographic coverage and PostGIS point coverage.
   */
  public async getGeoStats(): Promise<GeoStats> {
    const res = await pool.query<{
      total_offers: string;
      geocoded_offers: string;
      unresolved_offers: string;
      postgis_geometries: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_offers,
        COUNT(*) FILTER (WHERE geo_status = 'resolved' OR (geo_locations IS NOT NULL AND jsonb_array_length(geo_locations) > 0))::text AS geocoded_offers,
        COUNT(*) FILTER (WHERE geo_status = 'unresolved' OR geo_locations IS NULL OR jsonb_array_length(geo_locations) = 0)::text AS unresolved_offers,
        COUNT(*) FILTER (WHERE geom IS NOT NULL)::text AS postgis_geometries
      FROM offers
      WHERE db_status = 'PUBLISHED';
    `);

    const total = parseInt(res.rows[0]?.total_offers ?? '0', 10);
    const geocoded = parseInt(res.rows[0]?.geocoded_offers ?? '0', 10);
    const unresolved = parseInt(res.rows[0]?.unresolved_offers ?? '0', 10);
    const postgisGeom = parseInt(res.rows[0]?.postgis_geometries ?? '0', 10);

    return {
      totalOffers: total,
      geocodedOffers: geocoded,
      unresolvedOffers: unresolved,
      postgisGeometries: postgisGeom,
      resolvedPercentage: total > 0 ? Math.round((geocoded / total) * 100) : 0,
    };
  }

  /**
   * Update PostGIS geometry for an offer.
   */
  public async updateOfferGeometry(offerId: string, lat: number, lng: number): Promise<boolean> {
    const res = await pool.query(
      `
      UPDATE offers
      SET 
        geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
        geo_status = 'resolved',
        updated_at = NOW()
      WHERE id = $3
      RETURNING id
      `,
      [lat, lng, offerId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Backfill missing PostGIS geometries from geo_locations array.
   */
  public async backfillGeometries(): Promise<number> {
    const res = await pool.query(`
      UPDATE offers 
      SET geom = ST_SetSRID(ST_MakePoint((geo_locations->0->>'lng')::float, (geo_locations->0->>'lat')::float), 4326)::geography
      WHERE geo_locations IS NOT NULL 
        AND jsonb_array_length(geo_locations) > 0 
        AND (geo_locations->0->>'lat') IS NOT NULL
        AND (geo_locations->0->>'lng') IS NOT NULL
        AND geom IS NULL;
    `);
    return res.rowCount ?? 0;
  }
}

export const geoRepository = new GeoRepository();
