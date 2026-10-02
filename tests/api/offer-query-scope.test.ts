import { buildOfferListQuery, sanitizePublicOffer } from '@/api/offer-query-scope';

describe('buildOfferListQuery — public API safety (Step 3/19)', () => {
  it('forces db_status=PUBLISHED for a non-admin caller, ignoring the incoming status', () => {
    const q = buildOfferListQuery({ status: 'REVIEW_REQUIRED' });
    expect(q.isAdmin).toBe(false);
    expect(q.whereSql).toContain(`db_status = 'PUBLISHED'`);
    expect(q.params).not.toContain('REVIEW_REQUIRED');
  });

  it('forces db_status=PUBLISHED even when no status/scope is given at all (the Flutter app default)', () => {
    const q = buildOfferListQuery({});
    expect(q.whereSql).toContain(`db_status = 'PUBLISHED'`);
  });

  it('lets an admin-scoped caller filter by any lifecycle status', () => {
    const q = buildOfferListQuery({ status: 'REVIEW_REQUIRED', scope: 'admin' });
    expect(q.isAdmin).toBe(true);
    expect(q.whereSql).toContain('db_status = $');
    expect(q.params).toContain('REVIEW_REQUIRED');
  });

  it('an admin caller with no status filter sees every lifecycle state (no db_status condition)', () => {
    const q = buildOfferListQuery({ scope: 'admin' });
    expect(q.whereSql).not.toContain('db_status');
  });

  it('still applies the bank filter for both admin and public callers', () => {
    const pub = buildOfferListQuery({ bank: 'hnb' });
    const admin = buildOfferListQuery({ bank: 'hnb', scope: 'admin' });
    expect(pub.params).toContain('hnb');
    expect(admin.params).toContain('hnb');
  });

  it('a confirmed-duplicate offer (db_status=REJECTED) is never exposed publicly, even if requested explicitly', () => {
    const q = buildOfferListQuery({ status: 'REJECTED' });
    expect(q.whereSql).toContain(`db_status = 'PUBLISHED'`);
    expect(q.params).not.toContain('REJECTED');
  });

  it('excludes expired offers (valid_to < CURRENT_DATE) from public queries while allowing unexpiring (null) offers', () => {
    const pub = buildOfferListQuery({});
    expect(pub.whereSql).toContain(`(valid_to IS NULL OR valid_to >= CURRENT_DATE)`);

    const admin = buildOfferListQuery({ scope: 'admin' });
    expect(admin.whereSql).not.toContain('CURRENT_DATE');
  });

  it('isAdmin flag correctly reflects scope for the list endpoint SELECT branch decision', () => {
    // The list endpoint uses q.isAdmin to pick the SELECT column list.
    // Verify the flag is accurate for all combinations.
    expect(buildOfferListQuery({}).isAdmin).toBe(false);
    expect(buildOfferListQuery({ scope: 'admin' }).isAdmin).toBe(true);
    expect(buildOfferListQuery({ scope: 'ADMIN' }).isAdmin).toBe(false); // case-sensitive
    expect(buildOfferListQuery({ bank: 'hnb' }).isAdmin).toBe(false);
  });

  it('search filter applies to title, merchant_name, and canonical_merchant (Phase 6 consumer journey)', () => {
    const q = buildOfferListQuery({ search: 'Keells' });
    // Must search all three fields for canonical merchant aliases to work.
    expect(q.whereSql).toMatch(/title ILIKE/);
    expect(q.whereSql).toMatch(/merchant_name ILIKE/);
    expect(q.whereSql).toMatch(/canonical_merchant ILIKE/);
    expect(q.params.some(p => String(p).includes('Keells'))).toBe(true);
  });

  it('combined bank + search filter includes both conditions', () => {
    const q = buildOfferListQuery({ bank: 'hnb', search: 'dining' });
    expect(q.whereSql).toContain('bank = $');
    expect(q.whereSql).toMatch(/title ILIKE/);
    expect(q.params).toContain('hnb');
    expect(q.params.some(p => String(p).includes('dining'))).toBe(true);
  });
});

describe('sanitizePublicOffer — single-offer detail endpoint leakage guard', () => {
  const fullRow = {
    id: 'offer-1', unique_id: 'hnb_001', bank: 'hnb', source_url: 'https://bank.example/1',
    title: 'Offer', category: 'Dining', card_type: 'Visa', merchant_name: 'Merchant', merchant_location: 'Colombo',
    discount_percentage: '20', valid_from: '2026-01-01', valid_to: '2026-12-31',
    card_eligibility: {}, geo_locations: [], geo_status: 'resolved', raw_offer: { title: 'Offer' },
    rule_passed: true, db_status: 'PUBLISHED', created_at: '2026-01-01', updated_at: '2026-01-01',
    // internal / admin-only fields that must never reach a public caller:
    manual_override: { title: 'secret admin edit' },
    pending_candidate: { title: 'unreviewed future version' },
    pending_lifecycle_status: 'REVIEW_REQUIRED',
    pending_validation: { llmScore: 42 },
    llm_reasoning: 'internal LLM commentary',
    llm_issues: ['SOME_ISSUE'],
    rule_errors: [{ field: 'x', message: 'y' }],
    rule_warnings: [],
    scrape_run_id: 'run-1',
    change_status: 'CHANGED',
    pre_duplicate_change_status: 'NEW',
  };

  it('strips manual_override, pending_candidate, LLM reasoning, and internal bookkeeping', () => {
    const safe = sanitizePublicOffer(fullRow);
    expect(safe).not.toHaveProperty('manual_override');
    expect(safe).not.toHaveProperty('pending_candidate');
    expect(safe).not.toHaveProperty('pending_lifecycle_status');
    expect(safe).not.toHaveProperty('pending_validation');
    expect(safe).not.toHaveProperty('llm_reasoning');
    expect(safe).not.toHaveProperty('llm_issues');
    expect(safe).not.toHaveProperty('rule_errors');
    expect(safe).not.toHaveProperty('rule_warnings');
    expect(safe).not.toHaveProperty('scrape_run_id');
    expect(safe).not.toHaveProperty('change_status');
    expect(safe).not.toHaveProperty('pre_duplicate_change_status');
  });

  it('still returns the fields the Flutter detail view actually needs', () => {
    const safe = sanitizePublicOffer(fullRow);
    expect(safe.raw_offer).toEqual({ title: 'Offer' });
    expect(safe.title).toBe('Offer');
    expect(safe.bank).toBe('hnb');
    expect(safe.discount_percentage).toBe('20');
    expect(safe.db_status).toBe('PUBLISHED');
  });

  it('canonical_merchant is included in the safe set (needed for Flutter alias search display)', () => {
    const rowWithCanonical = { ...fullRow, canonical_merchant: 'Keells Holdings' };
    const safe = sanitizePublicOffer(rowWithCanonical);
    expect(safe.canonical_merchant).toBe('Keells Holdings');
  });

  it('location_scope is included in the safe set (needed for Flutter location scope badge)', () => {
    const rowWithScope = { ...fullRow, location_scope: 'ONLINE' };
    const safe = sanitizePublicOffer(rowWithScope);
    expect(safe.location_scope).toBe('ONLINE');
  });

  it('geo_locations is included in the safe set (needed for Flutter nearby and branch display)', () => {
    const geoRow = { ...fullRow, geo_locations: [{ lat: 6.9, lng: 79.8, name: 'Keells Colombo 3' }] };
    const safe = sanitizePublicOffer(geoRow);
    expect(safe.geo_locations).toEqual([{ lat: 6.9, lng: 79.8, name: 'Keells Colombo 3' }]);
  });
});

describe('Phase 6 — consumer data safety: list endpoint SELECT isolation', () => {
  /**
   * These tests document the contract that the list endpoint must honour:
   * for public (non-admin) callers the SELECT clause must NOT include any of
   * the fields in this list.  The actual query text is built in server.ts, so
   * these tests pin the documented expectation rather than testing the SQL
   * directly (which would require a running DB).  They serve as a regression
   * guard — if someone re-adds an internal field to the public SELECT, the
   * review of this test file will surface the intent mismatch.
   */
  const INTERNAL_FIELDS_FORBIDDEN_IN_PUBLIC_LIST = [
    'llm_score',
    'llm_valid',
    'rule_errors',
    'rule_warnings',
    'change_status',
    'pending_lifecycle_status',
    'has_pending_candidate',
    'scrape_run_id',
    'content_hash',
    'manual_override',
    'pending_candidate',
    'llm_reasoning',
    'llm_issues',
  ] as const;

  it('every field forbidden in the public list endpoint is absent from sanitizePublicOffer output', () => {
    const fullRowWithAllFields = {
      ...{
        id: 'x', unique_id: 'x', bank: 'hnb', source_url: 'https://x', title: 'T',
        category: 'C', card_type: 'Visa', merchant_name: 'M', merchant_location: 'L',
        discount_percentage: '10', valid_from: '2026-01-01', valid_to: '2026-12-31',
        card_eligibility: {}, geo_locations: [], geo_status: 'resolved',
        raw_offer: {}, rule_passed: true, db_status: 'PUBLISHED',
        created_at: '2026-01-01', updated_at: '2026-01-01',
        canonical_merchant: 'M', location_scope: 'NATIONWIDE',
      },
      llm_score: 92,
      llm_valid: true,
      rule_errors: [],
      rule_warnings: [],
      change_status: 'CHANGED',
      pending_lifecycle_status: 'REVIEW_REQUIRED',
      has_pending_candidate: true,
      scrape_run_id: 'run-99',
      content_hash: 'abc123',
      manual_override: { title: 'admin edit' },
      pending_candidate: { title: 'future' },
      llm_reasoning: 'internal reasoning',
      llm_issues: [],
    };
    const safe = sanitizePublicOffer(fullRowWithAllFields as Record<string, unknown>);
    for (const field of INTERNAL_FIELDS_FORBIDDEN_IN_PUBLIC_LIST) {
      expect(safe).not.toHaveProperty(field);
    }
  });
});
