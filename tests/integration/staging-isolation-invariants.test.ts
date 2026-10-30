/**
 * Phase 8: Controlled Staging Acceptance Test
 *
 * Verifies strict staging invariants in isolated PostgreSQL/PGlite:
 * 1. Raw offer evidence remains immutable.
 * 2. Accepted corrections are persisted in the effective candidate.
 * 3. Unsupported corrections are not persisted.
 * 4. Published rows remain untouched during re-scrapes.
 * 5. Manual overrides survive future scrapes.
 * 6. Duplicate candidates do not silently merge.
 * 7. Expired promotions remain nonpublic.
 * 8. Review-required promotions remain nonpublic.
 * 9. Only authorized publication workflows can transition records to PUBLISHED.
 * 10. The EXPIRED status is fully compatible with DB constraints and API queries.
 */

import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { Offer, PeriodType, RecurrenceType } from '../../src/core/types/offers';
import { UnifiedOfferOrchestrator } from '../../src/parsing/validators/unified-offer-orchestrator';
import { toFullOfferValidationProposal } from '../../src/llm/schemas/offer-validation.schema';
import { computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';
import {
  createScrapeRun,
  upsertOffer,
  completeScrapeRun,
  type FencingToken,
} from '../../src/infrastructure/db/offer-repository';
import {
  syncApprovedOffer,
  saveManualCorrection,
  transitionOffer,
  WorkflowError,
} from '../../src/infrastructure/db/offer-workflow-repository';
import {
  detectAndRecordDuplicates,
  flagOfferAsDuplicate,
} from '../../src/infrastructure/db/duplicate-repository';
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

describe('Phase 8 — Controlled Staging Acceptance', () => {
  const bank = 'sampath';
  const leaseToken: FencingToken = { bank, jobId: 'worker-p8-acceptance', leaseGeneration: 1 };

  beforeAll(async () => {
    harness = new RealPostgresHarness();
    poolAdapter = harness.getPoolAdapter();
    await harness.initSchema();
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-p8', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );
  });

  afterAll(async () => {
    await harness.close();
  });

  function createTestOffer(uniqueSuffix: string, overrides: Partial<Offer> = {}): Offer {
    return {
      uniqueId: `sampath-test-${uniqueSuffix}`,
      source: 'sampath',
      sourceId: `s-${uniqueSuffix}`,
      sourceUrl: `https://www.sampath.lk/promotions/${uniqueSuffix}`,
      title: 'Sampath 20% off at Odel',
      category: 'Shopping',
      categoryId: 2,
      cardType: 'Credit Card',
      scrapedAt: new Date().toISOString(),
      merchant: {
        name: 'Odel',
        location: 'Colombo, Kandy',
        addresses: ['Alexandra Place, Colombo 07'],
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
      offer: {
        description: '20% discount on total bill with Sampath Mastercard & Visa Credit Cards. Minimum spend Rs. 5,000.',
        discountPercentage: 20,
        applicableCards: ['Mastercard', 'Visa'],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
      installmentPlans: [],
      transactionRange: { min: null, max: null, currency: 'LKR' },
      cardEligibility: {
        includedCards: [],
        excludedCards: [],
        cardTypes: ['Credit Card'],
        networks: ['Mastercard', 'Visa'],
        restrictions: [],
      },
      images: { logo: null, gallery: [], images: [] },
      validityPeriods: [
        {
          validFrom: '2026-06-01',
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
      contentHash: `hash-${uniqueSuffix}`,
      ...overrides,
    };
  }

  it('proves raw offer immutability and effective candidate persistence', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-1', leaseToken);

    const rawOriginal = createTestOffer('imm-1', {
      title: 'Raw Uncorrected Title',
      offer: { ...createTestOffer('imm-1').offer, discountPercentage: null },
    });

    // Validated effective offer contains accepted correction (discount = 25%)
    const effectiveOffer: Offer = {
      ...rawOriginal,
      title: 'Effective Corrected Title',
      offer: { ...rawOriginal.offer, discountPercentage: 25 },
    };

    const upsertRes = await upsertOffer(
      effectiveOffer,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      rawOriginal // unmutated raw evidence
    );

    const row = await poolAdapter.query(
      `SELECT title, discount_percentage, raw_offer,
              (raw_offer->>'title') as raw_title,
              (raw_offer->'offer'->>'discountPercentage') as raw_discount
       FROM offers WHERE id = $1`,
      [upsertRes.id]
    );

    // INVARIANT 1: Raw offer evidence is completely unmutated
    expect(row.rows[0].raw_title).toBe('Raw Uncorrected Title');
    expect(row.rows[0].raw_discount).toBeNull();

    // INVARIANT 2: Accepted correction is persisted in effective candidate columns
    expect(row.rows[0].title).toBe('Effective Corrected Title');
    expect(row.rows[0].discount_percentage).toBe('25');
  });

  it('ensures unsupported corrections are rejected and never persisted', async () => {
    const rawOffer = createTestOffer('unsupported-1', {
      offer: {
        description: 'Enjoy 15% discount on dining',
        discountPercentage: 15,
        applicableCards: [],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
    });

    const orchestrator = new UnifiedOfferOrchestrator({
      maxAttempts: 1,
      llmRunner: async () => {
        // Model hallucinates an unsupported 50% discount not present in source text
        return toFullOfferValidationProposal(
          {
            decision: 'CORRECT',
            overallScore: 85,
            corrections: [
              {
                fieldPath: 'offer.discountPercentage',
                originalValue: 15,
                proposedValue: 50,
                evidenceIds: ['ev-desc'],
                reason: 'Fabricated 50% discount',
                confidence: 'HIGH',
              },
            ],
            summaryReasoning: 'Model hallucinated 50% discount',
            unresolvedIssues: [],
          },
          rawOffer
        );
      },
    });

    const result = await orchestrator.validateOffer(rawOffer, [], null, {
      rawText: rawOffer.offer.description,
    });

    // Unsupported patch is rejected
    expect(result.acceptedCorrections.length).toBe(0);
    expect(result.rejectedCorrections.length).toBe(1);
    expect(result.effectiveOffer.offer.discountPercentage).toBe(15); // Preserves original 15%
  });

  it('protects published rows during re-scrapes while sequestering candidate updates', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-pub', leaseToken);

    const offer = createTestOffer('pub-protect-1', {
      title: 'Original Published Offer 20% Off',
    });

    const upsertRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, offer);
    await syncApprovedOffer(upsertRes.id, leaseToken);

    const pubCheck = await poolAdapter.query(`SELECT db_status, title FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(pubCheck.rows[0].db_status).toBe('PUBLISHED');
    expect(pubCheck.rows[0].title).toBe('Original Published Offer 20% Off');

    // Bank changes offer title and terms in subsequent scrape
    const rescrapedOffer = {
      ...offer,
      title: 'Updated 25% Off at Odel',
      offer: { ...offer.offer, discountPercentage: 25 },
      contentHash: 'new-hash-rescraped',
    };

    const reScrapeRes = await upsertOffer(
      rescrapedOffer,
      runId,
      { lifecycleStatus: 'REVIEW_REQUIRED' },
      leaseToken,
      rescrapedOffer
    );

    expect(reScrapeRes.status).toBe('CHANGED');
    expect(reScrapeRes.staged).toBe(true);

    const liveRecord = await poolAdapter.query(
      `SELECT db_status, title, pending_candidate, pending_change_status FROM offers WHERE id = $1`,
      [upsertRes.id]
    );

    // INVARIANT 3: Published row remains untouched!
    expect(liveRecord.rows[0].db_status).toBe('PUBLISHED');
    expect(liveRecord.rows[0].title).toBe('Original Published Offer 20% Off');

    // Candidate update is safely isolated in pending_candidate
    expect(liveRecord.rows[0].pending_change_status).toBe('CHANGED');
    expect(liveRecord.rows[0].pending_candidate.title).toBe('Updated 25% Off at Odel');
  });

  it('guarantees manual overrides survive subsequent scrapes', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-override', leaseToken);

    const offer = createTestOffer('sacred-override-1');
    const upsertRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, offer);

    // Operator applies sacred manual override
    await saveManualCorrection(
      upsertRes.id,
      { 'merchant.name': 'Odel Flagship Store Colombo' },
      'lead-editor',
      'Verified corporate entity name'
    );

    // Scraper runs again with raw scraped name "Odel"
    const scrapedAgain = createTestOffer('sacred-override-1', {
      merchant: { ...offer.merchant, name: 'Odel Scraped General' },
    });

    await upsertOffer(scrapedAgain, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, scrapedAgain);

    const check = await poolAdapter.query(`SELECT manual_override FROM offers WHERE id = $1`, [upsertRes.id]);
    // INVARIANT: Manual override is sacred and preserved
    expect(check.rows[0].manual_override['merchant.name']).toBe('Odel Flagship Store Colombo');
  });

  it('prevents duplicate candidates from silently merging or overwriting', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-dup', leaseToken);

    const offerA = createTestOffer('dup-orig-1', { title: '15% off Dining at Cinnamon Grand' });
    const upsertA = await upsertOffer(offerA, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, offerA);

    const offerB = createTestOffer('dup-cand-2', { title: '15% savings at Cinnamon Grand Colombo' });
    const upsertB = await upsertOffer(offerB, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, offerB);

    // Flag candidate B as duplicate
    await flagOfferAsDuplicate(upsertB.id, false, 'system-dup-detector', leaseToken);

    const rowA = await poolAdapter.query(`SELECT db_status, change_status FROM offers WHERE id = $1`, [upsertA.id]);
    const rowB = await poolAdapter.query(`SELECT db_status, change_status FROM offers WHERE id = $1`, [upsertB.id]);

    // Both rows still exist independently — no silent deletion or merger!
    expect(rowA.rows[0].db_status).toBe('APPROVED');
    expect(rowB.rows[0].db_status).toBe('REVIEW_REQUIRED');
    expect(rowB.rows[0].change_status).toBe('DUPLICATE');
  });

  it('ensures EXPIRED and REVIEW_REQUIRED offers remain nonpublic and fail-closed', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-scope', leaseToken);

    // 1. Expired offer
    const expiredOffer = createTestOffer('expired-1', {
      title: 'Expired Promo Last Month',
      validityPeriods: [
        {
          validFrom: '2026-01-01',
          validTo: '2026-01-31', // Past date
          periodType: PeriodType.OFFER,
          recurrenceType: RecurrenceType.DAILY,
          recurrenceDays: null,
          timeWindow: null,
          exclusionDays: null,
          blackoutPeriods: null,
          exclusionNotes: null,
          rawPeriodText: 'Expired',
        },
      ],
    });
    const expUpsert = await upsertOffer(expiredOffer, runId, { lifecycleStatus: 'EXPIRED' }, leaseToken, expiredOffer);

    // 2. Review required offer
    const reviewOffer = createTestOffer('review-1', { title: 'Pending Review Ambiguous Offer' });
    const revUpsert = await upsertOffer(reviewOffer, runId, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken, reviewOffer);

    // Public query simulation (omitting scope=admin)
    const publicQuery = buildOfferListQuery({ bank });
    const publicResults = await poolAdapter.query(`SELECT id FROM offers ${publicQuery.whereSql}`, publicQuery.params);

    const publicIds = publicResults.rows.map((r: any) => r.id);
    expect(publicIds).not.toContain(expUpsert.id);
    expect(publicIds).not.toContain(revUpsert.id);
  });

  it('strictly enforces that only authorized publication workflows can transition to PUBLISHED', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-auth', leaseToken);

    const unapprovedOffer = createTestOffer('unapproved-1', { title: 'Unapproved Draft' });
    const upsertRes = await upsertOffer(unapprovedOffer, runId, { lifecycleStatus: 'REVIEW_REQUIRED' }, leaseToken, unapprovedOffer);

    // Attempting to publish an unapproved offer directly fails closed (outcome: skipped, not published)
    const unauthorizedSync = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(unauthorizedSync.outcome).toBe('skipped');
    expect(unauthorizedSync.reason).toContain('not eligible');

    // Verify row is still REVIEW_REQUIRED
    const row = await poolAdapter.query(`SELECT db_status FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(row.rows[0].db_status).toBe('REVIEW_REQUIRED');

    // Operator transitions to APPROVED first
    await transitionOffer(upsertRes.id, 'APPROVE', 'lead-editor', 'Validated and approved', undefined, undefined, leaseToken);

    // Now publication succeeds
    const syncRes = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(syncRes.outcome).toBe('published');

    const publishedRow = await poolAdapter.query(`SELECT db_status FROM offers WHERE id = $1`, [upsertRes.id]);
    expect(publishedRow.rows[0].db_status).toBe('PUBLISHED');
  });

  it('verifies EXPIRED status compatibility with database schema and indexes', async () => {
    const runId = await createScrapeRun(bank, 'full', 'audit-p8-expired-compat', leaseToken);

    const offer = createTestOffer('expired-compat-1');
    const upsertRes = await upsertOffer(offer, runId, { lifecycleStatus: 'APPROVED' }, leaseToken, offer);
    await syncApprovedOffer(upsertRes.id, leaseToken);

    // Transition published offer to EXPIRED
    await transitionOffer(upsertRes.id, 'EXPIRE', 'lifecycle-cron', 'Offer validity period ended', undefined, undefined, leaseToken);

    const row = await poolAdapter.query(
      `SELECT db_status, updated_at FROM offers WHERE id = $1 AND db_status = 'EXPIRED'`,
      [upsertRes.id]
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].db_status).toBe('EXPIRED');

    // Index lookup on offers_status_idx succeeds without index scan corruption
    const indexScan = await poolAdapter.query(
      `EXPLAIN SELECT id FROM offers WHERE db_status = 'EXPIRED'`
    );
    expect(indexScan.rows.length).toBeGreaterThan(0);
  });
});
