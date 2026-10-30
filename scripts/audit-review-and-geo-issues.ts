import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_S24AOYcNTECt@ep-weathered-forest-a1te8qsw-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false },
  });

  console.log('================================================================');
  console.log('  AUDITING REVIEW_REQUIRED OFFERS & REASONS');
  console.log('================================================================');

  // 1. Group review-required offers by bank and check rule_passed, rule_errors
  const bankReviewStats = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(*) FILTER (WHERE db_status = 'PUBLISHED') as published,
      count(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED') as review_required,
      count(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED' AND rule_passed = true) as review_rule_passed,
      count(*) FILTER (WHERE db_status = 'REVIEW_REQUIRED' AND rule_passed = false) as review_rule_failed
    FROM offers
    GROUP BY bank
    ORDER BY count(*) DESC
  `);
  console.table(bankReviewStats.rows);

  // 2. Sample common rule errors across review_required offers
  const commonErrors = await pool.query(`
    SELECT
      err->>'field' as field,
      err->>'message' as message,
      count(*) as occurrences
    FROM offers,
    LATERAL jsonb_array_elements(rule_errors) as err
    WHERE db_status = 'REVIEW_REQUIRED'
    GROUP BY err->>'field', err->>'message'
    ORDER BY count(*) DESC
    LIMIT 25
  `);
  console.log('\nTop 25 Rule Errors in REVIEW_REQUIRED offers:');
  console.table(commonErrors.rows);

  // 3. Check offers where rule_errors is empty but still REVIEW_REQUIRED
  const emptyErrorsReview = await pool.query(`
    SELECT
      bank,
      count(*) as count,
      count(*) FILTER (WHERE llm_score IS NULL) as no_llm_score,
      count(*) FILTER (WHERE llm_status IS NULL OR llm_status != 'validated') as not_llm_validated,
      count(*) FILTER (WHERE valid_to IS NULL) as missing_valid_to,
      count(*) FILTER (WHERE discount_percentage IS NULL) as missing_discount
    FROM offers
    WHERE db_status = 'REVIEW_REQUIRED' AND (rule_errors IS NULL OR jsonb_array_length(rule_errors) = 0)
    GROUP BY bank
    ORDER BY count DESC
  `);
  console.log('\nREVIEW_REQUIRED offers with NO rule errors (why are they in review?):');
  console.table(emptyErrorsReview.rows);

  // 4. Sample 5 actual rows from DFCC, People's, BOC, and HNB in REVIEW_REQUIRED
  const samples = await pool.query(`
    SELECT bank, unique_id, title, discount_percentage, valid_from, valid_to, location_scope,
           rule_passed, rule_errors, rule_warnings, raw_offer->'validityPeriods' as raw_validity,
           raw_offer->'offer'->>'discountPercentage' as raw_discount,
           raw_offer->'merchant' as raw_merchant
    FROM offers
    WHERE db_status = 'REVIEW_REQUIRED' AND bank IN ('dfcc', 'peoples', 'boc', 'combank')
    ORDER BY bank, id
    LIMIT 12
  `);
  console.log('\nSamples from low-approval banks in REVIEW_REQUIRED:');
  for (const s of samples.rows) {
    console.log(`\n[${s.bank.toUpperCase()}] ${s.unique_id}: "${s.title}"`);
    console.log(`  discount: ${s.discount_percentage}, valid: ${s.valid_from} -> ${s.valid_to}, scope: ${s.location_scope}`);
    console.log(`  rule_passed: ${s.rule_passed}, errors: ${JSON.stringify(s.rule_errors)}, warnings: ${JSON.stringify(s.rule_warnings)}`);
    console.log(`  raw_validity: ${JSON.stringify(s.raw_validity)}`);
    console.log(`  raw_merchant: ${JSON.stringify(s.raw_merchant)}`);
  }

  // 5. Audit Geo Unresolved Reasons
  console.log('\n================================================================');
  console.log('  AUDITING GEO RESOLVE ISSUES');
  console.log('================================================================');
  const geoStats = await pool.query(`
    SELECT
      bank,
      count(*) as total,
      count(*) FILTER (WHERE geo_status = 'resolved') as resolved,
      count(*) FILTER (WHERE geo_status = 'unresolved') as unresolved,
      count(*) FILTER (WHERE location_scope IN ('EXPLICIT_BRANCH', 'MULTIPLE_BRANCHES')) as physical_scope,
      count(*) FILTER (WHERE location_scope IN ('EXPLICIT_BRANCH', 'MULTIPLE_BRANCHES') AND jsonb_array_length(geo_locations) = 0) as physical_no_geo,
      count(*) FILTER (WHERE location_scope = 'UNRESOLVED') as unresolved_scope,
      count(*) FILTER (WHERE location_scope = 'ONLINE') as online_scope,
      count(*) FILTER (WHERE location_scope = 'NATIONWIDE') as nationwide_scope,
      count(*) FILTER (WHERE location_scope = 'SELECTED_OUTLETS') as selected_outlets_scope
    FROM offers
    GROUP BY bank
    ORDER BY count(*) DESC
  `);
  console.table(geoStats.rows);

  // 6. Sample offers with EXPLICIT_BRANCH / MULTIPLE_BRANCHES but 0 geo_locations
  const physicalNoGeoSamples = await pool.query(`
    SELECT bank, unique_id, title, merchant_name, merchant_location, location_scope,
           raw_offer->'merchant'->'addresses' as addresses,
           geo_status, geo_locations
    FROM offers
    WHERE location_scope IN ('EXPLICIT_BRANCH', 'MULTIPLE_BRANCHES')
      AND jsonb_array_length(geo_locations) = 0
    LIMIT 10
  `);
  console.log('\nPhysical scope offers with NO geo locations:');
  console.table(physicalNoGeoSamples.rows.map(r => ({
    bank: r.bank,
    uniqueId: r.unique_id,
    merchant: r.merchant_name?.slice(0, 20),
    location: r.merchant_location?.slice(0, 20),
    scope: r.location_scope,
    addresses: JSON.stringify(r.addresses)?.slice(0, 40)
  })));

  await pool.end();
}

main().catch(console.error);
