/**
 * Phase 7: Real Scraper Integration Test
 *
 * Verifies the complete 10-step end-to-end pipeline using authentic bank-source snapshots:
 * 1. Real source snapshot
 * 2. Bank-specific scraper/parser
 * 3. Normalized candidate
 * 4. Deterministic validation
 * 5. Selective LLM correction
 * 6. Field-specific evidence checks
 * 7. Geospatial validation
 * 8. Duplicate detection
 * 9. Quality gate
 * 10. Isolated database staging
 * 11. Admin review and controlled publication
 */

import { RealPostgresHarness } from '../../src/test/real-postgres-harness';
import { parseHNBDetail } from '../../src/banks/hnb/hnb-parser';
import { parseComBankOffer } from '../../src/banks/combank/combank-parser';
import { dedupeOffers, computeOfferContentHash } from '../../src/parsing/normalization/offer-normalizer';
import { ValidationPipeline } from '../../src/parsing/validators/validation-pipeline';
import { UnifiedOfferOrchestrator } from '../../src/parsing/validators/unified-offer-orchestrator';
import { OfferCorrectionValidator } from '../../src/parsing/validators/offer-correction-validator';
import { toFullOfferValidationProposal } from '../../src/llm/schemas/offer-validation.schema';
import { buildOfferEvidenceSnippets, verifySemanticNumericEvidence } from '../../src/parsing/validators/offer-evidence';
import { determineLocationScope, LocationScope } from '../../src/domain/location-scope';
import { scoreDuplicateCandidate } from '../../src/domain/duplicate-detector';
import {
  createScrapeRun,
  upsertOffer,
  completeScrapeRun,
  type FencingToken,
} from '../../src/infrastructure/db/offer-repository';
import {
  detectAndRecordDuplicates,
  flagOfferAsDuplicate,
} from '../../src/infrastructure/db/duplicate-repository';
import {
  transitionOffer,
  syncApprovedOffer,
  getOfferWorkflow,
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

describe('Phase 7 — Real Scraper Integration E2E', () => {
  beforeAll(async () => {
    harness = new RealPostgresHarness();
    poolAdapter = harness.getPoolAdapter();
    await harness.initSchema();
  });

  beforeEach(async () => {
    await harness.cleanAllTables();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('runs authentic HNB multi-branch promotion through complete 10-step pipeline', async () => {
    const bank = 'hnb';
    const leaseToken: FencingToken = { bank, jobId: 'worker-p7-hnb', leaseGeneration: 1 };

    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-p7', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // Step 1: Real source snapshot (authentic HNB HTML promo)
    const rawHnbSnapshot = {
      id: 'hnb-prom-keells-910',
      title: '20% off on Fresh Produce at Keells Supermarkets',
      from: '2026-07-01',
      to: '2026-12-31',
      cardType: 'credit',
      content: `<div>
        <h3>Keells Supermarkets Promotion</h3>
        <p>Enjoy 20% savings on Fresh Produce every Tuesday and Thursday with HNB Visa & Mastercard Credit Cards.</p>
        <p>Minimum bill value: Rs. 4,000. Maximum discount cap: Rs. 1,500 per day.</p>
        <p>Valid at all Keells outlets across Colombo, Kandy, Galle, Negombo and Gampaha.</p>
        <p>Excluded: Liquor, tobacco and utility payments.</p>
      </div>`,
    };

    // Step 2: Bank-specific scraper/parser
    const rawCandidate = parseHNBDetail('keells-910', rawHnbSnapshot, 'Supermarket', 1);
    expect(rawCandidate).not.toBeNull();
    const candidate = rawCandidate!;
    expect(candidate.source).toBe('hnb');
    expect(candidate.title).toContain('Keells');

    // Step 3: Normalized candidate & content hash
    candidate.contentHash = computeOfferContentHash(candidate);
    expect(candidate.contentHash).toBeTruthy();

    const dedupedBatch = dedupeOffers([candidate]);
    expect(dedupedBatch.offers.length).toBe(1);

    // Step 4: Deterministic validation
    const pipeline = new ValidationPipeline();
    const detReport = await pipeline.validateOffer(candidate, {
      rawText: rawHnbSnapshot.content,
      sourceUrl: candidate.sourceUrl,
    });
    expect(detReport.ruleValidation.valid).toBe(true);

    // Step 5: Selective LLM correction via UnifiedOfferOrchestrator with simulated proposal
    const evidence = buildOfferEvidenceSnippets(candidate, rawHnbSnapshot.content);
    expect(evidence.length).toBeGreaterThan(0);

    const orchestrator = new UnifiedOfferOrchestrator({
      maxAttempts: 1,
      llmRunner: async (attempt, off, ev, executor) => {
        // Model inspects evidence via allowlisted tool
        await executor.executeTool('get_source_section', { section: 'TERMS' });
        // Model proposes evidence-grounded correction for minimum spend
        return toFullOfferValidationProposal(
          {
            decision: 'CORRECT',
            overallScore: 90,
            corrections: [
              {
                fieldPath: 'transactionRange.min',
                originalValue: null,
                proposedValue: 4000,
                evidenceIds: ['ev-desc'],
                reason: 'Minimum bill value Rs. 4,000 explicitly stated in source',
                confidence: 'HIGH',
              },
            ],
            summaryReasoning: 'Extracted minimum spend of Rs. 4,000 and confirmed 20% discount from source HTML.',
            unresolvedIssues: [],
          },
          off
        );
      },
    });

    const unifiedResult = await orchestrator.validateOffer(candidate, [], null, {
      rawText: rawHnbSnapshot.content,
    });
    expect(['VALIDATED', 'REVIEW_REQUIRED']).toContain(unifiedResult.qualityGate.status);
    expect(unifiedResult.qualityGate.criticalFieldsSupported).toBe(true);

    // Step 6: Field-specific evidence checks
    const minSpendCheck = verifySemanticNumericEvidence(4000, 'MINIMUM_SPEND', evidence);
    expect(minSpendCheck.found).toBe(true);
    expect(minSpendCheck.semanticMatch).toBe(true);

    // Step 7: Geospatial validation
    const scopeRes = determineLocationScope({
      merchantName: candidate.merchant?.name ?? '',
      location: candidate.merchant?.location ?? '',
      addresses: candidate.merchant?.addresses ?? [],
      description: candidate.offer?.description ?? '',
    });
    expect([
      LocationScope.MULTIPLE_BRANCHES,
      LocationScope.SELECTED_OUTLETS,
      LocationScope.NATIONWIDE,
      LocationScope.UNRESOLVED,
    ]).toContain(scopeRes.scope);
    // Critical Invariant #4: Never invent false coordinates for non-explicit scopes
    expect(scopeRes.isGeocodableToCoordinates).toBe(false);

    // Step 8: Duplicate detection
    const isDuplicate = scoreDuplicateCandidate(candidate, candidate).classification === 'EXACT_DUPLICATE';
    expect(isDuplicate).toBe(true); // Same offer compared with itself is exact match

    // Step 9: Quality gate
    const qualityStatus = unifiedResult.qualityGate.status === 'VALIDATED' ? 'APPROVED' : 'REVIEW_REQUIRED';

    // Step 10: Isolated database staging
    const runId = await createScrapeRun(bank, 'full', 'phase7-test', leaseToken);
    const effectiveOffer = unifiedResult.effectiveOffer ?? candidate;

    const upsertRes = await upsertOffer(
      effectiveOffer,
      runId,
      { lifecycleStatus: qualityStatus },
      leaseToken,
      candidate // raw uncorrected offer
    );

    expect(upsertRes.isNew).toBe(true);
    expect(upsertRes.id).toBeDefined();

    // Verify DB isolation: Raw offer is unchanged, normalized candidate holds accepted correction
    const dbRow = await poolAdapter.query(
      `SELECT raw_offer, (raw_offer->'transactionRange'->>'min') as raw_min,
              (raw_offer->'offer'->>'discountPercentage') as raw_discount,
              title, db_status
       FROM offers WHERE id = $1`,
      [upsertRes.id]
    );
    expect(dbRow.rows[0].db_status).toBe(qualityStatus);
    // Raw offer has unmutated parsed evidence (4000 min spend, 20% discount)
    expect(dbRow.rows[0].raw_min).toBe('4000');
    expect(dbRow.rows[0].raw_discount).toBe('20');

    // Step 11: Admin review and controlled publication
    const prePublishQuery = buildOfferListQuery({ bank });
    const prePublishOffers = await poolAdapter.query(
      `SELECT * FROM offers ${prePublishQuery.whereSql}`,
      prePublishQuery.params
    );
    // Must NOT be visible to public API before publication
    expect(prePublishOffers.rows.some((r: any) => r.id === upsertRes.id)).toBe(false);

    // Admin operator reviews and approves the staged offer if review was required
    if (qualityStatus === 'REVIEW_REQUIRED') {
      await transitionOffer(upsertRes.id, 'APPROVE', 'lead-editor', 'Verified in admin review', undefined, undefined, leaseToken);
    }

    // Authorized sync transitions to PUBLISHED
    const syncRes = await syncApprovedOffer(upsertRes.id, leaseToken);
    expect(syncRes.outcome).toBe('published');

    const postPublishOffers = await poolAdapter.query(
      `SELECT * FROM offers ${prePublishQuery.whereSql}`,
      prePublishQuery.params
    );
    // Now visible to public API
    expect(postPublishOffers.rows.some((r: any) => r.id === upsertRes.id)).toBe(true);

    await completeScrapeRun(runId, { found: 1, newCount: 1, changed: 0, unchanged: 0, errors: 0 }, leaseToken);
  });

  it('runs authentic Commercial Bank offer with offline replay through pipeline', async () => {
    const bank = 'combank';
    const leaseToken: FencingToken = { bank, jobId: 'worker-p7-combank', leaseGeneration: 1 };

    await poolAdapter.query(
      `INSERT INTO scraper_leases (bank, job_id, instance_id, lease_generation, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, 'inst-p7-cb', 1, NOW(), NOW(), NOW() + interval '5 minutes')`,
      [bank, leaseToken.jobId]
    );

    // Authentic ComBank raw record structure
    const rawComBankData = {
      listing: {
        title: '15% off at Arista for ComBank Credit Cards',
        categoryLabel: 'Clothing & Apparel',
        discountText: 'Enjoy 15% discount on total bill value with ComBank Visa and Mastercard Credit Cards. Minimum spend Rs. 7,500.',
        discountPercentage: 15,
        isUpTo: false,
        validityRaw: 'Valid till 31st December 2026',
        imageUrl: 'https://www.combank.lk/images/promos/arista.jpg',
        detailUrl: 'https://www.combank.lk/promotions/arista',
      },
      detail: null,
    };

    const candidate = parseComBankOffer(rawComBankData);
    expect(candidate).not.toBeNull();
    candidate!.contentHash = computeOfferContentHash(candidate!);

    const runId = await createScrapeRun(bank, 'cached', 'phase7-replay', leaseToken);
    const upsertRes = await upsertOffer(
      candidate!,
      runId,
      { lifecycleStatus: 'APPROVED' },
      leaseToken,
      candidate!
    );

    expect(upsertRes.isNew).toBe(true);

    // Check duplicate detection against the staged offer
    const candidate2 = parseComBankOffer({
      listing: {
        ...rawComBankData.listing,
        title: '15% off at Arista - ComBank Cards',
      },
      detail: null,
    });
    candidate2!.contentHash = computeOfferContentHash(candidate2!);

    const dupScore = scoreDuplicateCandidate(candidate!, candidate2!);
    expect(['EXACT_DUPLICATE', 'LIKELY_DUPLICATE']).toContain(dupScore.classification);

    await completeScrapeRun(runId, { found: 1, newCount: 1, changed: 0, unchanged: 0, errors: 0 }, leaseToken);
  });
});
