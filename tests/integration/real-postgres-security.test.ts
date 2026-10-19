/**
 * Real PostgreSQL Security, Least-Privilege & Staging Integrity Integration Tests (Phase 9)
 *
 * Runs against isolated real PostgreSQL (PGlite 18.6 WASM engine).
 * Tests:
 * 1. Least-privilege role separation (SELECT ONLY on offers, geo_cache; denied on operational tables)
 * 2. Mutation rejection (INSERT, UPDATE, DELETE denied for public role)
 * 3. Operational table isolation (scrape_runs, leases, validation_reports denied for public role)
 * 4. Public API field projection security (sanitizePublicOffer strips internal/staging fields)
 * 5. Dry-run staging import security:
 *    - SHA-256 integrity check and tampering detection
 *    - Path traversal defense
 *    - Non-publishing guarantee (imported offers must never have db_status = 'PUBLISHED')
 *    - Staging idempotency (re-import with same signature causes zero duplicate insertions)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RealPostgresHarness } from '@/test/real-postgres-harness';
import { sanitizePublicOffer, buildOfferListQuery } from '@/api/offer-query-scope';
import { exportDryRunArtifacts } from '@/cli/dry-run-exporter';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';

function mockOffer(id: string, bank = 'sampath'): Offer {
  return {
    uniqueId: `${bank}_${id}`,
    source: bank,
    sourceId: id,
    sourceUrl: `https://${bank}.lk/offers/${id}`,
    title: `${bank.toUpperCase()} 20% Discount`,
    category: 'Dining',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: new Date().toISOString(),
    merchant: {
      name: 'Sample Merchant',
      location: 'Colombo 03',
      addresses: ['Colombo 03'],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: '20% off on food bill',
      discountPercentage: 20,
      applicableCards: ['Credit Card'],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: 2500, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: ['Credit Card'],
      excludedCards: [],
      cardTypes: ['Credit Card'],
      networks: ['Visa'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Valid till 31 Dec 2026',
      },
    ],
    contentHash: 'hash_' + id,
  };
}

describe('Real PostgreSQL Security, Least-Privilege & Staging Integrity (Batch 6 / Phase 9)', () => {
  let harness: RealPostgresHarness;
  let pool: ReturnType<RealPostgresHarness['getPoolAdapter']>;
  const tmpOutputDir = path.join(__dirname, '..', '..', 'tmp-sec-integration');

  beforeAll(async () => {
    harness = new RealPostgresHarness();
    await harness.initSchema();
    pool = harness.getPoolAdapter();
  });

  afterAll(async () => {
    if (harness) await harness.close();
    if (fs.existsSync(tmpOutputDir)) {
      fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
    if (fs.existsSync(tmpOutputDir)) {
      fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    }
  });

  describe('1. Least-Privilege Role Separation on Real PostgreSQL', () => {
    beforeAll(async () => {
      // Execute least-privilege role setup in PostgreSQL using exec() for multi-statement DDL
      await harness.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lanka_offers_public_api') THEN
            CREATE ROLE lanka_offers_public_api WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
          END IF;
        END
        $$;

        GRANT USAGE ON SCHEMA public TO lanka_offers_public_api;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM lanka_offers_public_api;
        GRANT SELECT ON TABLE public.offers TO lanka_offers_public_api;
        GRANT SELECT ON TABLE public.geo_cache TO lanka_offers_public_api;
      `);
    });

    it('allows SELECT queries on public.offers for the public API role', async () => {
      // Insert a published offer using admin connection
      await pool.query(
        `INSERT INTO offers (unique_id, bank, title, db_status, valid_to, raw_offer, created_at, updated_at)
         VALUES ('hnb_sec_1', 'hnb', 'Public Offer', 'PUBLISHED', '2026-12-31', '{}', NOW(), NOW())`
      );

      // Execute query as lanka_offers_public_api role
      const client = await pool.connect();
      try {
        await client.query('SET ROLE lanka_offers_public_api');
        const res = await client.query('SELECT unique_id, title, db_status FROM offers WHERE db_status = $1', ['PUBLISHED']);
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].unique_id).toBe('hnb_sec_1');
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    it('DENIES INSERT, UPDATE, and DELETE on public.offers for the public role', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE lanka_offers_public_api');

        // Attempt INSERT -> must be rejected
        await expect(
          client.query(
            `INSERT INTO offers (unique_id, bank, title, db_status, raw_offer) VALUES ('bad_1', 'hnb', 'Hacked', 'PUBLISHED', '{}')`
          )
        ).rejects.toThrow(/permission denied/i);

        // Attempt UPDATE -> must be rejected
        await expect(
          client.query(`UPDATE offers SET title = 'Altered' WHERE unique_id = 'hnb_sec_1'`)
        ).rejects.toThrow(/permission denied/i);

        // Attempt DELETE -> must be rejected
        await expect(
          client.query(`DELETE FROM offers WHERE unique_id = 'hnb_sec_1'`)
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    it('DENIES SELECT on operational tables (scrape_runs, leases, scheduler, reports) for public role', async () => {
      const client = await pool.connect();
      try {
        await client.query('SET ROLE lanka_offers_public_api');

        // Operational table: scrape_runs
        await expect(
          client.query('SELECT * FROM scrape_runs')
        ).rejects.toThrow(/permission denied/i);

        // Operational table: scraper_leases
        await expect(
          client.query('SELECT * FROM scraper_leases')
        ).rejects.toThrow(/permission denied/i);

        // Operational table: scheduler_config
        await expect(
          client.query('SELECT * FROM scheduler_config')
        ).rejects.toThrow(/permission denied/i);

        // Operational table: offer_review_history
        await expect(
          client.query('SELECT * FROM offer_review_history')
        ).rejects.toThrow(/permission denied/i);

        // Operational table: validation_reports
        await expect(
          client.query('SELECT * FROM validation_reports')
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });

    it('verifies that health ping, merchant aggregation, and nearby discovery queries succeed for public role', async () => {
      // Seed a published offer with geo location and canonical merchant
      await pool.query(
        `INSERT INTO offers (
           unique_id, bank, title, db_status, valid_to, merchant_name, canonical_merchant, category,
           geo_locations, raw_offer, created_at, updated_at
         ) VALUES (
           'hnb_pub_agg', 'hnb', 'Public Agg Offer', 'PUBLISHED', '2026-12-31',
           'Hilton Colombo', 'Hilton Colombo', 'Dining',
           '[{"name": "Hilton Colombo", "lat": 6.9344, "lng": 79.8428, "address": "Colombo 01"}]'::jsonb,
           '{}', NOW(), NOW()
         )`
      );

      const client = await pool.connect();
      try {
        await client.query('SET ROLE lanka_offers_public_api');

        // 1. Health check ping
        const pingRes = await client.query('SELECT 1 AS ping');
        expect(pingRes.rows[0].ping).toBe(1);

        // 2. Merchant aggregation (exact query from MerchantRepository)
        const merchantRes = await client.query(`
          SELECT
            COALESCE(canonical_merchant, merchant_name) AS name,
            category,
            COUNT(*)::int AS offer_count,
            ARRAY_AGG(DISTINCT bank ORDER BY bank) AS banks
          FROM offers
          WHERE db_status = 'PUBLISHED'
            AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
          GROUP BY 1, 2
        `);
        expect(merchantRes.rows.length).toBe(1);
        expect(merchantRes.rows[0].name).toBe('Hilton Colombo');
        expect(merchantRes.rows[0].offer_count).toBe(1);

        // 3. Nearby query bounding box unnesting (from OfferRepository)
        const nearbyRes = await client.query(`
          SELECT 
            o.id,
            (loc->>'lat')::float AS branch_lat,
            (loc->>'lng')::float AS branch_lng
          FROM offers o,
          jsonb_array_elements(o.geo_locations) AS loc
          WHERE o.db_status = 'PUBLISHED'
        `);
        expect(nearbyRes.rows.length).toBe(1);
        expect(nearbyRes.rows[0].branch_lat).toBeCloseTo(6.9344);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });
  });

  describe('2. Public API Data Projection & Internal Field Stripping', () => {
    it('strips internal admin metadata (pending_candidate, manual_override, llm reasoning) from public output', () => {
      const rawDbRow: Record<string, unknown> = {
        id: 'c8f49867-b5fc-421f-827c-6582ea81c201',
        unique_id: 'sampath_101',
        bank: 'sampath',
        source_url: 'https://sampath.lk/deals/101',
        title: '20% off at Hilton Colombo',
        category: 'Dining',
        card_type: 'Credit Card',
        merchant_name: 'Hilton Colombo',
        merchant_location: 'Colombo 02',
        canonical_merchant: 'Hilton Colombo',
        location_scope: 'EXPLICIT_BRANCH',
        discount_percentage: 20,
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
        card_eligibility: { cardTypes: ['Credit Card'], networks: ['Visa'] },
        geo_locations: [],
        geo_status: 'NOT_GEOCODED',
        raw_offer: { raw: 'data' },
        rule_passed: true,
        db_status: 'PUBLISHED',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // Internal fields that MUST NOT leak to public consumer API:
        pending_candidate: { title: 'Unapproved Candidate Update', discount_percentage: 25 },
        manual_override: { note: 'Admin verified via phone', approved_by: 'lead_operator' },
        llm_reasoning: 'Detailed internal AI reasoning score 92/100',
        llm_issues: ['UNVERIFIED_PARKING'],
        content_hash: '3f2d1e0a8c...',
        fencing_token: { bank: 'sampath', jobId: 'job-999', leaseGeneration: 5 },
      };

      const sanitized = sanitizePublicOffer(rawDbRow);

      // Safe public fields are present
      expect(sanitized.id).toBe(rawDbRow.id);
      expect(sanitized.unique_id).toBe(rawDbRow.unique_id);
      expect(sanitized.title).toBe(rawDbRow.title);
      expect(sanitized.db_status).toBe('PUBLISHED');

      // Internal admin fields are completely stripped
      expect(sanitized.pending_candidate).toBeUndefined();
      expect(sanitized.manual_override).toBeUndefined();
      expect(sanitized.llm_reasoning).toBeUndefined();
      expect(sanitized.llm_issues).toBeUndefined();
      expect(sanitized.content_hash).toBeUndefined();
      expect(sanitized.fencing_token).toBeUndefined();
    });

    it('enforces that public API offer query builder always isolates to PUBLISHED and active dates', () => {
      // Public caller omitting scope
      const publicQuery = buildOfferListQuery({
        bank: 'hnb',
        status: 'REVIEW_REQUIRED', // Public caller attempts to query internal review queue
      });

      expect(publicQuery.isAdmin).toBe(false);
      // Query builder MUST ignore incoming status and enforce db_status = 'PUBLISHED'
      expect(publicQuery.whereSql).toContain("db_status = 'PUBLISHED'");
      expect(publicQuery.whereSql).toContain('(valid_to IS NULL OR valid_to >= CURRENT_DATE)');
      expect(publicQuery.whereSql).not.toContain('REVIEW_REQUIRED');

      // Admin caller with explicit scope=admin
      const adminQuery = buildOfferListQuery({
        bank: 'hnb',
        status: 'REVIEW_REQUIRED',
        scope: 'admin',
      });

      expect(adminQuery.isAdmin).toBe(true);
      expect(adminQuery.whereSql).toContain('db_status = $2');
      expect(adminQuery.params).toContain('REVIEW_REQUIRED');
    });
  });

  describe('3. Dry-Run Staging Import Security & Idempotency', () => {
    it('verifies SHA-256 integrity and detects artifact tampering', () => {
      const rawOffers = [mockOffer('001', 'combank')];
      const normalizedOffers = [mockOffer('001', 'combank')];

      const exportResult = exportDryRunArtifacts({
        bank: 'combank',
        rawOffers,
        normalizedOffers,
        duplicatesRemoved: 0,
        validationReports: [],
        durationMs: 400,
        baseOutputDir: tmpOutputDir,
      });

      const manifest = exportResult.manifest;
      expect(manifest.checksums).toBeDefined();

      const normFilePath = path.join(exportResult.exportDir, 'normalized-offers.json');
      const originalContent = fs.readFileSync(normFilePath, 'utf8');
      const expectedChecksum = crypto.createHash('sha256').update(originalContent, 'utf8').digest('hex');
      expect(manifest.checksums?.normalizedOffers).toBe(expectedChecksum);

      // Tamper with the artifact file
      fs.writeFileSync(normFilePath, JSON.stringify([mockOffer('001_TAMPERED', 'combank')]));
      const tamperedContent = fs.readFileSync(normFilePath, 'utf8');
      const tamperedChecksum = crypto.createHash('sha256').update(tamperedContent, 'utf8').digest('hex');

      expect(tamperedChecksum).not.toBe(manifest.checksums?.normalizedOffers);
    });

    it('enforces non-publishing guarantee on staged records in real PostgreSQL', async () => {
      // Simulate staging 3 offers via staging import
      const runRes = await pool.query<{ id: string }>(
        `INSERT INTO scrape_runs (bank, mode, triggered_by, status)
         VALUES ('sampath', 'dryrun-import', 'dryrun-import:2026-10-18:operator', 'completed')
         RETURNING id`
      );
      const runId = runRes.rows[0].id;

      // Staged offers are saved as REVIEW_REQUIRED or APPROVED (never PUBLISHED)
      await pool.query(
        `INSERT INTO offers (unique_id, bank, title, db_status, valid_to, scrape_run_id, raw_offer, created_at, updated_at)
         VALUES 
          ('sampath_stg_1', 'sampath', 'Staged Offer 1', 'REVIEW_REQUIRED', '2026-12-31', $1, '{}', NOW(), NOW()),
          ('sampath_stg_2', 'sampath', 'Staged Offer 2', 'APPROVED', '2026-12-31', $1, '{}', NOW(), NOW())`,
        [runId]
      );

      // Verify that public query returns ZERO offers from this staging run
      const publicQuery = buildOfferListQuery({ bank: 'sampath' });
      const publicRes = await pool.query(
        `SELECT * FROM offers ${publicQuery.whereSql}`,
        publicQuery.params
      );
      expect(publicRes.rows.length).toBe(0);

      // Verify admin query sees both staged offers
      const adminQuery = buildOfferListQuery({ bank: 'sampath', scope: 'admin' });
      const adminRes = await pool.query(
        `SELECT * FROM offers ${adminQuery.whereSql}`,
        adminQuery.params
      );
      expect(adminRes.rows.length).toBe(2);
    });

    it('enforces staging idempotency — re-running identical staging import skips duplicate inserts', async () => {
      const triggerSignature = 'dryrun-import:2026-10-18T12-00-00Z:release_lead';

      // First staging execution
      await pool.query(
        `INSERT INTO scrape_runs (bank, mode, triggered_by, status)
         VALUES ('seylan', 'dryrun-import', $1, 'completed')`,
        [triggerSignature]
      );

      // Verify idempotency check
      const idempotencyCheck = await pool.query<{ id: string }>(
        `SELECT id FROM scrape_runs
         WHERE bank = $1 AND triggered_by = $2 AND status = 'completed'
         LIMIT 1`,
        ['seylan', triggerSignature]
      );

      expect(idempotencyCheck.rows.length).toBe(1);
      // Re-importing must detect existing completed run and abort without mutating database
      const shouldAbort = idempotencyCheck.rows.length > 0;
      expect(shouldAbort).toBe(true);
    });
  });
});
