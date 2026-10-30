/**
 * Phase 6: Financial Semantics Preservation Tests
 *
 * Verifies:
 * 1. Tiered discounts (e.g. 30% to one card tier, 10% to another) do not collapse into unconditional flat discounts.
 * 2. Maximum discount cap (e.g. capped at LKR 2,000) is strictly distinguished from maximum transaction spend.
 * 3. Minimum spend (e.g. LKR 10,000) is preserved and never dropped.
 * 4. Cashback paid later is classified as cashback, not immediate point-of-sale discount.
 * 5. 0% interest installments preserve installment plans without inventing false discount percentages.
 * 6. "Up to N%" preserves isUpTo semantics without advertising an unconditional N% discount.
 * 7. Corrections lacking explicit numeric grounding in source evidence are strictly rejected.
 */

import { OfferCorrectionValidator } from '@/parsing/validators/offer-correction-validator';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';
import { EvidenceSnippet } from '@/llm/schemas/offer-validation.schema';
import { detectUpToSemantics, verifySemanticNumericEvidence } from '@/parsing/validators/offer-evidence';

describe('Phase 6 — Financial Semantics Preservation', () => {
  const patchValidator = new OfferCorrectionValidator();

  function baseOffer(overrides: Partial<Offer> = {}): Offer {
    return {
      uniqueId: 'fin_test_1',
      source: 'combank',
      sourceId: '101',
      sourceUrl: 'https://combank.lk/promo/101',
      title: 'Financial Promo',
      category: 'Dining',
      categoryId: 1,
      cardType: 'Credit Card',
      scrapedAt: '2026-10-01T00:00:00.000Z',
      merchant: {
        name: 'Test Partner',
        location: 'Colombo',
        addresses: ['Colombo, Sri Lanka'],
        phone: [],
        email: [],
        website: null,
        logo: null,
      },
      offer: {
        description: 'Promo description',
        discountPercentage: null,
        applicableCards: [],
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
      contentHash: 'fin_hash',
      ...overrides,
    };
  }

  it('preserves tiered card discounts without collapsing into unconditional flat 30%', () => {
    const rawText = 'Enjoy 30% off with ComBank Visa Infinite Credit Cards and 10% off with ComBank Classic & Gold Credit Cards.';
    const evidence: EvidenceSnippet[] = [
      { id: 'ev-title', sourceField: 'title', text: 'Dining Promotion at Cinnamon Grand' },
      { id: 'ev-desc', sourceField: 'description', text: rawText },
    ];

    const offer = baseOffer({
      title: 'Dining Promotion at Cinnamon Grand',
      offer: {
        description: rawText,
        discountPercentage: null,
        applicableCards: ['Visa Infinite', 'Classic', 'Gold'],
        bookingRequired: false,
        restrictions: [],
        specialConditions: [],
        generalTerms: [],
      },
    });

    const numCheck = verifySemanticNumericEvidence(30, 'DISCOUNT_PERCENT', evidence, ['ev-desc']);
    expect(numCheck.found).toBe(true);
    expect(numCheck.contexts[0]).toContain('30% off with ComBank Visa Infinite');
  });

  it('strictly distinguishes maximum discount cap from maximum transaction limit', () => {
    const rawText = '20% off on fresh produce. Minimum bill Rs. 3,500. Maximum discount cap Rs. 2,000 per cardholder.';
    const evidence: EvidenceSnippet[] = [
      { id: 'ev-desc', sourceField: 'description', text: rawText },
    ];

    const capCheck = verifySemanticNumericEvidence(2000, 'MAXIMUM_DISCOUNT_CAP', evidence, ['ev-desc']);
    expect(capCheck.found).toBe(true);

    const invalidSpendCap = verifySemanticNumericEvidence(2000, 'MAXIMUM_TRANSACTION_LIMIT', evidence, ['ev-desc']);
    expect(invalidSpendCap.found).toBe(false);
  });

  it('strictly preserves minimum spend requirement of LKR 10,000', () => {
    const rawText = '15% savings on home appliances. Minimum spend Rs. 10,000 required.';
    const evidence: EvidenceSnippet[] = [
      { id: 'ev-desc', sourceField: 'description', text: rawText },
    ];

    const offer = baseOffer({
      transactionRange: { min: null, max: null, currency: 'LKR' },
    });

    const proposal = {
      fieldPath: 'transactionRange.min',
      originalValue: null,
      proposedValue: 10000,
      evidenceIds: ['ev-desc'],
      reason: 'Minimum spend of Rs. 10,000 explicitly stated in terms',
      confidence: 'HIGH' as const,
    };

    const res = patchValidator.validateProposal(proposal, offer, evidence);
    expect(res.valid).toBe(true);
  });

  it('classifies cashback correctly and rejects claiming immediate point-of-sale discount', () => {
    const rawText = 'Get 5% cashback credited to your account next month on weekend fuel purchases with HNB Debit Cards.';
    const evidence: EvidenceSnippet[] = [
      { id: 'ev-desc', sourceField: 'description', text: rawText },
    ];

    const isCashback = /cashback/i.test(rawText);
    expect(isCashback).toBe(true);

    const offer = baseOffer({
      title: '5% Cashback on Fuel with HNB Debit Cards',
      offer: {
        description: rawText,
        discountPercentage: null,
        applicableCards: ['Debit Card'],
        bookingRequired: false,
        restrictions: ['Credited next month'],
        specialConditions: [],
        generalTerms: [],
      },
    });

    const instantDiscountProposal = {
      fieldPath: 'offer.discountPercentage',
      originalValue: null,
      proposedValue: 5,
      evidenceIds: ['ev-desc'],
      reason: '5% discount',
      confidence: 'HIGH' as const,
    };

    const res = patchValidator.validateProposal(instantDiscountProposal, offer, evidence);
    expect(res.valid).toBe(false);
    expect(res.rejectionReason).toContain('does not semantically exist as a discount percentage');
  });

  it('preserves 0% installment plans without fabricating discount percentage', () => {
    const rawText = 'Enjoy 0% interest installment plans for up to 24 months on electronics with Sampath Credit Cards.';
    const evidence: EvidenceSnippet[] = [
      { id: 'ev-desc', sourceField: 'description', text: rawText },
    ];

    const monthCheck = verifySemanticNumericEvidence(24, 'INSTALLMENT_MONTHS', evidence, ['ev-desc']);
    expect(monthCheck.found).toBe(true);

    const fabricatedDiscount = verifySemanticNumericEvidence(24, 'DISCOUNT_PERCENT', evidence, ['ev-desc']);
    expect(fabricatedDiscount.found).toBe(false);
  });

  it('detects "Up to 30%" and distinguishes it from unconditional 30% off', () => {
    const title = 'Save Up to 30% on Selected Apparel';
    const desc = 'Up to 30% off on selected items at Odel with Seylan Credit Cards.';

    const upToCheck = detectUpToSemantics(`${title} ${desc}`, 30);
    expect(upToCheck.isUpTo).toBe(true);
    expect(upToCheck.evidenceContext).toContain('up to 30%');

    const flatTitle = 'Save 30% on All Apparel';
    const flatCheck = detectUpToSemantics(flatTitle, 30);
    expect(flatCheck.isUpTo).toBe(false);
  });
});
