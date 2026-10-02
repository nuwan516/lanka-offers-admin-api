/**
 * Focused end-to-end integration harness (Part 16).
 *
 * Exercises the real `upsertOffer` / `syncApprovedOffer` / duplicate
 * detection functions together against a small in-memory fake of the
 * `offers` table (no real Postgres, no real LLM/geo calls) to verify the
 * modules actually compose correctly across the full:
 *
 *   NEW -> validate -> approve -> sync -> public
 *   UNCHANGED -> no extra work
 *   CHANGED (published) -> pending candidate -> correction -> approve -> sync -> new public value
 *   DUPLICATE candidate -> REVIEW_REQUIRED -> never publicly exposed
 *
 * flow described in the task. This is intentionally narrow (matches only
 * the exact query shapes the real functions issue) rather than a generic
 * SQL engine.
 */
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

// ─── Minimal in-memory fake of the `offers` table ────────────────────────────

interface FakeRow {
  id: string;
  unique_id: string;
  bank: string;
  source_url: string | null;
  title: string;
  category: string | null;
  card_type: string | null;
  merchant_name: string | null;
  merchant_location: string | null;
  discount_percentage: string | null;
  valid_from: string | null;
  valid_to: string | null;
  card_eligibility: unknown;
  geo_locations: unknown;
  raw_offer: Offer;
  content_hash: string | null;
  scrape_run_id: string | null;
  db_status: string;
  change_status: string;
  pre_duplicate_change_status: string | null;
  manual_override: Record<string, unknown>;
  pending_candidate: Offer | null;
  pending_lifecycle_status: string | null;
  pending_change_status: string | null;
  rule_passed: boolean;
  rule_errors: unknown[];
  rule_warnings: unknown[];
  llm_score: number | null;
  llm_valid: boolean | null;
  llm_status: string | null;
  geo_status: string;
}

class FakeOffersDb {
  offers = new Map<string, FakeRow>();
  duplicateCandidates = new Map<string, { id: string; offer_id: string; candidate_offer_id: string; score: number; classification: string; status: string }>();
  history: Array<{ offerId: string; action: string }> = [];
  private nextId = 1;
  private nextCandidateId = 1;

  private findByUniqueId(uniqueId: string): FakeRow | undefined {
    return [...this.offers.values()].find((r) => r.unique_id === uniqueId);
  }

  query = jest.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    // ── upsertOffer: existing-row lookup ──────────────────────────────────
    if (sql.includes('WHERE unique_id = $1 FOR UPDATE')) {
      const row = this.findByUniqueId(params[0] as string);
      return { rows: row ? [{ id: row.id, content_hash: row.content_hash, db_status: row.db_status }] : [] };
    }

    // ── upsertOffer: brand-new insert ─────────────────────────────────────
    if (sql.includes('INSERT INTO offers (')) {
      const id = `offer-${this.nextId++}`;
      const [uniqueId, bank, sourceUrl, title, category, cardType, merchantName, merchantLocation,
        discount, validFrom, validTo, cardEligibility, geoLocations, rawOffer, contentHash,
        scrapeRunId, dbStatus, changeStatus] = params as string[];
      this.offers.set(id, {
        id, unique_id: uniqueId, bank, source_url: sourceUrl, title, category, card_type: cardType,
        merchant_name: merchantName, merchant_location: merchantLocation, discount_percentage: discount,
        valid_from: validFrom, valid_to: validTo, card_eligibility: JSON.parse(cardEligibility),
        geo_locations: JSON.parse(geoLocations), raw_offer: JSON.parse(rawOffer), content_hash: contentHash,
        scrape_run_id: scrapeRunId, db_status: dbStatus, change_status: changeStatus,
        pre_duplicate_change_status: null, manual_override: {}, pending_candidate: null,
        pending_lifecycle_status: null, pending_change_status: null, rule_passed: true, rule_errors: [],
        rule_warnings: [], llm_score: null, llm_valid: null, llm_status: null, geo_status: 'unresolved',
      });
      return { rows: [{ id }] };
    }

    // ── upsertOffer: stage a changed candidate for a PUBLISHED offer ──────
    if (sql.includes(`pending_change_status = 'CHANGED'`)) {
      const [id, rawOffer, lifecycleStatus] = params as string[];
      const row = this.offers.get(id)!;
      row.pending_candidate = JSON.parse(rawOffer);
      row.pending_lifecycle_status = lifecycleStatus;
      row.pending_change_status = 'CHANGED';
      return { rows: [] };
    }

    // ── upsertOffer: direct overwrite (not yet published) ─────────────────
    if (sql.includes('geo_locations = $11') && sql.includes('title = $2')) {
      const [id, title, category, cardType, merchantName, merchantLocation, discount, validFrom, validTo,
        cardEligibility, geoLocations, rawOffer, contentHash, scrapeRunId, dbStatus, changeStatus] = params as string[];
      const row = this.offers.get(id)!;
      Object.assign(row, {
        title, category, card_type: cardType, merchant_name: merchantName, merchant_location: merchantLocation,
        discount_percentage: discount, valid_from: validFrom, valid_to: validTo,
        card_eligibility: JSON.parse(cardEligibility), geo_locations: JSON.parse(geoLocations),
        raw_offer: JSON.parse(rawOffer), content_hash: contentHash, scrape_run_id: scrapeRunId,
        db_status: dbStatus, change_status: changeStatus,
        pending_candidate: null, pending_lifecycle_status: null, pending_change_status: null,
      });
      return { rows: [] };
    }

    // ── generic row fetch (sync / transition / duplicate flag) ────────────
    if (/FROM offers WHERE id = \$1 FOR UPDATE/.test(sql) && !sql.includes('SELECT change_status')) {
      const row = this.offers.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('SELECT change_status, pending_change_status FROM offers')) {
      const row = this.offers.get(params[0] as string);
      return { rows: row ? [{ change_status: row.change_status, pending_change_status: row.pending_change_status }] : [] };
    }

    // ── syncOneOfferWithClient: publish ────────────────────────────────────
    if (sql.includes(`COALESCE(pending_candidate->>'contentHash'`)) {
      const [id, title, category, cardType, merchantName, merchantLocation, discount, validFrom, validTo,
        cardEligibility, rawOffer] = params as string[];
      const row = this.offers.get(id)!;
      Object.assign(row, {
        title, category, card_type: cardType, merchant_name: merchantName, merchant_location: merchantLocation,
        discount_percentage: discount, valid_from: validFrom, valid_to: validTo,
        card_eligibility: JSON.parse(cardEligibility), raw_offer: JSON.parse(rawOffer),
        content_hash: row.pending_candidate?.contentHash ?? row.content_hash,
        db_status: 'PUBLISHED', change_status: row.pending_change_status ?? row.change_status,
        pending_candidate: null, pending_lifecycle_status: null, pending_change_status: null,
      });
      return { rows: [] };
    }

    // ── duplicate candidate lookup (narrow, same-bank prefilter) ──────────
    if (sql.includes('FROM offers') && sql.includes('bank = $1 AND id <> $2')) {
      const [bank, excludeId] = params as string[];
      const rows = [...this.offers.values()]
        .filter((r) => r.bank === bank && r.id !== excludeId && !['REJECTED', 'DISABLED'].includes(r.db_status))
        .map((r) => ({ id: r.id, bank: r.bank, raw_offer: r.raw_offer, content_hash: r.content_hash }));
      return { rows };
    }

    // ── duplicate pair storage ─────────────────────────────────────────────
    if (sql.includes('INSERT INTO offer_duplicate_candidates')) {
      const [offerId, candidateOfferId, score, classification] = params as [string, string, number, string];
      const id = `dup-${this.nextCandidateId++}`;
      this.duplicateCandidates.set(id, { id, offer_id: offerId, candidate_offer_id: candidateOfferId, score, classification, status: 'PENDING' });
      return { rows: [] };
    }

    // ── flag as duplicate ───────────────────────────────────────────────────
    if (sql.includes(`change_status = 'DUPLICATE'`)) {
      const [id, priorChangeStatus] = params as string[];
      const row = this.offers.get(id)!;
      row.change_status = 'DUPLICATE';
      row.db_status = 'REVIEW_REQUIRED';
      row.pre_duplicate_change_status = priorChangeStatus;
      return { rows: [] };
    }

    // ── audit history (no-op storage) ──────────────────────────────────────
    if (sql.includes('INSERT INTO offer_review_history')) {
      const [offerId, action] = params as string[];
      this.history.push({ offerId, action });
      return { rows: [] };
    }

    throw new Error(`FakeOffersDb: unhandled query: ${sql}`);
  });
}

const fakeDb = new FakeOffersDb();

jest.mock('@/infrastructure/db/db-client', () => ({
  get pool() { return fakeDb; },
  withTransaction: (fn: (client: unknown) => unknown) => fn(fakeDb),
}));

import { upsertOffer } from '@/infrastructure/db/offer-repository';
import { syncApprovedOffer } from '@/infrastructure/db/offer-workflow-repository';
import { detectAndRecordDuplicates, flagOfferAsDuplicate, shouldRunDuplicateDetection } from '@/infrastructure/db/duplicate-repository';
import { buildOfferListQuery } from '@/api/offer-query-scope';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_e2e_1', source: 'hnb', sourceId: 'e2e-1', sourceUrl: 'https://bank.example/e2e-1',
    title: 'E2E Test Offer', category: 'Dining', categoryId: 1, cardType: 'Visa',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'E2E Merchant', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
    offer: { description: '20% off', discountPercentage: 20, applicableCards: [], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Visa'], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-01-01', validTo: '2026-12-31', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
    }],
    contentHash: 'hash-1',
    ...overrides,
  };
}

/** Simulates what the public (non-admin) `/api/offers` query would return, using the same visibility rule as production. */
function publicallyVisible(db: FakeOffersDb): FakeRow[] {
  const q = buildOfferListQuery({}); // no scope -> public caller
  return [...db.offers.values()].filter((r) => q.whereSql.includes(`db_status = 'PUBLISHED'`) ? r.db_status === 'PUBLISHED' : true);
}

describe('End-to-end offer lifecycle (Part 16)', () => {
  it('NEW -> approve -> sync -> visible publicly; UNCHANGED does no extra work; CHANGED stages safely; DUPLICATE never publishes', async () => {
    // ── 1. NEW offer, high quality -> AUTO_APPROVE -> APPROVED -> sync -> PUBLISHED -> public ──
    const offerV1 = makeOffer();
    const insertResult = await upsertOffer(offerV1, 'run-1', { lifecycleStatus: 'APPROVED' });
    expect(insertResult.status).toBe('NEW');

    const syncResult = await syncApprovedOffer(insertResult.id);
    expect(syncResult.outcome).toBe('published');

    const published = fakeDb.offers.get(insertResult.id)!;
    expect(published.db_status).toBe('PUBLISHED');
    expect(publicallyVisible(fakeDb).some((r) => r.id === insertResult.id)).toBe(true);

    // ── 2. SAME OFFER, UNCHANGED -> no write, no duplicate scan ───────────
    const queryCallsBefore = fakeDb.query.mock.calls.length;
    const unchangedResult = await upsertOffer(offerV1, 'run-2', { lifecycleStatus: 'APPROVED' });
    expect(unchangedResult.status).toBe('UNCHANGED');
    expect(fakeDb.query.mock.calls.length).toBe(queryCallsBefore + 1); // only the SELECT — no writes
    expect(shouldRunDuplicateDetection(unchangedResult.status)).toBe(false);

    // ── 3. CHANGED content on the now-PUBLISHED offer -> staged, live value intact ──
    const offerV2 = makeOffer({ offer: { ...offerV1.offer, discountPercentage: 30 }, contentHash: 'hash-2' });
    const changedResult = await upsertOffer(offerV2, 'run-3', { lifecycleStatus: 'REVIEW_REQUIRED' });
    expect(changedResult.status).toBe('CHANGED');
    expect(changedResult.staged).toBe(true);

    const stillLive = fakeDb.offers.get(insertResult.id)!;
    expect(stillLive.db_status).toBe('PUBLISHED');
    expect(stillLive.discount_percentage).toBe('20'); // old published value still served
    expect(stillLive.pending_candidate?.offer.discountPercentage).toBe(30);
    expect(publicallyVisible(fakeDb).find((r) => r.id === insertResult.id)?.discount_percentage).toBe('20');

    // Admin approves the staged candidate directly (simulating a completed review) and syncs.
    stillLive.pending_lifecycle_status = 'APPROVED';
    const resyncResult = await syncApprovedOffer(insertResult.id);
    expect(resyncResult.outcome).toBe('published');
    const afterResync = fakeDb.offers.get(insertResult.id)!;
    expect(afterResync.discount_percentage).toBe('30'); // new value now live
    expect(afterResync.pending_candidate).toBeNull();
    expect(publicallyVisible(fakeDb).find((r) => r.id === insertResult.id)?.discount_percentage).toBe('30');

    // ── 4. A near-identical NEW same-bank offer -> flagged DUPLICATE, never publishes ──
    const duplicateOffer = makeOffer({
      uniqueId: 'hnb_e2e_2', sourceId: 'e2e-2', sourceUrl: 'https://bank.example/e2e-2', contentHash: 'hash-3',
    });
    const dupInsert = await upsertOffer(duplicateOffer, 'run-4', { lifecycleStatus: 'APPROVED' });
    expect(shouldRunDuplicateDetection(dupInsert.status)).toBe(true);

    const detection = await detectAndRecordDuplicates(dupInsert.id, duplicateOffer, 'hnb');
    expect(detection.flagged).toBe(true);
    await flagOfferAsDuplicate(dupInsert.id, dupInsert.staged, 'scrape');

    const flaggedRow = fakeDb.offers.get(dupInsert.id)!;
    expect(flaggedRow.db_status).toBe('REVIEW_REQUIRED');
    expect(flaggedRow.change_status).toBe('DUPLICATE');
    expect(publicallyVisible(fakeDb).some((r) => r.id === dupInsert.id)).toBe(false);
  });
});
