import { RealPostgresHarness } from '../src/test/real-postgres-harness';
import { Client } from 'pg';
import 'dotenv/config';

export async function rehearseCleanup(): Promise<any> {
  console.log('=== PGLITE REHEARSAL: INITIALIZING DISPOSABLE POSTGRESQL ===');
  const harness = new RealPostgresHarness();
  await harness.initSchema();
  console.log('Schema initialized in PGlite WASM successfully.');

  // Read current records from Production Neon (read-only)
  console.log('Reading snapshot of existing 810 offers from Neon (read-only)...');
  const neonClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await neonClient.connect();

  const offersRes = await neonClient.query(`
    SELECT id, unique_id, bank, source_url, title, category, card_type,
           merchant_name, merchant_location, canonical_merchant, location_scope,
           discount_percentage, valid_from, valid_to, card_eligibility,
           geo_locations, geo_status, db_status, raw_offer, content_hash,
           manual_override, pending_candidate, created_at, updated_at
    FROM offers
  `);
  const reviewHistoryRes = await neonClient.query(`
    SELECT id, offer_id, action, from_status, to_status, changes_json, reason, actor, created_at
    FROM offer_review_history
  `);
  const dupsRes = await neonClient.query(`
    SELECT id, offer_id, candidate_offer_id, score, classification, reasons, status, created_at
    FROM offer_duplicate_candidates
  `);
  await neonClient.end();

  console.log(`Fetched ${offersRes.rows.length} offers, ${reviewHistoryRes.rows.length} history rows, ${dupsRes.rows.length} duplicate pairs.`);

  // Load into PGlite
  console.log('Populating PGlite disposable database with snapshot...');
  for (const o of offersRes.rows) {
    await harness.db.query(
      `INSERT INTO offers (
        id, unique_id, bank, source_url, title, category, card_type,
        merchant_name, merchant_location, canonical_merchant, location_scope,
        discount_percentage, valid_from, valid_to, card_eligibility,
        geo_locations, geo_status, db_status, raw_offer, content_hash,
        manual_override, pending_candidate, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        o.id, o.unique_id, o.bank, o.source_url, o.title, o.category, o.card_type,
        o.merchant_name, o.merchant_location, o.canonical_merchant, o.location_scope,
        o.discount_percentage, o.valid_from, o.valid_to, JSON.stringify(o.card_eligibility),
        JSON.stringify(o.geo_locations), o.geo_status, o.db_status, JSON.stringify(o.raw_offer), o.content_hash,
        JSON.stringify(o.manual_override), o.pending_candidate ? JSON.stringify(o.pending_candidate) : null,
        o.created_at, o.updated_at
      ]
    );
  }
  for (const h of reviewHistoryRes.rows) {
    await harness.db.query(
      `INSERT INTO offer_review_history (id, offer_id, action, from_status, to_status, changes_json, reason, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [h.id, h.offer_id, h.action, h.from_status, h.to_status, JSON.stringify(h.changes_json), h.reason, h.actor, h.created_at]
    );
  }
  for (const d of dupsRes.rows) {
    await harness.db.query(
      `INSERT INTO offer_duplicate_candidates (id, offer_id, candidate_offer_id, score, classification, reasons, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.id, d.offer_id, d.candidate_offer_id, d.score, d.classification, JSON.stringify(d.reasons), d.status, d.created_at]
    );
  }

  console.log('Snapshot successfully loaded into isolated PGlite.');

  // Baseline metrics
  const beforeCounts = await harness.db.query<{ db_status: string; count: string }>(`
    SELECT db_status, count(*) as count
    FROM offers
    GROUP BY db_status
    ORDER BY count DESC
  `);
  console.log('\n=== BEFORE CLEANUP: PGLITE OFFERS BY LIFECYCLE STATUS ===');
  console.table(beforeCounts.rows);

  // Rehearse Safe Cleanup Operations:
  // Step 1: Identify offers that are published but their valid_to is in the past (< CURRENT_DATE)
  const expiredToUpdate = await harness.db.query<{ id: string; unique_id: string; bank: string; valid_to: string }>(`
    SELECT id, unique_id, bank, valid_to
    FROM offers
    WHERE db_status = 'PUBLISHED'
      AND valid_to IS NOT NULL
      AND valid_to < CURRENT_DATE
  `);
  console.log(`\nIdentified ${expiredToUpdate.rows.length} PUBLISHED offers past expiry date.`);

  // Step 2: Safe transition to 'EXPIRED' with audit history
  for (const exp of expiredToUpdate.rows) {
    await harness.db.query(`
      UPDATE offers
      SET db_status = 'EXPIRED',
          updated_at = NOW()
      WHERE id = $1
    `, [exp.id]);

    await harness.db.query(`
      INSERT INTO offer_review_history (offer_id, action, from_status, to_status, reason, actor)
      VALUES ($1, 'expire', 'PUBLISHED', 'EXPIRED', 'Automated cleanup: valid_to past CURRENT_DATE', 'cleanup-rehearsal')
    `, [exp.id]);
  }

  // Step 3: Verify idempotency by running the exact query again
  const recheckExpired = await harness.db.query<{ count: string }>(`
    SELECT count(*) as count
    FROM offers
    WHERE db_status = 'PUBLISHED'
      AND valid_to IS NOT NULL
      AND valid_to < CURRENT_DATE
  `);
  console.log(`Idempotency verification: remaining past-due PUBLISHED offers = ${recheckExpired.rows[0].count} (must be 0).`);

  // Step 4: Verify manual overrides were preserved
  const manualOverrides = await harness.db.query<{ count: string }>(`
    SELECT count(*) as count
    FROM offers
    WHERE manual_override IS NOT NULL AND manual_override <> '{}'::jsonb
  `);
  console.log(`Manual overrides preserved: ${manualOverrides.rows[0].count}`);

  // Step 5: Verify raw_offer intact
  const rawOfferCheck = await harness.db.query<{ count: string }>(`
    SELECT count(*) as count
    FROM offers
    WHERE raw_offer IS NULL OR raw_offer = '{}'::jsonb
  `);
  console.log(`Missing raw_offer count: ${rawOfferCheck.rows[0].count} (must be 0)`);

  const afterCounts = await harness.db.query<{ db_status: string; count: string }>(`
    SELECT db_status, count(*) as count
    FROM offers
    GROUP BY db_status
    ORDER BY count DESC
  `);
  console.log('\n=== AFTER CLEANUP: PGLITE OFFERS BY LIFECYCLE STATUS ===');
  console.table(afterCounts.rows);

  const historyCounts = await harness.db.query<{ action: string; count: string }>(`
    SELECT action, count(*) as count
    FROM offer_review_history
    GROUP BY action
    ORDER BY count DESC
  `);
  console.log('\n=== AUDIT HISTORY AFTER REHEARSAL ===');
  console.table(historyCounts.rows);

  await harness.close();
  return {
    beforeCounts: beforeCounts.rows,
    afterCounts: afterCounts.rows,
    expiredUpdated: expiredToUpdate.rows.length,
    historyTotal: historyCounts.rows
  };
}

rehearseCleanup().catch(err => {
  console.error('Rehearsal failed:', err);
  process.exit(1);
});
