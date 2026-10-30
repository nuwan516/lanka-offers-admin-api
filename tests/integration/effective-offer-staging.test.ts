import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { Offer, PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { UnifiedOfferOrchestrator } from '../../src/parsing/validators/unified-offer-orchestrator';
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
import { buildOfferListQuery } from '../../src/api/offer-query-scope';

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

describe('EffectiveOffer Persistence & Expiry Separation Integration Tests', () => {
  const bank = 'hnb';
  const leaseToken: FencingToken = { bank, jobId: 'worker-effective-test', leaseGeneration: 1 };

  beforeAll(async () => {
    harness = new RealPostgresHarness();
    poolAdapter = harness.getPoolAdapter();
    await harness.initSchema();
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-eff', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  function createSampleOffer(overrides: Partial<Offer> = {}): Offer {
    const today = new Date().toISOString().split('T')[0];
    const base: Offer = {
      uniqueId: `hnb-eff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'hnb',
      sourceId: 'sample-901',
      sourceUrl: 'https://www.hnb.net/promotions/sample-offer',
      title: '25% off at Spa Ceylon with HNB Credit Cards',
      category: 'Wellness',
      categoryId: 1,
      cardType: 'Credit',
      scrapedAt: new Date().toISOString(),
      merchant: {
        name: 'Spa Ceylon - Colombo 03, Kandy, Galle Fort',
        location: 'Colombo, Sri Lanka',
        addresses: ['100 Galle Road, Colombo 03'],
        phone: [],
        website: 'https://spaceylon.com',
        email: [],
        logo: null,
      },
      offer: {
        description: 'Get 25% discount on all wellness treatments with HNB Mastercard and Visa Credit Cards.',
        discountPercentage: 25,
        applicableCards: ['Mastercard', 'Visa'],
        bookingRequired: false,
        restrictions: ['Min spend Rs. 5000'],
        specialConditions: [],
        generalTerms: ['Terms apply'],
      },
      installmentPlans: [],
      transactionRange: { min: 5000, max: 25000, currency: 'LKR' },
      cardEligibility: {
        cardTypes: ['Credit'],
        networks: ['Visa', 'Mastercard'],
        includedCards: ['HNB Mastercard Platinum', 'HNB Visa Signature'],
        excludedCards: ['Debit'],
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
      rawHtml: '<p>Merchant: Spa Ceylon</p><p>25% discount with HNB Credit Cards</p>',
      contentHash: '',
    };
    const merged = { ...base, ...overrides };
    merged.contentHash = computeOfferContentHash(merged);
    return merged;
  }

  it('Requirement 1: stores validated corrections in candidate columns while keeping raw_offer strictly immutable', async () => {
    const rawOffer = createSampleOffer();
    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Mock an orchestrator run where merchant is normalized
    const orchestrator = new UnifiedOfferOrchestrator({ geoMode: 'deterministic-only' });
    const report = await orchestrator.validateOffer(rawOffer, []);

    // Create an effective offer with a validated merchant name correction
    const correctedOffer: Offer = JSON.parse(JSON.stringify(report.effectiveOffer));
    correctedOffer.merchant.name = 'Spa Ceylon'; // Normalized name
    correctedOffer.contentHash = computeOfferContentHash(correctedOffer);

    // Scraper persists correctedOffer with rawOffer preserved
    const result = await upsertOffer(
      correctedOffer,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOffer
    );
    expect(result.isNew).toBe(true);

    // Verify DB columns reflect validated correction
    const dbRow = await poolAdapter.query<{
      merchant_name: string;
      raw_offer: Record<string, any>;
      db_status: string;
    }>(
      `SELECT merchant_name, raw_offer, db_status FROM offers WHERE id = $1`,
      [result.id]
    );

    expect(dbRow.rows[0].merchant_name).toBe('Spa Ceylon'); // Staged candidate has corrected value
    expect(dbRow.rows[0].raw_offer.merchant.name).toBe('Spa Ceylon - Colombo 03, Kandy, Galle Fort'); // Raw evidence is immutable!
  });

  it('Requirement 1: does not apply rejected corrections', async () => {
    const rawOffer = createSampleOffer();
    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Unified orchestrator with deterministic fallback
    const orchestrator = new UnifiedOfferOrchestrator({
      geoMode: 'deterministic-only',
      llmMode: 'deterministic-fallback',
    });
    const report = await orchestrator.validateOffer(rawOffer, []);

    // Even if a rejected proposal was generated, effectiveOffer maintains the true evidence-grounded discount
    expect(report.effectiveOffer.offer.discountPercentage).toBe(25);

    const result = await upsertOffer(
      report.effectiveOffer,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOffer
    );

    const dbRow = await poolAdapter.query<{ discount_percentage: string }>(
      `SELECT discount_percentage FROM offers WHERE id = $1`,
      [result.id]
    );
    expect(dbRow.rows[0].discount_percentage).toBe('25');
  });

  it('Requirement 1: protects existing published records and stages candidate updates into pending_candidate', async () => {
    const rawOffer = createSampleOffer({ title: 'Original Published Offer' });
    const runId1 = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    // Initial insert and publish
    const initialRes = await upsertOffer(
      rawOffer,
      runId1,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOffer
    );
    await syncApprovedOffer(initialRes.id, leaseToken);

    // Verify published
    const pubCheck = await poolAdapter.query<{ db_status: string; title: string }>(
      `SELECT db_status, title FROM offers WHERE id = $1`,
      [initialRes.id]
    );
    expect(pubCheck.rows[0].db_status).toBe('PUBLISHED');
    expect(pubCheck.rows[0].title).toBe('Original Published Offer');

    // Bank updates promotion content
    const updatedOffer = { ...rawOffer, title: 'Updated Promotion 30% Off' };
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

    // Live columns must remain unchanged, candidate staged into pending_candidate
    const afterScrape = await poolAdapter.query<{
      db_status: string;
      title: string;
      pending_candidate: any;
      pending_lifecycle_status: string;
      pending_change_status: string;
    }>(
      `SELECT db_status, title, pending_candidate, pending_lifecycle_status, pending_change_status
       FROM offers WHERE id = $1`,
      [initialRes.id]
    );

    expect(afterScrape.rows[0].db_status).toBe('PUBLISHED');
    expect(afterScrape.rows[0].title).toBe('Original Published Offer'); // Protected!
    expect(afterScrape.rows[0].pending_candidate.title).toBe('Updated Promotion 30% Off'); // Safely staged!
    expect(afterScrape.rows[0].pending_lifecycle_status).toBe('APPROVED');
    expect(afterScrape.rows[0].pending_change_status).toBe('CHANGED');
  });

  it('Requirement 1: preserves manual overrides across subsequent scrapes', async () => {
    const rawOffer = createSampleOffer();
    const runId1 = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    const initialRes = await upsertOffer(
      rawOffer,
      runId1,
      { lifecycleStatus: 'REVIEW_REQUIRED' },
      leaseToken,
      rawOffer
    );

    // Admin applies manual override
    await saveManualCorrection(
      initialRes.id,
      { 'merchant.name': 'Spa Ceylon Ayurveda Signature' },
      'operator-alice',
      'Normalized to global brand guide'
    );

    // Verify manual override is stored
    const check1 = await poolAdapter.query<{ manual_override: Record<string, any> }>(
      `SELECT manual_override FROM offers WHERE id = $1`,
      [initialRes.id]
    );
    expect(check1.rows[0].manual_override['merchant.name']).toBe('Spa Ceylon Ayurveda Signature');

    // Subsequent scrape runs with modified raw content
    const rescarpedOffer = { ...rawOffer, title: 'Spa Ceylon Festive Weekend Deal' };
    rescarpedOffer.contentHash = computeOfferContentHash(rescarpedOffer);
    const runId2 = await createScrapeRun(bank, 'full', 'cli', leaseToken);

    await upsertOffer(
      rescarpedOffer,
      runId2,
      { lifecycleStatus: 'REVIEW_REQUIRED' },
      leaseToken,
      rescarpedOffer
    );

    // Verify manual override remained untouched!
    const check2 = await poolAdapter.query<{ manual_override: Record<string, any> }>(
      `SELECT manual_override FROM offers WHERE id = $1`,
      [initialRes.id]
    );
    expect(check2.rows[0].manual_override['merchant.name']).toBe('Spa Ceylon Ayurveda Signature');
  });

  it('Requirement 2: stages valid but expired promotions as EXPIRED, not REJECTED, and excludes them from public queries', async () => {
    // Valid extraction structure, but expired in 2025
    const expiredOffer = createSampleOffer({
      uniqueId: 'hnb-expired-hist-1',
      validityPeriods: [
        {
          validFrom: '2024-01-01',
          validTo: '2025-01-01', // Expired
          periodType: PeriodType.OFFER,
          recurrenceType: RecurrenceType.DAILY,
          recurrenceDays: null,
          timeWindow: null,
          exclusionDays: null,
          blackoutPeriods: null,
          exclusionNotes: null,
          rawPeriodText: 'Ended 01 Jan 2025',
        },
      ],
    });

    const orchestrator = new UnifiedOfferOrchestrator({ geoMode: 'deterministic-only' });
    const report = await orchestrator.validateOffer(expiredOffer, []);

    // Quality gate status must be EXPIRED, not INVALID
    expect(report.qualityGate.status).toBe('EXPIRED');
    expect(report.qualityGate.criticalFieldsSupported).toBe(true);
    expect(report.qualityGate.reasons[0]).toContain('expired');

    const runId = await createScrapeRun(bank, 'full', 'cli', leaseToken);
    const upsertRes = await upsertOffer(
      report.effectiveOffer,
      runId,
      { lifecycleStatus: 'EXPIRED' },
      leaseToken,
      expiredOffer
    );

    // Verify DB row
    const dbRow = await poolAdapter.query<{ db_status: string }>(
      `SELECT db_status FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(dbRow.rows[0].db_status).toBe('EXPIRED');

    // Public API query must NOT return expired offer
    const publicQuery = buildOfferListQuery({ bank });
    const publicResults = await poolAdapter.query(
      `SELECT id FROM offers ${publicQuery.whereSql}`,
      publicQuery.params
    );
    expect(publicResults.rows.some((r: any) => r.id === upsertRes.id)).toBe(false);

    // Admin query with status=EXPIRED must locate the historical promotion
    const adminQuery = buildOfferListQuery({ bank, scope: 'admin', status: 'EXPIRED' });
    const adminResults = await poolAdapter.query(
      `SELECT id FROM offers ${adminQuery.whereSql}`,
      adminQuery.params
    );
    expect(adminResults.rows.some((r: any) => r.id === upsertRes.id)).toBe(true);
  });
});
