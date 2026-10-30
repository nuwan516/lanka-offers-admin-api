import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Pool } from 'pg';

interface GeoOutput {
  metadata: {
    source: string;
    totalOffers: number;
    geocodedCount: number;
    totalLocations: number;
  };
  offers: Array<{
    offerId: string;
    merchantName?: string;
    locationType: string;
    locations: Array<{
      success?: boolean;
      searchAddress: string;
      formattedAddress?: string;
      latitude?: number;
      longitude?: number;
      placeId?: string;
      types?: string[];
      source?: string;
      branchName?: string;
      error?: string;
    }>;
  }>;
}

function toGeoLocation(r: any) {
  return {
    originalAddress: r.searchAddress,
    formattedAddress: r.formattedAddress,
    latitude: r.latitude ?? 0,
    longitude: r.longitude ?? 0,
    placeId: r.placeId,
    types: r.types,
    source: r.source ?? 'geocoding_api',
    branchName: r.branchName,
  };
}

function deriveGeoStatus(row: any): string {
  if (row.locationType === 'ONLINE' || row.locationType === 'NONE') return 'resolved';
  if (row.locations.some((l: any) => l.error === 'QUOTA_BLOCKED')) return 'quota_blocked';
  return row.locations.length > 0 ? 'resolved' : 'unresolved';
}

async function main() {
  const connStr = 'postgresql://neondb_owner:npg_S24AOYcNTECt@ep-weathered-forest-a1te8qsw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
  const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 10,
    keepAlive: true,
    statement_timeout: 45000,
  });

  const geoDir = path.join(__dirname, '../output/geo');
  const files = fs.readdirSync(geoDir).filter(f => f.endsWith('_geo.json'));
  console.log(`Found ${files.length} geo output files in ${geoDir}`);

  let totalUpdated = 0;

  for (const file of files) {
    const filePath = path.join(geoDir, file);
    const data: GeoOutput = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const bank = data.metadata.source;
    console.log(`\nSyncing ${data.offers.length} geo results for bank: ${bank.toUpperCase()}...`);

    const validOffers = data.offers.filter(o => !!o.offerId);
    const CHUNK_SIZE = 20;

    for (let i = 0; i < validOffers.length; i += CHUNK_SIZE) {
      const chunk = validOffers.slice(i, i + CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (row) => {
          const locations = row.locations.filter(l => l.success !== false).map(toGeoLocation);
          const status = deriveGeoStatus(row);
          const geoCacheKey = crypto
            .createHash('md5')
            .update(JSON.stringify({ type: row.locationType, addresses: row.locations.map(l => l.searchAddress).sort() }))
            .digest('hex');

          await pool.query(
            `UPDATE offers
             SET geo_locations = $2, geo_status = $3, geo_cache_key = $4, updated_at = NOW()
             WHERE unique_id = $1`,
            [row.offerId, JSON.stringify(locations), status, geoCacheKey]
          );
          totalUpdated++;
        })
      );
    }
    console.log(`  ✓ Bank ${bank.toUpperCase()} synced (${validOffers.length} offers)`);
  }

  console.log(`\n================================================================`);
  console.log(`Total geo offers synced to clean-rescrape branch: ${totalUpdated}`);
  console.log(`================================================================`);

  // Verification query
  const res = await pool.query(`
    SELECT
      count(*) as total_offers,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE geo_status = 'resolved') as geo_resolved,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_locations,
      count(*) FILTER (WHERE db_status = 'PUBLISHED' AND jsonb_array_length(geo_locations) > 0) as published_with_locations
    FROM offers
  `);
  console.log('Final database stats on clean-rescrape branch:');
  console.log(res.rows[0]);

  const bankBreakdown = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_geo,
      count(*) FILTER (WHERE geo_status = 'resolved') as resolved
    FROM offers
    GROUP BY bank
    ORDER BY bank
  `);
  console.table(bankBreakdown.rows);

  await pool.end();
}

main().catch(console.error);
