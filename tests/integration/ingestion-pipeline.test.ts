import { parseComBankOffer, ComBankRawOffer } from '@/banks/combank/combank-parser';
import { OfferValidator } from '@/parsing/validators/offer-validator';
import { classifyDetailedOfferQuality } from '@/domain/offer-quality-decision';
import { buildOfferListQuery, sanitizePublicOffer } from '@/api/offer-query-scope';

describe('End-to-End Ingestion Pipeline (Phase 4)', () => {
  const validator = new OfferValidator();

  const validCombankFixture: ComBankRawOffer = {
    listing: {
      title: 'Get 20% off at The Coffee Bean with ComBank Credit Cards',
      categoryLabel: 'Dining',
      discountText: '20% Off',
      discountPercentage: 20,
      isUpTo: false,
      validityRaw: 'Offer valid until 31st December 2026',
      imageUrl: 'https://cdn.combank.lk/coffee.jpg',
      detailUrl: 'https://www.combank.lk/rewards-promotions/dining/coffee-bean',
      _categoryId: 1,
    },
    detail: {
      mainImageUrl: 'https://cdn.combank.lk/coffee_detail.jpg',
      sections: {
        'Offer terms and conditions': [
          { type: 'item', text: 'Offer valid for all Commercial Bank Credit Cards' },
          { type: 'item', text: 'Minimum spend Rs. 2,000' },
        ],
      },
    },
  };

  it('successfully processes valid source fixture through parsing, validation, quality gating and public sanitization', () => {
    // 1. Bank Scraper & Normalizer
    const normalized = parseComBankOffer(validCombankFixture);
    expect(normalized).not.toBeNull();
    expect(normalized?.merchant.name).toBe('The Coffee Bean');
    expect(normalized?.offer.discountPercentage).toBe(20);
    expect(normalized?.cardEligibility.cardTypes).toContain('Credit Card');

    // 2. Rule Validator
    const validation = validator.validate(normalized!);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // 3. Quality Decision Gate
    const quality = classifyDetailedOfferQuality({
      ruleValid: validation.valid,
      ruleErrorCount: validation.errors.length,
      ruleWarningCount: validation.warnings.length,
      llmScore: null,
      llmValid: null,
      llmStatus: null,
      isDuplicate: false,
    });
    expect(['VALID_HIGH_CONFIDENCE', 'VALID_WITH_WARNINGS', 'REVIEW_REQUIRED']).toContain(quality.category);

    // 4. Staging to Public API simulation
    const simulatedDbRow = {
      id: 'offer-101',
      unique_id: normalized!.uniqueId,
      bank: normalized!.source,
      source_url: normalized!.sourceUrl,
      title: normalized!.title,
      category: normalized!.category,
      card_type: normalized!.cardType,
      merchant_name: normalized!.merchant.name,
      merchant_location: normalized!.merchant.location,
      canonical_merchant: normalized!.merchant.name,
      location_scope: 'NATIONWIDE',
      discount_percentage: normalized!.offer.discountPercentage,
      valid_from: normalized!.validityPeriods[0]?.validFrom,
      valid_to: normalized!.validityPeriods[0]?.validTo,
      card_eligibility: normalized!.cardEligibility,
      geo_locations: [],
      geo_status: 'UNRESOLVED',
      raw_offer: normalized,
      rule_passed: true,
      db_status: 'PUBLISHED',
      // Internal metadata that MUST NOT leak to public:
      manual_override: { internal_notes: 'Verified by reviewer' },
      pending_candidate: { title: 'Unapproved future draft' },
      llm_reasoning: 'Internal reasoning output',
      audit_log: [{ action: 'ADMIN_APPROVE', at: '2026-10-16T12:00:00Z' }],
      created_at: '2026-10-16T12:00:00Z',
      updated_at: '2026-10-16T12:00:00Z',
    };

    // 5. Verify public query enforcement
    const publicQuery = buildOfferListQuery({});
    expect(publicQuery.whereSql).toContain("db_status = 'PUBLISHED'");
    expect(publicQuery.isAdmin).toBe(false);

    // 6. Verify field-level sanitization removes admin/internal metadata
    const sanitized = sanitizePublicOffer(simulatedDbRow);
    expect(sanitized.id).toBe('offer-101');
    expect(sanitized.title).toBe(normalized!.title);
    expect(sanitized.manual_override).toBeUndefined();
    expect(sanitized.pending_candidate).toBeUndefined();
    expect(sanitized.llm_reasoning).toBeUndefined();
    expect(sanitized.audit_log).toBeUndefined();
  });

  it('rejects incomplete source fixtures and routes them to SOURCE_INCOMPLETE or INVALID', () => {
    // Malformed fixture with no title and invalid dates
    const malformedFixture: ComBankRawOffer = {
      listing: {
        title: '',
        categoryLabel: '',
        discountText: '',
        discountPercentage: null,
        isUpTo: false,
        validityRaw: '',
        imageUrl: null,
        detailUrl: '',
        _categoryId: 1,
      },
      detail: null,
    };

    const normalized = parseComBankOffer(malformedFixture);
    expect(normalized).toBeNull(); // ComBank parser rejects empty title early

    // An offer with validation failures routes to INVALID and REVIEW_REQUIRED
    const invalidQuality = classifyDetailedOfferQuality({
      ruleValid: false,
      ruleErrorCount: 2,
      ruleWarningCount: 0,
      llmScore: null,
      llmValid: null,
      llmStatus: null,
      isDuplicate: false,
    });

    expect(invalidQuality.category).toBe('INVALID');
    expect(invalidQuality.decision).toBe('REVIEW_REQUIRED');

    // Below reject score floor triggers hard REJECT
    const rejectQuality = classifyDetailedOfferQuality({
      ruleValid: true,
      ruleErrorCount: 0,
      ruleWarningCount: 0,
      llmScore: 20,
      llmValid: false,
      llmStatus: 'validated',
      isDuplicate: false,
    });
    expect(rejectQuality.category).toBe('INVALID');
    expect(rejectQuality.decision).toBe('REJECT');
  });

  it('flags duplicate candidates appropriately and isolates them from public publishing', () => {
    const duplicateQuality = classifyDetailedOfferQuality({
      ruleValid: true,
      ruleErrorCount: 0,
      ruleWarningCount: 0,
      llmScore: null,
      llmValid: null,
      llmStatus: null,
      isDuplicate: true,
    });

    expect(duplicateQuality.category).toBe('DUPLICATE_CANDIDATE');
    expect(duplicateQuality.decision).toBe('REVIEW_REQUIRED');

    // Public query will NOT include review-required items
    const publicQuery = buildOfferListQuery({});
    expect(publicQuery.whereSql).toContain("db_status = 'PUBLISHED'");
  });
});
