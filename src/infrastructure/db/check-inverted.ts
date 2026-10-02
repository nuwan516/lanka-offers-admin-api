import { pool } from './db-client';

async function main() {
    try {
        const res = await pool.query(`
            SELECT id, unique_id, bank, title, valid_from, valid_to, raw_offer 
            FROM offers 
            WHERE bank = 'nsb' AND valid_from > valid_to
        `);
        console.log(`Found ${res.rows.length} inverted offers:`);
        for (const row of res.rows) {
            console.log(`\n--- ${row.unique_id} (${row.bank}) ---`);
            console.log(`Title: ${row.title}`);
            console.log(`Valid From: ${row.valid_from} | Valid To: ${row.valid_to}`);
            console.log(`Raw Offer:`, JSON.stringify(row.raw_offer, null, 2));
        }
    } catch (e) {
        console.error('Error querying inverted offers:', e);
    } finally {
        await pool.end();
    }
}

main();
