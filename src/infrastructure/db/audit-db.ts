import 'dotenv/config';
import { pool } from './db-client';

async function main() {
  console.log('=== DATABASE INVENTORY AUDIT ===\n');

  // 1. Bank and Status Breakdown
  const bankStatus = await pool.query(`
    SELECT bank, db_status, count(*) as count
    FROM offers
    GROUP BY bank, db_status
    ORDER BY bank, count DESC;
  `);
  console.log('--- Offers by Bank and Lifecycle Status ---');
  console.table(bankStatus.rows);

  // 2. Total Counts & Completeness
  const fieldCompleteness = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(merchant_name) as has_merchant,
      count(discount_percentage) as has_discount,
      count(valid_from) as has_valid_from,
      count(valid_to) as has_valid_to,
      count(source_url) as has_source_url,
      count(raw_offer) as has_raw_offer,
      count(CASE WHEN (card_eligibility->'includedCards') != '[]'::jsonb THEN 1 END) as has_included_cards,
      count(CASE WHEN (card_eligibility->'excludedCards') != '[]'::jsonb THEN 1 END) as has_excluded_cards,
      count(llm_score) as has_llm_score,
      count(CASE WHEN rule_passed = false THEN 1 END) as rule_failures,
      count(CASE WHEN geo_status = 'unresolved' THEN 1 END) as geo_unresolved
    FROM offers
    GROUP BY bank
    ORDER BY count(*) DESC;
  `);
  console.log('\n--- Field Completeness by Bank ---');
  console.table(fieldCompleteness.rows);

  // 3. Domain-Level Data Quality Anomalies
  console.log('\n--- Checking Domain-Level Data Quality Anomalies ---');
  
  // A. Inverted dates
  const invertedDates = await pool.query(`
    SELECT id, unique_id, bank, title, valid_from, valid_to
    FROM offers
    WHERE valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_from > valid_to;
  `);
  console.log(`Inverted Dates (validFrom > validTo): ${invertedDates.rows.length}`);
  if (invertedDates.rows.length > 0) {
    console.table(invertedDates.rows.slice(0, 10));
  }

  // B. Expired offers published as active
  const expiredActive = await pool.query(`
    SELECT id, unique_id, bank, title, valid_to, db_status
    FROM offers
    WHERE valid_to < CURRENT_DATE AND db_status = 'PUBLISHED';
  `);
  console.log(`Expired offers published as PUBLISHED: ${expiredActive.rows.length}`);
  if (expiredActive.rows.length > 0) {
    console.log(`(Sample of expired published offers):`);
    console.table(expiredActive.rows.slice(0, 10));
  }

  // C. Missing merchant or excessively long merchant (>80 chars, often raw marketing titles)
  const badMerchants = await pool.query(`
    SELECT id, unique_id, bank, title, merchant_name, LENGTH(merchant_name) as len
    FROM offers
    WHERE merchant_name IS NULL OR TRIM(merchant_name) = '' OR LENGTH(merchant_name) > 80;
  `);
  console.log(`Empty or Excessively Long Merchant Names (>80 chars): ${badMerchants.rows.length}`);
  if (badMerchants.rows.length > 0) {
    console.table(badMerchants.rows.slice(0, 15));
  }

  // D. Impossible discounts (>100% or <= 0%)
  const badDiscounts = await pool.query(`
    SELECT id, unique_id, bank, title, discount_percentage
    FROM offers
    WHERE discount_percentage IS NOT NULL AND (
      (discount_percentage ~ '^[0-9]+(\\.[0-9]+)?$' AND CAST(discount_percentage AS FLOAT) > 100) OR
      (discount_percentage ~ '^[0-9]+(\\.[0-9]+)?$' AND CAST(discount_percentage AS FLOAT) <= 0)
    );
  `);
  console.log(`Abnormal Discounts (>100% or <=0%): ${badDiscounts.rows.length}`);
  if (badDiscounts.rows.length > 0) {
    console.table(badDiscounts.rows);
  }

  // E. Card eligibility - check if generic tokens still exist in includedCards in stored offers
  const genericCardTokens = await pool.query(`
    SELECT id, unique_id, bank, card_eligibility->'includedCards' as included_cards
    FROM offers
    WHERE jsonb_path_exists(card_eligibility, '$.includedCards[*] ? (@ == "Credit" || @ == "Debit" || @ == "Credit Card" || @ == "Debit Card" || @ == "credit" || @ == "debit")');
  `);
  console.log(`Stored Offers with Generic Tokens in includedCards: ${genericCardTokens.rows.length}`);
  if (genericCardTokens.rows.length > 0) {
    console.table(genericCardTokens.rows.slice(0, 10));
  }

  // 4. Duplicate Candidates & Merge History
  const dupCandidates = await pool.query(`
    SELECT status, classification, count(*) as count
    FROM offer_duplicate_candidates
    GROUP BY status, classification;
  `);
  console.log('\n--- Duplicate Candidates Status ---');
  console.table(dupCandidates.rows);

  // 5. Golden Cases Status
  const goldenCount = await pool.query(`
    SELECT bank, field, count(*) as count
    FROM parser_golden_cases
    GROUP BY bank, field
    ORDER BY bank, field;
  `);
  console.log('\n--- Golden Cases in Database ---');
  console.table(goldenCount.rows);

  // 6. Review History
  const reviewHist = await pool.query(`
    SELECT action, actor, count(*) as count
    FROM offer_review_history
    GROUP BY action, actor;
  `);
  console.log('\n--- Review History ---');
  console.table(reviewHist.rows);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
