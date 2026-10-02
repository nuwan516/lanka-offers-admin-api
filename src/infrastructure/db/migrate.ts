#!/usr/bin/env ts-node
/**
 * Runs the schema.sql migration against the Neon Postgres database.
 * Uses the unpooled direct connection (required for DDL).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/infrastructure/db/migrate.ts
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

async function main() {
  const connStr = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connStr) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString: connStr });

  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('Running migration against Neon…');
  await pool.query(sql);
  console.log('Migration complete.');

  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
