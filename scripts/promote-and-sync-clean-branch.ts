import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { SRI_LANKAN_CITIES } from '../src/core/constants/cities';

interface GeoCacheResult {
  searchAddress: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  types?: string[];
  source?: string;
  success?: boolean;
}

interface GeoPin {
  name: string | null;
  address: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  latitude: number;
  longitude: number;
  placeId?: string;
  types?: string[];
  source: string;
}

const cacheDir = path.resolve(__dirname, '../.geo-cache/geocode');
const geoCacheMap = new Map<string, GeoCacheResult>();

if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir)) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
      if (c && c.result && c.result.success && c.result.latitude && c.result.longitude) {
        const queryNorm = (c.address || c.result.searchAddress || '').toLowerCase().trim();
        geoCacheMap.set(queryNorm, c.result);
        const withoutCountry = queryNorm.replace(/,\s*sri\s+lanka\s*$/i, '').trim();
        if (withoutCountry) geoCacheMap.set(withoutCountry, c.result);
      }
    } catch {}
  }
}
console.log(`Loaded ${geoCacheMap.size} valid geocache entries into memory.`);

function splitConcatenatedCities(text: string): string[] {
  if (!text) return [];
  const clean = text
    .replace(/\b(?:Hatton\s+National\s+Bank|Bank\s+of\s+Ceylon|Commercial\s+Bank|People'?s\s+Bank|HNB|BOC|NDB|DFCC|PABC|NSB)\b/gi, ' ')
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/[,\-–—/|&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = clean.split(' ');
  const matched: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (i + 1 < tokens.length) {
      const two = `${tokens[i]} ${tokens[i + 1]}`;
      if (SRI_LANKAN_CITIES.includes(two)) {
        if (!matched.includes(two)) matched.push(two);
        i += 2;
        continue;
      }
    }
    if (SRI_LANKAN_CITIES.includes(tokens[i])) {
      if (!matched.includes(tokens[i])) matched.push(tokens[i]);
      i += 1;
      continue;
    }
    i += 1;
  }
  return matched;
}

function extractCityFromTitle(title: string): string | null {
  if (!title) return null;
  const clean = title.toLowerCase();
  for (const c of SRI_LANKAN_CITIES) {
    const pat = new RegExp(`\\b${c}\\b`, 'i');
    if (pat.test(clean)) return c;
  }
  return null;
}

function normalizePin(raw: any, defaultName: string | null = null): GeoPin {
  const lat = Number(raw.lat ?? raw.latitude ?? 0);
  const lng = Number(raw.lng ?? raw.longitude ?? 0);
  const addr = String(raw.address ?? raw.formattedAddress ?? raw.originalAddress ?? 'Sri Lanka');
  return {
    name: raw.name ?? raw.branchName ?? defaultName,
    address: addr,
    formattedAddress: String(raw.formattedAddress ?? addr),
    lat,
    lng,
    latitude: lat,
    longitude: lng,
    placeId: raw.placeId,
    types: raw.types,
    source: raw.source ?? 'geocoding_api',
  };
}

async function main() {
  const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_S24AOYcNTECt@ep-weathered-forest-a1te8qsw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false },
    max: 15,
  });

  console.log('Fetching offers from clean-rescrape branch...');
  const res = await pool.query(`
    SELECT id, unique_id, bank, title, merchant_name, merchant_location,
           discount_percentage, valid_from, valid_to, location_scope,
           rule_passed, rule_errors, rule_warnings, db_status,
           geo_status, geo_locations
    FROM offers
  `);

  const total = res.rows.length;
  console.log(`Auditing and synchronizing ${total} offers...`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let promotedToPublished = 0;
  let markedExpired = 0;
  let retainedInReview = 0;
  let newlyGeocodedOffers = 0;
  let existingGeoBackfilled = 0;

  const updates: Array<{
    id: string;
    dbStatus: string;
    approvedAt: Date | null;
    publishedAt: Date | null;
    geoStatus: string;
    geoLocations: GeoPin[];
    locationScope: string;
  }> = [];

  for (const r of res.rows) {
    let newDbStatus = r.db_status;
    let approvedAt: Date | null = null;
    let publishedAt: Date | null = null;

    const validToDate = r.valid_to ? new Date(r.valid_to) : null;
    const isPastExpiry = validToDate ? validToDate < today : false;

    // 1. Status Evaluation
    if (r.db_status === 'REVIEW_REQUIRED') {
      const hasErrors = r.rule_passed === false || (Array.isArray(r.rule_errors) && r.rule_errors.length > 0);
      const warnings = Array.isArray(r.rule_warnings) ? r.rule_warnings : [];
      const criticalWarnings = warnings.filter((w: any) => !w.message.includes('geocoding will rely on name only'));

      if (isPastExpiry) {
        newDbStatus = 'EXPIRED';
        markedExpired++;
      } else if (!hasErrors && criticalWarnings.length === 0 && r.title && r.merchant_name) {
        newDbStatus = 'PUBLISHED';
        approvedAt = new Date();
        publishedAt = new Date();
        promotedToPublished++;
      } else {
        retainedInReview++;
      }
    } else if (r.db_status === 'PUBLISHED' && isPastExpiry) {
      newDbStatus = 'EXPIRED';
      markedExpired++;
    }

    // 2. Geospatial Normalization & Enhancement
    let currentPins: GeoPin[] = [];
    if (Array.isArray(r.geo_locations) && r.geo_locations.length > 0) {
      currentPins = r.geo_locations.map((l: any) => normalizePin(l, r.merchant_name));
      existingGeoBackfilled++;
    }

    let newLocationScope = r.location_scope;
    let newGeoStatus = r.geo_status ?? 'unresolved';

    if (currentPins.length === 0 && r.location_scope !== 'ONLINE') {
      const loc = (r.merchant_location || '').trim();
      const citiesInLoc = splitConcatenatedCities(loc);
      let matchedCities: string[] = [];

      if (citiesInLoc.length > 0) {
        matchedCities = citiesInLoc;
      } else {
        const cityInTitle = extractCityFromTitle(r.title);
        if (cityInTitle) matchedCities = [cityInTitle];
      }

      if (matchedCities.length > 0) {
        const newPins: GeoPin[] = [];
        for (const c of matchedCities) {
          const cached = geoCacheMap.get(`${c}, sri lanka`) || geoCacheMap.get(c);
          if (cached) {
            newPins.push({
              name: r.merchant_name,
              address: cached.formattedAddress || `${c}, Sri Lanka`,
              formattedAddress: cached.formattedAddress || `${c}, Sri Lanka`,
              lat: cached.latitude,
              lng: cached.longitude,
              latitude: cached.latitude,
              longitude: cached.longitude,
              placeId: cached.placeId,
              types: cached.types,
              source: 'geocoding_api',
            });
          }
        }

        if (newPins.length > 0) {
          currentPins = newPins;
          newGeoStatus = 'resolved';
          newLocationScope = newPins.length > 1 ? 'MULTIPLE_BRANCHES' : 'EXPLICIT_BRANCH';
          newlyGeocodedOffers++;
        }
      }
    }

    // Record for update if anything changed
    const statusChanged = newDbStatus !== r.db_status;
    const geoChanged = newGeoStatus !== r.geo_status || currentPins.length !== (r.geo_locations?.length ?? 0);
    const scopeChanged = newLocationScope !== r.location_scope;

    if (statusChanged || geoChanged || scopeChanged) {
      updates.push({
        id: r.id,
        dbStatus: newDbStatus,
        approvedAt: approvedAt ?? (newDbStatus === 'PUBLISHED' ? new Date() : null),
        publishedAt: publishedAt ?? (newDbStatus === 'PUBLISHED' ? new Date() : null),
        geoStatus: newGeoStatus,
        geoLocations: currentPins,
        locationScope: newLocationScope,
      });
    }
  }

  console.log(`\nReady to update ${updates.length} offers in Postgres:`);
  console.log(`  Promoting to PUBLISHED: +${promotedToPublished}`);
  console.log(`  Marking EXPIRED:        +${markedExpired}`);
  console.log(`  Remaining in REVIEW:    ${retainedInReview}`);
  console.log(`  Newly Geocoded Offers:  +${newlyGeocodedOffers}`);

  // Chunked parallel database updates
  const CHUNK_SIZE = 25;
  let updatedCount = 0;

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (u) => {
        await pool.query(
          `UPDATE offers
           SET db_status = $2,
               approved_at = COALESCE(approved_at, $3),
               published_at = COALESCE(published_at, $4),
               geo_status = $5,
               geo_locations = $6,
               location_scope = $7,
               updated_at = NOW()
           WHERE id = $1`,
          [
            u.id,
            u.dbStatus,
            u.approvedAt,
            u.publishedAt,
            u.geoStatus,
            JSON.stringify(u.geoLocations),
            u.locationScope,
          ]
        );
      })
    );
    updatedCount += chunk.length;
    process.stdout.write(`\rProgress: ${updatedCount} / ${updates.length} rows updated...`);
  }
  console.log('\n\nUpdate complete!');

  // Verification Audit
  const finalAudit = await pool.query(`
    SELECT
      count(*) as total,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED') as review_required,
      count(*) FILTER (WHERE db_status = 'EXPIRED') as expired,
      count(*) FILTER (WHERE db_status = 'REJECTED') as rejected,
      count(*) FILTER (WHERE geo_status = 'resolved') as geo_resolved,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_pins,
      count(*) FILTER (WHERE db_status = 'PUBLISHED' AND jsonb_array_length(geo_locations) > 0) as published_with_pins
    FROM offers
  `);

  console.log('\n================================================================');
  console.log('  FINAL POSTGRES DATABASE STATE ON CLEAN-RESCRAPE');
  console.log('================================================================');
  console.table(finalAudit.rows);

  const bankBreakdown = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED') as in_review,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_pins
    FROM offers
    GROUP BY bank
    ORDER BY count(*) DESC
  `);
  console.log('\nBank Breakdown:');
  console.table(bankBreakdown.rows);
  console.log('================================================================');

  await pool.end();
}

main().catch(console.error);
