-- =============================================================================
-- Migration: 002_offer_branches_postgis.sql
-- Purpose:   Denormalized offer_branches + PostGIS GIST for nearby discovery
-- Target:    Neon Lakebase Postgres (requires PostGIS extension)
-- Safe:      Idempotent (IF NOT EXISTS / guarded INSERT)
-- Apply via: npm run migrate  (runs schema.sql) OR execute this file with
--            the unpooled admin connection (DATABASE_URL_UNPOOLED).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE INDEX IF NOT EXISTS idx_offers_db_status_valid_to
  ON offers (db_status, valid_to);

CREATE TABLE IF NOT EXISTS offer_branches (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id         UUID             NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  branch_name      TEXT,
  branch_address   TEXT,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  confidence       REAL,
  geom             geography(Point, 4326) NOT NULL,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CHECK (lat BETWEEN -90.0 AND 90.0),
  CHECK (lng BETWEEN -180.0 AND 180.0)
);

CREATE INDEX IF NOT EXISTS idx_offer_branches_offer_id
  ON offer_branches (offer_id);

CREATE INDEX IF NOT EXISTS idx_offer_branches_geom_gist
  ON offer_branches USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_offer_branches_lat_lng
  ON offer_branches (lat, lng);

-- Backfill derived branches from JSONB (lat/lng or latitude/longitude).
INSERT INTO offer_branches (offer_id, branch_name, branch_address, lat, lng, confidence, geom)
SELECT
  o.id,
  COALESCE(loc->>'name', loc->>'branchName'),
  COALESCE(loc->>'address', loc->>'formattedAddress', loc->>'originalAddress'),
  branch_lat,
  branch_lng,
  CASE
    WHEN (loc->>'confidence') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (loc->>'confidence')::real
    ELSE NULL
  END,
  ST_SetSRID(ST_MakePoint(branch_lng, branch_lat), 4326)::geography
FROM offers o
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN o.geo_locations IS NOT NULL AND jsonb_typeof(o.geo_locations) = 'array'
    THEN o.geo_locations
    ELSE '[]'::jsonb
  END
) AS loc
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN jsonb_typeof(loc) = 'object'
        AND COALESCE(loc->>'lat', loc->>'latitude') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
      THEN COALESCE(loc->>'lat', loc->>'latitude')::double precision
      ELSE NULL
    END AS branch_lat,
    CASE
      WHEN jsonb_typeof(loc) = 'object'
        AND COALESCE(loc->>'lng', loc->>'longitude') ~ '^-?[0-9]{1,3}(\\.[0-9]+)?$'
      THEN COALESCE(loc->>'lng', loc->>'longitude')::double precision
      ELSE NULL
    END AS branch_lng
) coords
WHERE (o.location_scope IS NULL OR o.location_scope NOT IN ('ONLINE', 'NATIONWIDE', 'UNRESOLVED'))
  AND COALESCE(loc->>'confirmed', 'true') <> 'false'
  AND COALESCE(loc->>'success', 'true') <> 'false'
  AND COALESCE(loc->>'coordinate_status', loc->>'coordinateStatus', 'VERIFIED') IN ('VERIFIED')
  AND COALESCE(loc->>'participation_status', loc->>'participationStatus', 'SOURCE_VERIFIED')
      NOT IN ('UNCONFIRMED', 'EXCLUDED')
  AND branch_lat IS NOT NULL
  AND branch_lng IS NOT NULL
  AND branch_lat BETWEEN 5.9 AND 10.0
  AND branch_lng BETWEEN 79.5 AND 82.0
  AND NOT (abs(branch_lat - 7.8731) < 0.05 AND abs(branch_lng - 80.7718) < 0.05)
  AND NOT EXISTS (
    SELECT 1 FROM offer_branches ob
    WHERE ob.offer_id = o.id
      AND abs(ob.lat - branch_lat) < 1e-7
      AND abs(ob.lng - branch_lng) < 1e-7
  );

UPDATE offers o
SET geom = sub.geom,
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (ob.offer_id)
    ob.offer_id,
    ob.geom
  FROM offer_branches ob
  ORDER BY ob.offer_id, ob.created_at ASC
) sub
WHERE o.id = sub.offer_id
  AND o.geom IS NULL;

-- After applying: GRANT SELECT ON TABLE public.offer_branches TO lanka_offers_public_api;
