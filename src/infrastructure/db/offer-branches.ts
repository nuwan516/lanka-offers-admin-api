/**
 * Denormalized offer_branches sync.
 *
 * Nearby discovery reads this table with PostGIS ST_DWithin (GIST) instead of
 * unnesting offers.geo_locations + Haversine on every request.
 *
 * Invariants:
 * - Never invents coordinates for ONLINE / NATIONWIDE / UNRESOLVED.
 * - Unconfirmed, rejected, or out-of-country coordinates never become branch rows.
 * - Does not mutate offers.raw_offer (immutable evidence).
 * - Supports both public API shape (lat/lng) and admin GeoLocation (latitude/longitude).
 */

import type { PoolClient } from 'pg';
import { pool } from './db-client';
import type { GeoLocation } from '@/core/types/offers';

export interface BranchPoint {
  branchName?: string | null;
  branchAddress?: string | null;
  lat: number;
  lng: number;
  confidence?: number | null;
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

/**
 * Scopes that must never contribute nearby pins, even if JSONB already has coordinates.
 * Island-wide (NATIONWIDE) offers are coverage statements, not branch pins.
 * SELECTED_OUTLETS may still sync when a source-named outlet has confirmed coordinates.
 */
export const NEARBY_EXCLUDED_SCOPES = ['ONLINE', 'NATIONWIDE', 'UNRESOLVED'] as const;

const NON_PHYSICAL_SCOPES = new Set<string>(NEARBY_EXCLUDED_SCOPES);

const SRI_LANKA_BOUNDS = { minLat: 5.9, maxLat: 10.0, minLng: 79.5, maxLng: 82.0 };

const AREA_ONLY_TYPES = new Set([
  'locality',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality',
  'postal_code',
  'political',
  'country',
]);

function inSriLanka(lat: number, lng: number): boolean {
  return (
    lat >= SRI_LANKA_BOUNDS.minLat &&
    lat <= SRI_LANKA_BOUNDS.maxLat &&
    lng >= SRI_LANKA_BOUNDS.minLng &&
    lng <= SRI_LANKA_BOUNDS.maxLng
  );
}

function isCountryCentroid(lat: number, lng: number): boolean {
  return Math.abs(lat - 7.8731) < 0.05 && Math.abs(lng - 80.7718) < 0.05;
}

/** SQL fragment: nearby queries must drop online, island-wide, and unresolved offers. */
export function nearbyScopePredicate(column = 'o.location_scope'): string {
  const list = NEARBY_EXCLUDED_SCOPES.map((s) => `'${s}'`).join(', ');
  return `(${column} IS NULL OR ${column} NOT IN (${list}))`;
}

function isFiniteCoord(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Normalize admin GeoLocation or public DTO-ish objects into branch points. */
export function extractBranchPoints(
  geoLocations: unknown[] | GeoLocation[] | null | undefined
): BranchPoint[] {
  if (!Array.isArray(geoLocations) || geoLocations.length === 0) return [];

  const points: BranchPoint[] = [];
  for (const raw of geoLocations) {
    if (!raw || typeof raw !== 'object') continue;
    const loc = raw as Record<string, unknown>;

    const latRaw = loc.lat ?? loc.latitude;
    const lngRaw = loc.lng ?? loc.longitude;
    const lat = typeof latRaw === 'number' ? latRaw : typeof latRaw === 'string' ? parseFloat(latRaw) : NaN;
    const lng = typeof lngRaw === 'number' ? lngRaw : typeof lngRaw === 'string' ? parseFloat(lngRaw) : NaN;
    if (!isFiniteCoord(lat, lng)) continue;
    if (!inSriLanka(lat, lng) || isCountryCentroid(lat, lng)) continue;
    if (loc.success === false || loc.confirmed === false) continue;

    const coordinateStatus = String(loc.coordinate_status ?? loc.coordinateStatus ?? '').toUpperCase();
    if (coordinateStatus && coordinateStatus !== 'VERIFIED') continue;
    const participationStatus = String(loc.participation_status ?? loc.participationStatus ?? '').toUpperCase();
    if (participationStatus === 'UNCONFIRMED' || participationStatus === 'EXCLUDED') continue;

    const types = Array.isArray(loc.types) ? loc.types.map((t) => String(t)) : [];
    if (types.length > 0 && types.every((t) => AREA_ONLY_TYPES.has(t))) continue;

    const name =
      (typeof loc.name === 'string' && loc.name) ||
      (typeof loc.branchName === 'string' && loc.branchName) ||
      null;
    const address =
      (typeof loc.address === 'string' && loc.address) ||
      (typeof loc.formattedAddress === 'string' && loc.formattedAddress) ||
      (typeof loc.originalAddress === 'string' && loc.originalAddress) ||
      null;
    const confidence =
      typeof loc.confidence === 'number' && Number.isFinite(loc.confidence)
        ? loc.confidence
        : null;

    points.push({
      branchName: name,
      branchAddress: address,
      lat,
      lng,
      confidence,
    });
  }
  return points;
}

/**
 * Replace all branch rows for an offer. Pass empty points to clear.
 * Also refreshes offers.geom to the first physical point (admin single-point tools).
 * SELECTED_OUTLETS: sync only when real coords already exist (never invent).
 */
export async function syncOfferBranches(
  offerId: string,
  geoLocations: unknown[] | GeoLocation[] | null | undefined,
  options?: { locationScope?: string | null; client?: Queryable }
): Promise<number> {
  const client = options?.client ?? pool;
  const scope = options?.locationScope ?? null;

  const points =
    scope != null && NON_PHYSICAL_SCOPES.has(scope)
      ? []
      : extractBranchPoints(geoLocations);

  await client.query(`DELETE FROM offer_branches WHERE offer_id = $1`, [offerId]);

  if (points.length === 0) {
    await client.query(
      `UPDATE offers SET geom = NULL, updated_at = NOW() WHERE id = $1 AND geom IS NOT NULL`,
      [offerId]
    );
    return 0;
  }

  for (const p of points) {
    await client.query(
      `INSERT INTO offer_branches (
         offer_id, branch_name, branch_address, lat, lng, confidence, geom
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography
       )`,
      [offerId, p.branchName ?? null, p.branchAddress ?? null, p.lat, p.lng, p.confidence ?? null]
    );
  }

  // Primary geom = first branch (admin nearby / backfill tools).
  const first = points[0];
  await client.query(
    `UPDATE offers
     SET geom = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
         updated_at = NOW()
     WHERE id = $3`,
    [first.lat, first.lng, offerId]
  );

  return points.length;
}

/** Resolve offer id by unique_id then sync branches (used by geocode persist path). */
export async function syncOfferBranchesByUniqueId(
  uniqueId: string,
  geoLocations: unknown[] | GeoLocation[] | null | undefined,
  locationScope?: string | null
): Promise<number> {
  const res = await pool.query<{ id: string; location_scope: string | null }>(
    `SELECT id, location_scope FROM offers WHERE unique_id = $1`,
    [uniqueId]
  );
  const row = res.rows[0];
  if (!row) return 0;
  return syncOfferBranches(row.id, geoLocations, {
    locationScope: locationScope ?? row.location_scope,
  });
}

/** Full-table rebuild from offers.geo_locations (CLI / migration repair). */
export async function rebuildAllOfferBranches(client?: PoolClient): Promise<{ offers: number; branches: number }> {
  const q = client ?? pool;
  await q.query(`DELETE FROM offer_branches`);

  const offersRes = await q.query<{
    id: string;
    geo_locations: unknown;
    location_scope: string | null;
  }>(`SELECT id, geo_locations, location_scope FROM offers`);

  let branches = 0;
  for (const row of offersRes.rows) {
    const locs = Array.isArray(row.geo_locations) ? row.geo_locations : [];
    branches += await syncOfferBranches(row.id, locs, {
      locationScope: row.location_scope,
      client: q,
    });
  }
  return { offers: offersRes.rows.length, branches };
}
