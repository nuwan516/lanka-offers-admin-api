/**
 * Test Helper — Simulates the Public API's Consumer Query Engine within admin/api tests
 *
 * Adheres to AGENTS.md Rule #1:
 * "The workspace holds five independent Git repositories (no monorepo, no root repository).
 * Treat the public API contract as the only integration boundary; never import across repositories."
 */

import { pool } from '@/infrastructure/db/db-client';

export interface PublicOfferSummary {
  id: string;
  unique_id: string;
  bank: string;
  source_url: string;
  title: string;
  category: string;
  card_type: string;
  merchant_name: string;
  merchant_location: string;
  canonical_merchant?: string;
  location_scope: string;
  discount_percentage: string;
  valid_from: string;
  valid_to: string;
  card_eligibility: Record<string, unknown>;
  geo_locations: unknown[];
  geo_status: string;
  db_status: string;
  description?: string;
  terms?: string;
  created_at: string;
  updated_at: string;
  distance_km?: number;
  matched_branch_name?: string;
  matched_branch_address?: string;
}

export interface OfferListQueryOptions {
  bank?: string;
  category?: string;
  locationScope?: string;
  merchant?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface NearbyOffersQueryOptions {
  lat: number;
  lng: number;
  radius?: number;
  bank?: string;
  category?: string;
  search?: string;
  includeNationwide?: boolean;
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class PublicOfferQueryHarness {
  public async findPublishedOffers(
    options: OfferListQueryOptions
  ): Promise<PaginatedResult<PublicOfferSummary>> {
    const conditions: string[] = [
      "db_status = 'PUBLISHED'",
      "(valid_to IS NULL OR valid_to >= CURRENT_DATE)",
    ];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.bank) {
      conditions.push(`bank = $${paramIndex++}`);
      params.push(options.bank.toLowerCase());
    }

    if (options.category) {
      conditions.push(`category ILIKE $${paramIndex++}`);
      params.push(options.category);
    }

    if (options.locationScope) {
      conditions.push(`location_scope = $${paramIndex++}`);
      params.push(options.locationScope);
    }

    if (options.search) {
      conditions.push(
        `(title ILIKE $${paramIndex} OR merchant_name ILIKE $${paramIndex} OR canonical_merchant ILIKE $${paramIndex})`
      );
      params.push(`%${options.search}%`);
      paramIndex++;
    }

    const whereSql = `WHERE ${conditions.join(' AND ')}`;
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const dataSql = `
      SELECT id, unique_id, bank, source_url, title, category, card_type,
             merchant_name, merchant_location, canonical_merchant, location_scope,
             discount_percentage, valid_from, valid_to, card_eligibility,
             geo_locations, geo_status, db_status,
             COALESCE(
               SUBSTRING(raw_offer->'offer'->>'description' FROM 1 FOR 200),
               title
             ) AS description,
             raw_offer->'offer'->>'terms' AS terms,
             created_at, updated_at
      FROM offers
      ${whereSql}
      ORDER BY updated_at DESC, id ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM offers
      ${whereSql}
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query<PublicOfferSummary>(dataSql, [...params, limit, offset]),
      pool.query<{ count: number }>(countSql, params),
    ]);

    return {
      items: dataRes.rows,
      total: countRes.rows[0]?.count ?? 0,
      limit,
      offset,
    };
  }

  public async findNearbyOffers(
    options: NearbyOffersQueryOptions
  ): Promise<PaginatedResult<PublicOfferSummary>> {
    const radius = Math.min(Math.max(options.radius ?? 25, 0.5), 100);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: string[] = [
      "o.db_status = 'PUBLISHED'",
      "(o.valid_to IS NULL OR o.valid_to >= CURRENT_DATE)",
      "o.geo_locations IS NOT NULL",
      "jsonb_typeof(o.geo_locations) = 'array'",
      "jsonb_array_length(o.geo_locations) > 0",
      "(o.location_scope IS NULL OR o.location_scope NOT IN ('ONLINE', 'UNRESOLVED'))",
    ];

    const params: unknown[] = [options.lat, options.lng, radius];
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
      WITH valid_branches AS (
        SELECT 
          o.id, o.unique_id, o.bank, o.source_url, o.title, o.category, o.card_type,
          o.merchant_name, o.merchant_location, o.canonical_merchant, o.location_scope,
          o.discount_percentage, o.valid_from, o.valid_to, o.card_eligibility,
          o.geo_locations, o.geo_status, o.db_status, o.created_at, o.updated_at,
          COALESCE(
            SUBSTRING(o.raw_offer->'offer'->>'description' FROM 1 FOR 200),
            o.title
          ) AS description,
          loc->>'name' AS branch_name,
          loc->>'address' AS branch_address,
          CASE 
            WHEN jsonb_typeof(loc) = 'object' 
              AND (loc->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
              AND (loc->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN (loc->>'lat')::float
            ELSE NULL
          END AS branch_lat,
          CASE 
            WHEN jsonb_typeof(loc) = 'object' 
              AND (loc->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
              AND (loc->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN (loc->>'lng')::float
            ELSE NULL
          END AS branch_lng
        FROM offers o,
        jsonb_array_elements(o.geo_locations) AS loc
        ${whereSql}
      ),
      bounded_branches AS (
        SELECT *,
          (
            6371 * acos(
              least(1.0, greatest(-1.0,
                cos(radians($1)) * cos(radians(branch_lat)) *
                cos(radians(branch_lng) - radians($2)) +
                sin(radians($1)) * sin(radians(branch_lat))
              ))
            )
          ) AS dist_km
        FROM valid_branches
        WHERE branch_lat IS NOT NULL
          AND branch_lng IS NOT NULL
          AND branch_lat BETWEEN -90.0 AND 90.0
          AND branch_lng BETWEEN -180.0 AND 180.0
          AND branch_lat BETWEEN ($1 - ($3 / 111.0)) AND ($1 + ($3 / 111.0))
          AND branch_lng BETWEEN ($2 - ($3 / (111.0 * greatest(0.01, cos(radians(least(89.0, greatest(-89.0, $1))))))))
                             AND ($2 + ($3 / (111.0 * greatest(0.01, cos(radians(least(89.0, greatest(-89.0, $1))))))))
      ),
      nearest_per_offer AS (
        SELECT DISTINCT ON (id)
          id, unique_id, bank, source_url, title, category, card_type,
          merchant_name, merchant_location, canonical_merchant, location_scope,
          discount_percentage, valid_from, valid_to, card_eligibility,
          geo_locations, geo_status, db_status, description, created_at, updated_at,
          ROUND(dist_km::numeric, 1)::float AS distance_km,
          branch_name AS matched_branch_name,
          branch_address AS matched_branch_address
        FROM bounded_branches
        WHERE dist_km <= $3
        ORDER BY id, dist_km ASC
      )
      SELECT *
      FROM nearest_per_offer
      ORDER BY distance_km ASC, id ASC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;

    const countSql = `
      WITH valid_branches AS (
        SELECT o.id,
          CASE 
            WHEN jsonb_typeof(loc) = 'object' 
              AND (loc->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
              AND (loc->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN (loc->>'lat')::float
            ELSE NULL
          END AS branch_lat,
          CASE 
            WHEN jsonb_typeof(loc) = 'object' 
              AND (loc->>'lat') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
              AND (loc->>'lng') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
            THEN (loc->>'lng')::float
            ELSE NULL
          END AS branch_lng
        FROM offers o,
        jsonb_array_elements(o.geo_locations) AS loc
        ${whereSql}
      ),
      bounded_branches AS (
        SELECT id,
          (
            6371 * acos(
              least(1.0, greatest(-1.0,
                cos(radians($1)) * cos(radians(branch_lat)) *
                cos(radians(branch_lng) - radians($2)) +
                sin(radians($1)) * sin(radians(branch_lat))
              ))
            )
          ) AS dist_km
        FROM valid_branches
        WHERE branch_lat IS NOT NULL
          AND branch_lng IS NOT NULL
          AND branch_lat BETWEEN -90.0 AND 90.0
          AND branch_lng BETWEEN -180.0 AND 180.0
          AND branch_lat BETWEEN ($1 - ($3 / 111.0)) AND ($1 + ($3 / 111.0))
          AND branch_lng BETWEEN ($2 - ($3 / (111.0 * greatest(0.01, cos(radians(least(89.0, greatest(-89.0, $1))))))))
                             AND ($2 + ($3 / (111.0 * greatest(0.01, cos(radians(least(89.0, greatest(-89.0, $1))))))))
      )
      SELECT COUNT(DISTINCT id)::int AS count
      FROM bounded_branches
      WHERE dist_km <= $3
    `;

    const [dataRes, countRes] = await Promise.all([
      pool.query<PublicOfferSummary>(dataSql, [...params, limit, offset]),
      pool.query<{ count: number }>(countSql, params),
    ]);

    return {
      items: dataRes.rows,
      total: countRes.rows[0]?.count ?? 0,
      limit,
      offset,
    };
  }
}
