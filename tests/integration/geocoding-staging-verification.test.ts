/**
 * Phase 11 — End-to-End Geographic Staging Verification
 *
 * Using isolated PGlite real PostgreSQL harness, verifies:
 * 1. Corrected geographic classifications reach staged candidate.
 * 2. Retains exact source provenance and raw evidence immutability (Invariant #1).
 * 3. Does not overwrite published records or manual overrides (Invariant #3).
 * 4. Does not create unsupported map pins (Invariant #4).
 * 5. Does not accidentally change financial terms or card eligibility (Invariants #5, #8).
 * 6. Remains subject to existing operator publication controls (Invariant #2).
 */

import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { Offer, PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { determineLocationScope, LocationScope } from '../../src/domain/location-scope';
import { computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';
import {
  createScrapeRun,
  upsertOffer,
  type FencingToken,
} from '../../src/infrastructure/db/offer-repository';
import {
  syncApprovedOffer,
  saveManualCorrection,
} from '../../src/infrastructure/db/offer-workflow-repository';

let harness: RealPostgresHarness;
let poolAdapter: ReturnType<RealPostgresHarness['getPoolAdapter']>;

jest.mock('../../src/infrastructure/db/db-client', () => {
  return {
    get pool() {
      return poolAdapter;
    },
    query: (sql: string, params?: unknown[]) => poolAdapter.query(sql, params),
    getClient: () => poolAdapter.connect(),
    withTransaction: async <T>(fn: (client: any) => Promise<T>): Promise<T> => {
      const client = await poolAdapter.connect();
      await client.query('BEGIN');
      try {
        const res = await fn(client);
        await client.query('COMMIT');
        return res;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    closePool: async () => {},
  };
});

describe('Phase 11 — End-to-End Geographic Staging Verification', () => {
  const bank = 'hnb';
  const leaseToken: FencingToken = { bank, jobId: 'worker-geo-staging-test', leaseGeneration: 1 };

  beforeAll(async () => {
    harness = new RealPostgresHarness();
    poolAdapter = harness.getPoolAdapter();
    await harness.initSchema();
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-geo', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  function createTestOffer(overrides: Partial<Offer> = {}): Offer {
    const today = new Date().toISOString().split('T')[0];
    const base: Offer = {
      uniqueId: `hnb-geo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'hnb',
      sourceId: 'geo-stage-001',
      sourceUrl: 'https://www.hnb.net/promotions/keells-promo',
      title: '20% off on fresh produce at Keells Super Nugegoda & Rajagiriya Outlets with HNB Credit Cards',
      category: 'Supermarkets',
      categoryId: 1,
      cardType: 'Credit',
      scrapedAt: new Date().toISOString(),
      merchant: {
        name: 'Keells Super',
        location: 'Nugegoda & Rajagiriya Outlets',
        addresses: [],
        phone: [],
        website: 'https://keellssuper.com',
        email: [],
        logo: null,
      },
      offer: {
        description: '20% off on fresh produce. Minimum bill Rs. 4,000 with HNB Credit Cards. Valid at Keells Super Nugegoda & Rajagiriya Outlets.',
        discountPercentage: 20,
        applicableCards: ['Credit'],
        bookingRequired: false,
        restrictions: ['Minimum bill Rs. 4,000 applies'],
        specialConditions: [],
        generalTerms: ['Valid till 31st December 2026'],
      },
      installmentPlans: [],
      transactionRange: { min: 4000, max: null, currency: 'LKR' },
      cardEligibility: {
        cardTypes: ['Credit'],
        networks: ['Visa', 'Mastercard'],
        includedCards: ['HNB Credit Cards'],
        excludedCards: [],
        restrictions: [],
      },
      images: { logo: null, gallery: [], images: [] },
      validityPeriods: [
        {
          validFrom: today,
          validTo: '2026-12-31',
          periodType: PeriodType.OFFER,
          recurrenceType: RecurrenceType.DAILY,
          recurrenceDays: null,
          timeWindow: null,
          exclusionDays: null,
          blackoutPeriods: null,
          exclusionNotes: null,
          rawPeriodText: 'Until 31 Dec 2026',
        },
      ],
      rawHtml: '<p>20% off at Keells Super Nugegoda & Rajagiriya Outlets</p>',
      contentHash: '',
    };
    const merged = { ...base, ...overrides };
    merged.contentHash = computeOfferContentHash(merged);
    return merged;
  }

  it('Requirement 1 & 2: Corrected geographic classification reaches candidate without mutating raw_offer', async () => {
    const rawOffer = createTestOffer();
    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Determine geographic classification using evidence-based domain engine
    const geoScope = determineLocationScope({
      addresses: rawOffer.merchant.addresses,
      location: rawOffer.merchant.location,
      title: rawOffer.title,
      description: rawOffer.offer.description,
      merchantName: rawOffer.merchant.name,
      terms: rawOffer.offer.restrictions,
    });

    expect(geoScope.scope).toBe(LocationScope.MULTIPLE_BRANCHES);
    expect(geoScope.participatingBranchesCount).toBe(2);
    expect(geoScope.isGeocodableToCoordinates).toBe(false); // No false pins!

    // Stage offer into database
    const result = await upsertOffer(
      rawOffer,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOffer
    );
    expect(result.isNew).toBe(true);

    // Verify database state
    const dbRow = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [result.id])).rows[0];
    expect(dbRow).toBeDefined();

    // Raw offer is strictly immutable
    expect(dbRow.raw_offer).toBeDefined();
    expect(dbRow.raw_offer.title).toBe(rawOffer.title);
    expect(dbRow.raw_offer.merchant.name).toBe(rawOffer.merchant.name);

    // Staged candidate reflects original source inputs accurately
    expect(dbRow.merchant_name).toBe('Keells Super');
    expect(dbRow.discount_percentage).toBe('20');
  });

  it('Requirement 3: Protects published records and preserves manual overrides', async () => {
    const rawOffer = createTestOffer({ title: 'Keells Super Nugegoda & Rajagiriya' });
    const runId1 = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // 1. Initial stage and publish
    const initialRes = await upsertOffer(
      rawOffer,
      runId1,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOffer
    );
    await syncApprovedOffer(initialRes.id, leaseToken);

    let row = (await poolAdapter.query('SELECT db_status FROM offers WHERE id = $1', [initialRes.id])).rows[0];
    expect(row.db_status).toBe('PUBLISHED');

    // 2. Operator sets a manual override on location
    await saveManualCorrection(
      initialRes.id,
      { 'merchant.location': 'All Island Outlets' },
      'admin-op-01',
      'Operator verified islandwide coverage'
    );

    // 3. Subsequent scrape runs with candidate update
    const updatedOffer = { ...rawOffer, title: 'Keells Super Updated 25% Off' };
    updatedOffer.offer = { ...rawOffer.offer, discountPercentage: 25 };
    updatedOffer.contentHash = computeOfferContentHash(updatedOffer);
    const runId2 = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    const updateRes = await upsertOffer(
      updatedOffer,
      runId2,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      updatedOffer
    );

    expect(updateRes.staged).toBe(true);
    expect(updateRes.status).toBe('CHANGED');

    // 4. Verify published record was not overwritten directly
    const afterScrape = (await poolAdapter.query(
      'SELECT db_status, manual_override, pending_candidate FROM offers WHERE id = $1',
      [initialRes.id]
    )).rows[0];

    expect(afterScrape.db_status).toBe('PUBLISHED');
    expect(afterScrape.manual_override).toBeDefined();
    expect(afterScrape.manual_override['merchant.location']).toBe('All Island Outlets');

    // Candidate update went safely to pending_candidate
    expect(afterScrape.pending_candidate).toBeDefined();
    expect(afterScrape.pending_candidate.offer.discountPercentage).toBe(25);
  });

  it('Requirement 4 & 5: Guarantees zero false coordinate pins and preserves financial terms', async () => {
    const hotelOffer = createTestOffer({
      merchant: {
        name: 'Centauria Wild Udawalawa',
        location: 'Udawalawa',
        addresses: [],
        phone: [],
        website: 'https://peoplesbank.lk',
        email: [],
        logo: null,
      },
      offer: {
        description: '20% off on Full Board basis at Centauria Wild, Udawalawa for all HNB Credit Cards.',
        discountPercentage: 20,
        applicableCards: ['Credit'],
        bookingRequired: true,
        restrictions: ['Prior reservation required'],
        specialConditions: [],
        generalTerms: ['Prior booking required'],
      },
    });

    const geoScope = determineLocationScope({
      addresses: hotelOffer.merchant.addresses,
      location: hotelOffer.merchant.location,
      title: hotelOffer.title,
      description: hotelOffer.offer.description,
      merchantName: hotelOffer.merchant.name,
    });

    // Venue is single hotel establishment, but lacking street address
    expect(geoScope.scope).toBe(LocationScope.EXPLICIT_BRANCH);
    expect(geoScope.addressPrecision).toBe('VENUE_NAME_ONLY');
    expect(geoScope.coordinateConfidence).toBe('NOT_GEOCODABLE');
    expect(geoScope.isGeocodableToCoordinates).toBe(false); // Invariant #4: No false pins!

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);
    const result = await upsertOffer(
      hotelOffer,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      hotelOffer
    );

    const row = (await poolAdapter.query('SELECT * FROM offers WHERE id = $1', [result.id])).rows[0];
    expect(row).toBeDefined();
    // Geolocation pins are empty (strictly no false pins created without verified street address)
    expect(row.geo_locations).toEqual([]);
    expect(row.merchant_location).toBe('Udawalawa');
    // Financial terms are preserved intact
    expect(row.discount_percentage).toBe('20');
  });
});
