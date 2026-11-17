import { pool } from '../db/db-client';
import { nearbyScopePredicate } from '../db/offer-branches';

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
  matched_branch_name?: string | null;
  matched_branch_address?: string | null;
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
  offerBranches: number;
  resolvedPercentage: number;
}

export class GeoRepository {
  /**
   * PostGIS proximity via denormalized offer_branches + GIST.
   * Uses ST_DWithin (index-assisted) — no custom Haversine / bounding-box.
   * geography type is spheroid-safe at poles and for large radii.
   * List + count share one CTE pipeline (COUNT(*) OVER()).
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
      '(o.valid_to IS NULL OR o.valid_to >= CURRENT_DATE)',
      // ST_DWithin on geography uses metres; GIST index on offer_branches.geom.
      // Edge cases (poles / antimeridian / large radii): geography spheroid math —
      // no cos(lat) division, so polar queries remain correct.
      'ST_DWithin(b.geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3 * 1000.0)',
      nearbyScopePredicate('o.location_scope'),
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

    const sql = `
      WITH matched AS (
        SELECT
          o.id, o.unique_id, o.bank, o.source_url, o.title, o.category, o.card_type,
          o.merchant_name, o.merchant_location, o.canonical_merchant, o.location_scope,
          o.discount_percentage, o.valid_from, o.valid_to, o.card_eligibility,
          o.geo_locations, o.geo_status, o.db_status, o.created_at, o.updated_at,
          b.branch_name,
          b.branch_address,
          (ST_Distance(b.geom, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000.0) AS dist_km
        FROM offer_branches b
        INNER JOIN offers o ON o.id = b.offer_id
        ${whereSql}
      ),
      nearest_per_offer AS (
        SELECT DISTINCT ON (id)
          id, unique_id, bank, source_url, title, category, card_type,
          merchant_name, merchant_location, canonical_merchant, location_scope,
          discount_percentage, valid_from, valid_to, card_eligibility,
          geo_locations, geo_status, db_status, created_at, updated_at,
          ROUND(dist_km::numeric, 1)::float AS distance_km,
          branch_name AS matched_branch_name,
          branch_address AS matched_branch_address
        FROM matched
        ORDER BY id, dist_km ASC
      ),
      with_total AS (
        SELECT *, COUNT(*) OVER()::int AS total_count
        FROM nearest_per_offer
      )
      SELECT *
      FROM with_total
      ORDER BY distance_km ASC, id ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const res = await pool.query<PostgisNearbyOffer & { total_count: number }>(sql, [
      ...params,
      limit,
      offset,
    ]);

    return {
      items: res.rows.map(({ total_count: _t, ...row }) => row),
      total: res.rows[0]?.total_count ?? 0,
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
      offer_branches: string;
    }>(`
      SELECT
        COUNT(*)::text AS total_offers,
        COUNT(*) FILTER (WHERE geo_status = 'resolved' OR (geo_locations IS NOT NULL AND jsonb_array_length(geo_locations) > 0))::text AS geocoded_offers,
        COUNT(*) FILTER (WHERE geo_status = 'unresolved' OR geo_locations IS NULL OR jsonb_array_length(geo_locations) = 0)::text AS unresolved_offers,
        COUNT(*) FILTER (WHERE geom IS NOT NULL)::text AS postgis_geometries,
        (SELECT COUNT(*)::text FROM offer_branches) AS offer_branches
      FROM offers
      WHERE db_status = 'PUBLISHED'
    `);

    const total = parseInt(res.rows[0]?.total_offers ?? '0', 10);
    const geocoded = parseInt(res.rows[0]?.geocoded_offers ?? '0', 10);
    const unresolved = parseInt(res.rows[0]?.unresolved_offers ?? '0', 10);
    const postgisGeom = parseInt(res.rows[0]?.postgis_geometries ?? '0', 10);
    const offerBranches = parseInt(res.rows[0]?.offer_branches ?? '0', 10);

    return {
      totalOffers: total,
      geocodedOffers: geocoded,
      unresolvedOffers: unresolved,
      postgisGeometries: postgisGeom,
      offerBranches,
      resolvedPercentage: total > 0 ? Math.round((geocoded / total) * 100) : 0,
    };
  }

  /**
   * Update PostGIS geometry for an offer (primary point) and upsert a branch row.
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
    if ((res.rowCount ?? 0) === 0) return false;

    await pool.query(`DELETE FROM offer_branches WHERE offer_id = $1`, [offerId]);
    await pool.query(
      `INSERT INTO offer_branches (offer_id, lat, lng, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography)`,
      [offerId, lat, lng]
    );
    return true;
  }

  /**
   * Backfill missing PostGIS geometries + offer_branches from geo_locations array.
   */
  public async backfillGeometries(): Promise<number> {
    const res = await pool.query(`
      WITH candidates AS (
        SELECT
          o.id AS offer_id,
          COALESCE(loc->>'name', loc->>'branchName') AS branch_name,
          COALESCE(loc->>'address', loc->>'formattedAddress', loc->>'originalAddress') AS branch_address,
          CASE
            WHEN jsonb_typeof(loc) = 'object'
              AND COALESCE(loc->>'lat', loc->>'latitude') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN COALESCE(loc->>'lat', loc->>'latitude')::double precision
            ELSE NULL
          END AS lat,
          CASE
            WHEN jsonb_typeof(loc) = 'object'
              AND COALESCE(loc->>'lng', loc->>'longitude') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN COALESCE(loc->>'lng', loc->>'longitude')::double precision
            ELSE NULL
          END AS lng
        FROM offers o
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN o.geo_locations IS NOT NULL AND jsonb_typeof(o.geo_locations) = 'array'
            THEN o.geo_locations ELSE '[]'::jsonb
          END
        ) AS loc
        WHERE (o.location_scope IS NULL OR o.location_scope NOT IN ('ONLINE', 'NATIONWIDE', 'UNRESOLVED'))
          AND COALESCE(loc->>'confirmed', 'true') <> 'false'
          AND COALESCE(loc->>'success', 'true') <> 'false'
          AND COALESCE(loc->>'coordinate_status', loc->>'coordinateStatus', 'VERIFIED') IN ('VERIFIED')
          AND COALESCE(loc->>'participation_status', loc->>'participationStatus', 'SOURCE_VERIFIED')
              NOT IN ('UNCONFIRMED', 'EXCLUDED')
      ),
      valid AS (
        SELECT * FROM candidates
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND lat BETWEEN 5.9 AND 10.0
          AND lng BETWEEN 79.5 AND 82.0
          AND NOT (abs(lat - 7.8731) < 0.05 AND abs(lng - 80.7718) < 0.05)
      ),
      inserted AS (
        INSERT INTO offer_branches (offer_id, branch_name, branch_address, lat, lng, geom)
        SELECT
          v.offer_id, v.branch_name, v.branch_address, v.lat, v.lng,
          ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography
        FROM valid v
        WHERE NOT EXISTS (
          SELECT 1 FROM offer_branches ob
          WHERE ob.offer_id = v.offer_id
            AND abs(ob.lat - v.lat) < 1e-7
            AND abs(ob.lng - v.lng) < 1e-7
        )
        RETURNING offer_id
      )
      UPDATE offers o
      SET geom = ST_SetSRID(ST_MakePoint(v.lng, v.lat), 4326)::geography,
          updated_at = NOW()
      FROM (
        SELECT DISTINCT ON (offer_id) offer_id, lat, lng
        FROM valid
        ORDER BY offer_id
      ) v
      WHERE o.id = v.offer_id AND o.geom IS NULL
      RETURNING o.id
    `);
    return res.rowCount ?? 0;
  }
}

export const geoRepository = new GeoRepository();
