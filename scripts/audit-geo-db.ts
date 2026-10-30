import { pool, closePool } from '@/infrastructure/db/db-client';

async function main() {
  const r = await pool.query(`
    SELECT
      count(*) as total_offers,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE geo_status = 'resolved') as geo_resolved,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_locations,
      count(*) FILTER (WHERE db_status = 'PUBLISHED' AND jsonb_array_length(geo_locations) > 0) as published_with_locations
    FROM offers
  `);
  console.log('Geo breakdown:', r.rows[0]);

  const bankBreakdown = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE jsonb_array_length(geo_locations) > 0) as with_geo
    FROM offers
    GROUP BY bank
    ORDER BY bank
  `);
  console.log('Bank breakdown:');
  console.table(bankBreakdown.rows);

  await closePool();
}

main().catch(console.error);
