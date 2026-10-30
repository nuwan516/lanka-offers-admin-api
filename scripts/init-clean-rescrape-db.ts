import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

async function main() {
  const connStr = process.env.TARGET_DATABASE_URL;
  if (!connStr) {
    throw new Error('TARGET_DATABASE_URL environment variable is required');
  }

  // Ensure unpooled direct endpoint for DDL
  const directUrl = connStr.replace('-pooler.', '.');
  const pool = new Pool({ connectionString: directUrl, ssl: { rejectUnauthorized: false } });

  console.log('Connecting to target database for schema initialization...');
  const schemaPath = path.join(__dirname, '../src/infrastructure/db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('Applying schema.sql to target database...');
  await pool.query(sql);
  console.log('schema.sql applied successfully.');

  // Verify created tables
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log('Public tables present:', tables.rows.map(r => r.table_name).join(', '));

  // Verify columns of offers
  const cols = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'offers' ORDER BY ordinal_position`
  );
  console.log('Offers table columns count:', cols.rows.length);
  console.log('Key columns:', cols.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));

  await pool.end();
}

main().catch(err => {
  console.error('Schema initialization failed:', err);
  process.exit(1);
});
