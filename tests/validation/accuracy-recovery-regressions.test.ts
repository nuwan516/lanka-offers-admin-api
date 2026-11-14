import { parseFinancialTerms, extractStructuredTransactionRange } from '@/parsing/transaction/transaction-parser';
import { determineLocationScope, LocationScope } from '@/domain/location-scope';
import { decideOfferQuality, classifyDetailedOfferQuality } from '@/domain/offer-quality-decision';
import { nextLifecycleStatus, isValidTransition, OfferLifecycleStatus } from '@/domain/offer-lifecycle';
import { computeEffectiveOffer, ManualOverride } from '@/domain/effective-offer';
import { Offer } from '@/core/types/offers';

describe('Phase 11: Accuracy Recovery, Source-Grounding & Staging Safety Regressions', () => {
  // ── 1. Minimum-Spend Ambiguity & State Tracking ───────────────────────────
  describe('1. Minimum-Spend Ambiguity & State Tracking', () => {
    it('correctly classifies EXPLICIT_MINIMUM from various Sri Lankan bank phrasings', () => {
      const cases = [
        { text: 'Minimum Bill Value - 10,000/- (Only Treatments)', expectedMin: 10000 },
        { text: 'Minimum bill value: Rs. 4,000 at all supermarkets', expectedMin: 4000 },
        { text: 'for bills of Rs. 5,000 and above every weekend', expectedMin: 5000 },
        { text: 'purchases exceeding Rs. 7,500 on total invoice', expectedMin: 7500 },
        { text: 'eligible transaction threshold of Rs. 3,500', expectedMin: 3500 },
        { text: 'minimum installment transaction of Rs. 25,000 for 12 months', expectedMin: 25000 },
      ];

      for (const c of cases) {
        const terms = parseFinancialTerms(c.text);
        expect(terms.minimum_spend_state).toBe('EXPLICIT_MINIMUM');
        expect(terms.minimum_transaction_amount).toBe(c.expectedMin);
        expect(terms.minimum_spend_condition).toBeTruthy();
      }
    });

    it('correctly classifies NO_MINIMUM_SPECIFIED when text explicitly waives threshold', () => {
      const terms = parseFinancialTerms('Enjoy 20% off with no minimum spend required on any transaction amount.');
      expect(terms.minimum_spend_state).toBe('NO_MINIMUM_SPECIFIED');
      expect(terms.minimum_transaction_amount).toBeNull();
      expect(terms.minimum_spend_condition).toContain('no minimum spend');
    });

    it('correctly classifies UNKNOWN_OR_AMBIGUOUS when minimum spend is mentioned without amount', () => {
      const terms = parseFinancialTerms('Special discount valid for credit cards. Minimum spend applies. Terms apply.');
      expect(terms.minimum_spend_state).toBe('UNKNOWN_OR_AMBIGUOUS');
      expect(terms.minimum_transaction_amount).toBeNull();
      expect(terms.warnings.some(w => w.includes('Ambiguous minimum spend'))).toBe(true);
    });

    it('detects cumulative spend requirements across promotion period', () => {
      const terms = parseFinancialTerms('Spend and win! Cumulative spend of Rs. 50,000 across promo period qualifies for draw.');
      expect(terms.warnings.some(w => w.includes('Cumulative spend'))).toBe(true);
    });
  });

  // ── 2. Maximum Transaction Limit vs Discount Cap ──────────────────────────
  describe('2. Maximum Transaction Limit vs Discount Cap', () => {
    it('disentangles maximum discount cap from maximum transaction amount', () => {
      const text = 'Up to 20% discount. Maximum discount Rs. 5,000. Maximum bill value Rs. 50,000. Minimum spend Rs. 10,000.';
      const terms = parseFinancialTerms(text);

      expect(terms.discount_percentage).toBe(20);
      expect(terms.discount_qualifier).toBe('UP_TO');
      expect(terms.maximum_discount_amount).toBe(5000);
      expect(terms.maximum_transaction_amount).toBe(50000);
      expect(terms.minimum_transaction_amount).toBe(10000);
      expect(terms.minimum_spend_state).toBe('EXPLICIT_MINIMUM');

      // Crucial invariant: structured transaction range maps spend, NOT discount cap
      const structured = extractStructuredTransactionRange(text);
      expect(structured.transactionRange.min).toBe(10000);
      expect(structured.transactionRange.max).toBe(50000);
      expect(structured.terms.maximum_discount_amount).toBe(5000);
    });
  });

  // ── 3. Location-Scope Uncertainty & Selected Outlets vs Nationwide ─────────
  describe('3. Location-Scope Uncertainty: Selected Outlets vs Nationwide', () => {
    it('classifies SELECTED_OUTLETS and refuses false precision expansion to all branches', () => {
      const res = determineLocationScope({
        title: '20% off at Selected SPAR Supermarkets',
        description: 'Offer available at selected merchant outlets.',
        merchantName: 'SPAR',
      });

      expect(res.scope).toBe(LocationScope.SELECTED_OUTLETS);
      expect(res.scope).not.toBe(LocationScope.NATIONWIDE);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });

    it('classifies NATIONWIDE only when explicitly indicated in evidence', () => {
      const res = determineLocationScope({
        title: '15% off across all DSI showrooms islandwide',
        description: 'Valid at all outlets islandwide.',
        merchantName: 'DSI',
      });

      expect(res.scope).toBe(LocationScope.NATIONWIDE);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });

    it('preserves UNRESOLVED for chain store when outlet information is completely absent', () => {
      const res = determineLocationScope({
        title: 'Enjoy 10% off on fresh produce',
        description: '10% discount for debit cards.',
        merchantName: 'Keells Super',
      });

      expect(res.scope).toBe(LocationScope.UNRESOLVED);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });
  });

  // ── 4. Mall-Level & Specific Venue Identification ─────────────────────────
  describe('4. Mall-Level & Specific Venue Identification', () => {
    it('identifies EXPLICIT_BRANCH for named hotels/resorts without street address', () => {
      const hotels = ['Amaya Lake Dambulla', 'Courtyard by Marriott Colombo', 'Hilton Colombo', 'Siddhalepa Clinics'];
      for (const h of hotels) {
        const res = determineLocationScope({
          title: 'Special promotion',
          description: 'Special seasonal room rate discount.',
          merchantName: h,
        });

        expect(res.scope).toBe(LocationScope.EXPLICIT_BRANCH);
        // Invariant #4: Exact pin prevented when street address is legitimately absent
        expect(res.isGeocodableToCoordinates).toBe(false);
      }
    });

    it('identifies venue with shopping mall address', () => {
      const res = determineLocationScope({
        title: '25% off on total bill',
        description: 'Valid at amanté, Shop GS06, Racecourse Mall, Colombo 7',
        addresses: ['Shop GS06, Racecourse Mall, Colombo 7'],
        merchantName: 'amanté',
      });

      expect(res.scope).toBe(LocationScope.EXPLICIT_BRANCH);
      expect(res.isGeocodableToCoordinates).toBe(true);
    });
  });

  // ── 5. Online Platforms & Hybrid Promotions ───────────────────────────────
  describe('5. Online Platforms & Hybrid Promotions', () => {
    it('classifies online delivery platforms as ONLINE with 0 physical branches', () => {
      const res = determineLocationScope({
        title: 'Order your favourite food on Uber Eats with ComBank Cards',
        description: '20% off on online orders via Uber Eats app.',
        merchantName: 'Uber Eats',
        addresses: ['Uber Eats, Sri Lanka'],
      });

      expect(res.scope).toBe(LocationScope.ONLINE);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });

    it('classifies hybrid physical + online retail promotion as NATIONWIDE, not ONLINE', () => {
      const res = determineLocationScope({
        title: '25% off on Total Bill',
        description: 'Offer valid at All Cool Planet Outlets & online on www.coolplanet.lk',
        merchantName: 'COOL PLANET',
      });

      expect(res.scope).toBe(LocationScope.NATIONWIDE);
      expect(res.isGeocodableToCoordinates).toBe(false);
    });
  });

  // ── 6. Model Timeout Review Routing & Quality Gates ───────────────────────
  describe('6. Model Timeout Review Routing & Quality Gates', () => {
    it('routes network timeout to REVIEW_REQUIRED without invalidating underlying promotion', () => {
      const assessment = classifyDetailedOfferQuality({
        ruleValid: true,
        ruleErrorCount: 0,
        ruleWarningCount: 1,
        llmScore: null,
        llmValid: null,
        llmStatus: 'review_required', // Fail-closed timeout state
        isExpired: false,
      });

      expect(assessment.decision).toBe('REVIEW_REQUIRED');
      expect(assessment.category).toBe('VALID_WITH_WARNINGS');
      expect(assessment.decision).not.toBe('REJECT');
      expect(assessment.reasons.some(r => r.includes('lacks LLM verification'))).toBe(true);
    });
  });

  // ── 7. Staging Status Mapping & Operator Control ──────────────────────────
  describe('7. Staging Status Mapping & Operator Control', () => {
    it('proves AUTO_APPROVE maps to APPROVED and NEVER to PUBLISHED', () => {
      const quality = decideOfferQuality({
        ruleValid: true,
        ruleErrorCount: 0,
        ruleWarningCount: 0,
        llmScore: 95,
        llmValid: true,
        llmStatus: 'validated',
      });

      expect(quality).toBe('AUTO_APPROVE');

      // Operator publication gate
      const stagedStatus: OfferLifecycleStatus = quality === 'AUTO_APPROVE' ? 'APPROVED' : 'REVIEW_REQUIRED';
      expect(stagedStatus).toBe('APPROVED');
      expect(stagedStatus).not.toBe('PUBLISHED');

      // Only operator PUBLISH review action can transition to PUBLISHED
      expect(isValidTransition('APPROVED', 'PUBLISH')).toBe(true);
      expect(nextLifecycleStatus('PUBLISH')).toBe('PUBLISHED');

      // Direct transition from DISCOVERED to PUBLISHED is forbidden
      expect(isValidTransition('DISCOVERED', 'PUBLISH')).toBe(false);
    });
  });

  // ── 8. Immutable Raw Evidence & Sacred Manual Overrides ───────────────────
  describe('8. Immutable Raw Evidence & Sacred Manual Overrides', () => {
    const mockOffer: Offer = {
      uniqueId: 'test-hnb-lotus',
      source: 'hnb',
      sourceId: '101',
      sourceUrl: 'https://hnb.lk/lotus',
      title: 'Original Title',
      category: 'Dining',
      categoryId: 1,
      cardType: 'Credit',
      scrapedAt: '2026-10-29T00:00:00.000Z',
      merchant: { name: 'Lotus Estate Colombo', location: null, addresses: [], phone: [], email: [], website: null, logo: null },
      offer: { description: 'Original 15% discount', discountPercentage: 15, applicableCards: ['Credit'], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
      installmentPlans: [],
      transactionRange: { min: 5000, max: null, currency: 'LKR' },
      cardEligibility: { cardTypes: ['Credit'], networks: ['VISA'], includedCards: [], excludedCards: [], restrictions: [] },
      images: { logo: null, gallery: [], images: [] },
      validityPeriods: [],
      contentHash: 'hash-abc',
    };

    it('preserves sacred manual overrides when effective offer is recomputed', () => {
      const overrides: ManualOverride = {
        title: 'Manually Corrected Title',
        'offer.discountPercentage': 25,
        'merchant.name': 'Lotus Estate (Verified)',
      };

      const effective = computeEffectiveOffer(mockOffer, overrides);

      expect(effective.title).toBe('Manually Corrected Title');
      expect(effective.offer.discountPercentage).toBe(25);
      expect(effective.merchant.name).toBe('Lotus Estate (Verified)');

      // Non-overridden fields remain preserved from scraped candidate
      expect(effective.transactionRange.min).toBe(5000);
      expect(effective.source).toBe('hnb');
    });
  });
});
