/**
 * Neon Lakebase Postgres client for Lanka Offers.
 *
 * Uses node-postgres (pg) with a connection pool.
 *
 * Connection strings come from environment variables written by `neon env pull`:
 *   DATABASE_URL         — pooled via PgBouncer   → use for all app queries
 *   DATABASE_URL_UNPOOLED — direct (no pooler)    → use for migrations only
 *
 * Project : lanaka-offers  (shiny-frost-69896486)
 * Org     : Nuwan          (org-weathered-lab-68042936)
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Run `neon env pull` or check your .env file."
  );
}

/**
 * Shared connection pool — use for all runtime queries.
 * The pooled Neon endpoint (contains '-pooler' in the host) routes through
 * PgBouncer in transaction mode.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

/**
 * Run a parameterised query against the pool.
 *
 * @example
 * const rows = await query<Offer>("SELECT * FROM offers WHERE bank = $1", ["HNB"]);
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result: QueryResult<T> = await pool.query(sql, params);
  return result.rows;
}

/**
 * Obtain a dedicated client from the pool.
 * Caller must call `client.release()` when done.
 * Use for multi-statement transactions.
 */
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Run a block inside a transaction. Rolls back automatically on error.
 *
 * @example
 * await withTransaction(async (client) => {
 *   await client.query("INSERT INTO raw_evidence ...");
 *   await client.query("INSERT INTO offers ...");
 * });
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Gracefully shut down the pool (call on process exit).
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
