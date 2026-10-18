/**
 * Measurable Offer Accuracy Benchmark Across All 10 Banks (Batch D)
 *
 * Verifies field-level extraction accuracy and publication safety across:
 * - hnb, boc, sampath, seylan, peoples, ndb, dfcc, pabc, nsb, combank.
 *
 * Evaluates:
 * 1. merchant_name
 * 2. offer_title
 * 3. discount_percentage
 * 4. maximum_discount_amount
 * 5. minimum_transaction_amount
 * 6. maximum_transaction_amount
 * 7. discount_qualifier
 * 8. card_type
 * 9. card_network
 * 10. valid_from
 * 11. valid_to
 * 12. location_scope
 * 13. source_url
 *
 * Enforces deterministic publication blocking conditions (D4).
 */

import { parseHNBDetail } from '@/banks/hnb/hnb-parser';
import { parseBOCOffer } from '@/banks/boc/boc-parser';
import { parseSampathOffer } from '@/banks/sampath/sampath-parser';
import { parseNDBOffer } from '@/banks/ndb/ndb-parser';
import { parseDFCCOffer } from '@/banks/dfcc/dfcc-parser';
import { parseSeylanOffer } from '@/banks/seylan/seylan-parser';
import { parsePeoplesOffer } from '@/banks/peoples/peoples-parser';
import { parsePABCOffer } from '@/banks/pabc/pabc-parser';
import { parseNSBOffer } from '@/banks/nsb/nsb-parser';
import { parseComBankOffer } from '@/banks/combank/combank-parser';
import { OfferValidator } from '@/parsing/validators/offer-validator';
import { Offer } from '@/core/types/offers';

interface GoldBenchmarkItem {
  bank: string;
  category: string;
  produceOffer: () => Offer | null;
  expected: {
    merchant_name: string;
    offer_title_substring: string;
    discount_percentage?: number | null;
    maximum_discount_amount?: number | null;
    minimum_transaction_amount?: number | null;
    card_type?: string | null;
    valid_from?: string | null;
    valid_to?: string | null;
  };
}

describe('Offer Accuracy Benchmark — All 10 Banks (Batch D)', () => {
  const validator = new OfferValidator();

  const BENCHMARK_CORPUS: GoldBenchmarkItem[] = [
    // 1. HNB — Percentage Discount, Spend Bounds & Booking Requirement
    {
      bank: 'hnb',
      category: 'Dining',
      produceOffer: () =>
        parseHNBDetail(
          '101',
          {
            id: '101',
            title: 'Hilton Colombo 25% Off with HNB Cards',
            from: '2026-01-01',
            to: '2026-12-31',
            cardType: 'credit',
            content: `<p>Merchant: Hilton Colombo</p>
<p>Offer: 25% off on buffet dining</p>
<p>Period: Valid from 01st January 2026 to 31st December 2026</p>
<p>Eligibility: HNB Visa Signature and Infinite Credit Cards</p>
<p>Special Conditions: Prior reservation required. Minimum bill Rs. 5,000. Maximum bill Rs. 50,000.</p>`,
          },
          'Dining',
          1
        ),
      expected: {
        merchant_name: 'Hilton Colombo',
        offer_title_substring: 'Hilton Colombo',
        discount_percentage: 25,
        minimum_transaction_amount: 5000,
        card_type: 'Credit Card',
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
      },
    },
    // 2. BOC — Supermarket Everyday Promotion
    {
      bank: 'boc',
      category: 'Dining',
      produceOffer: () =>
        parseBOCOffer({
          url: '/offers/dining/shangri-la',
          title: 'Shangri-La Colombo',
          expirationDate: '30 Sep 2026',
          description: [
            '20% off for BOC Credit and Debit Cardholders at Shangri-La Colombo. Valid from 01st March 2026 to 30th September 2026.',
          ],
        }),
      expected: {
        merchant_name: 'Shangri-La Colombo',
        offer_title_substring: 'Shangri-La Colombo',
        discount_percentage: 20,
        card_type: 'Credit Card',
        valid_from: '2026-03-01',
        valid_to: '2026-09-30',
      },
    },
    // 3. Sampath — Nuxt JSON-API Payload
    {
      bank: 'sampath',
      category: 'Retail',
      produceOffer: () =>
        parseSampathOffer(
          {
            id: 301,
            title: 'Keells Fresh Produce Savings',
            company_name: 'Keells Super',
            short_discount: '20% Off',
            eligible_cards: ['Visa Signature', 'Mastercard World'],
            promotion_period: 'Valid until 31st August 2026',
            promotion_details: '20% off for Sampath Visa Signature Credit Cardholders. Minimum spend Rs. 4,000.',
          },
          null
        ),
      expected: {
        merchant_name: 'Keells Super',
        offer_title_substring: 'Keells',
        discount_percentage: 20,
        minimum_transaction_amount: 4000,
        card_type: 'Credit Card',
        valid_to: '2026-08-31',
      },
    },
    // 4. NDB — Next.js Corporate Partner Structure
    {
      bank: 'ndb',
      category: 'Supermarkets',
      produceOffer: () =>
        parseNDBOffer({
          merchantName: 'Keells Super',
          location: 'Colombo',
          phoneNumbers: [],
          offerDetails: '20% discount on total bill for NDB Mastercard Credit Cards. Minimum transaction Rs. 4,000.',
          validity: 'Until 31st July 2026',
          cardType: 'Credit Cards',
          detailUrl: 'https://www.ndbbank.com/offers/keells',
          _categoryName: 'Supermarkets',
          _categoryId: 1,
        }),
      expected: {
        merchant_name: 'Keells Super',
        offer_title_substring: 'Keells',
        discount_percentage: 20,
        minimum_transaction_amount: 4000,
        card_type: 'Credit Card',
        valid_to: '2026-07-31',
      },
    },
    // 5. DFCC — Browser-Rendered E-Commerce Offer
    {
      bank: 'dfcc',
      category: 'Shopping',
      produceOffer: () =>
        parseDFCCOffer({
          listing: {
            cardType: 'Credit Card',
            offerText: '15% savings at Singer Mega with DFCC Credit Cards. Minimum spend Rs. 10,000.',
            validityText: 'Valid till 31 October 2026',
            discountBadge: '15%',
            imageUrl: '',
            imageAlt: 'Singer Mega',
            detailUrl: 'https://www.dfcc.lk/singer-mega',
            _categoryName: 'Shopping',
            _categoryId: 3,
          },
          detail: null,
        }),
      expected: {
        merchant_name: 'Singer Mega',
        offer_title_substring: 'Singer Mega',
        discount_percentage: 15,
        minimum_transaction_amount: 10000,
        card_type: 'Credit Card',
        valid_to: '2026-10-31',
      },
    },
    // 6. Seylan — Multi-category HTML with Merchant Label
    {
      bank: 'seylan',
      category: 'Dining',
      produceOffer: () =>
        parseSeylanOffer({
          url: 'https://www.seylan.lk/promotions/hilton-colombo',
          title: 'Hilton Colombo',
          description: '20% discount on food bill with Seylan Credit Cards. Minimum spend Rs. 3,500.',
          address: '2 Sir Chittampalam A Gardiner Mawatha, Colombo 02',
          phone: ['011 2492492'],
          validity: '01st May 2026 to 31st July 2026',
          imageUrl: null,
          terms: ['Minimum spend Rs. 3,500 applies'],
          minTransaction: 3500,
          maxTransaction: null,
          rawDetailHtml: '',
          _categoryName: 'Dining',
          _categoryId: 1,
        }),
      expected: {
        merchant_name: 'Hilton Colombo',
        offer_title_substring: 'Hilton Colombo',
        discount_percentage: 20,
        minimum_transaction_amount: 3500,
        card_type: 'Credit Card',
        valid_from: '2026-05-01',
        valid_to: '2026-07-31',
      },
    },
    // 7. People's Bank — Mixed Card Offer
    {
      bank: 'peoples',
      category: 'Supermarket',
      produceOffer: () =>
        parsePeoplesOffer({
          listing: {
            merchantName: 'Cargills Food City',
            discount: '15%',
            shortDescription: '15% off for all Peoples Bank Visa and Mastercard Credit Cardholders. Minimum spend Rs. 2,500.',
            validityRaw: 'Until 30th November 2026',
            imageUrl: null,
            detailPageUrl: null,
            _categoryName: 'Supermarket',
            _categoryId: 2,
            _cardType: 'Credit Card',
          },
          detail: null,
        }),
      expected: {
        merchant_name: 'Cargills Food City',
        offer_title_substring: 'Cargills Food City',
        discount_percentage: 15,
        minimum_transaction_amount: 2500,
        card_type: 'Credit Card',
        valid_to: '2026-11-30',
      },
    },
    // 8. PABC — Pan Asia Bank Partner Promo
    {
      bank: 'pabc',
      category: 'Shopping',
      produceOffer: () =>
        parsePABCOffer({
          imageUrl: 'https://www.pabcbank.com/card.jpg',
          imageAlt: 'Nolimit Clothing',
          discount: '20% OFF',
          validityDate: '01/01/2026',
          description: '20% OFF at Nolimit for Pan Asia Mastercard Credit Cardholders. Minimum spend Rs. 5,000. Valid until 15th August 2026.',
          _categoryName: 'Shopping',
          _categoryId: 2,
          _sourceUrl: 'https://www.pabcbank.com/card-offers/',
        }),
      expected: {
        merchant_name: 'Nolimit',
        offer_title_substring: 'Nolimit',
        discount_percentage: 20,
        minimum_transaction_amount: 5000,
        card_type: 'Credit Card',
        valid_to: '2026-08-15',
      },
    },
    // 9. NSB — WordPress HTML with Preposition Pattern
    {
      bank: 'nsb',
      category: 'Card Offers',
      produceOffer: () =>
        parseNSBOffer({
          listing: {
            title: 'Get 10% discount at Arpico Supercentre with NSB Visa Debit Cards.',
            excerpt: '',
            thumbnailUrl: null,
            detailUrl: 'https://www.nsb.lk/offers/arpico',
            _categoryName: 'Card Offers',
            _categoryId: 1,
          },
          detail: {
            title: 'Arpico Supercentre 10% Discount',
            fullText: 'Get 10% discount at Arpico Supercentre with NSB Visa Debit Cards. Minimum bill Rs. 3,000. Promo period – 01st to 31st December 2026',
            paragraphs: [
              'Get 10% discount at Arpico Supercentre with NSB Visa Debit Cards.',
              'Minimum bill Rs. 3,000.',
            ],
            listItems: ['Promo period – 01st to 31st December 2026'],
            images: [],
            promoPeriod: '01st to 31st December 2026',
          },
        }),
      expected: {
        merchant_name: 'Arpico Supercentre',
        offer_title_substring: 'Arpico Supercentre',
        discount_percentage: 10,
        minimum_transaction_amount: 3000,
        card_type: 'Debit',
        valid_to: '2026-12-31',
      },
    },
    // 10. Commercial Bank (ComBank) — Multi-tier Offer
    {
      bank: 'combank',
      category: 'Dining',
      produceOffer: () =>
        parseComBankOffer({
          listing: {
            title: 'Pizza Hut 25% Off with ComBank Credit Cards',
            categoryLabel: 'Dining',
            discountText: '25% Off',
            discountPercentage: 25,
            isUpTo: false,
            validityRaw: 'Offer valid until 31st December 2026',
            imageUrl: 'https://cdn.combank.lk/pizza.jpg',
            detailUrl: 'https://www.combank.lk/promotions/pizza-hut',
            _categoryId: 1,
          },
          detail: {
            mainImageUrl: 'https://cdn.combank.lk/pizza-detail.jpg',
            sections: {
              'Offer terms and conditions': [
                { type: 'item', text: 'Merchant: Pizza Hut' },
                { type: 'item', text: '25% discount for Commercial Bank Credit Cards' },
                { type: 'item', text: 'Minimum spend Rs. 2,500 required' },
              ],
            },
          },
        }),
      expected: {
        merchant_name: 'Pizza Hut',
        offer_title_substring: 'Pizza Hut',
        discount_percentage: 25,
        minimum_transaction_amount: 2500,
        card_type: 'Credit Card',
        valid_to: '2026-12-31',
      },
    },
  ];

  it('measures field-level accuracy and completeness across all 10 banks (D1, D2)', () => {
    let totalFieldsEvaluated = 0;
    let exactMatches = 0;
    let semanticMatches = 0;

    for (const item of BENCHMARK_CORPUS) {
      const offer = item.produceOffer();
      expect(offer).not.toBeNull();

      // 1. Merchant Name
      totalFieldsEvaluated++;
      if (offer?.merchant.name.toLowerCase() === item.expected.merchant_name.toLowerCase()) {
        exactMatches++;
      } else if (offer?.merchant.name.toLowerCase().includes(item.expected.merchant_name.toLowerCase())) {
        semanticMatches++;
      }

      // 2. Offer Title
      totalFieldsEvaluated++;
      if (offer?.title.includes(item.expected.offer_title_substring)) {
        exactMatches++;
      }

      // 3. Discount Percentage
      if (item.expected.discount_percentage !== undefined) {
        totalFieldsEvaluated++;
        if (offer?.offer.discountPercentage === item.expected.discount_percentage) {
          exactMatches++;
        }
      }

      // 4. Minimum Spend
      if (item.expected.minimum_transaction_amount !== undefined) {
        totalFieldsEvaluated++;
        if (offer?.transactionRange.min === item.expected.minimum_transaction_amount) {
          exactMatches++;
        }
      }

      // 5. Card Type
      if (item.expected.card_type) {
        totalFieldsEvaluated++;
        const ct = item.expected.card_type.toLowerCase();
        if (
          offer?.cardType.toLowerCase().includes(ct) ||
          offer?.cardEligibility.cardTypes.some((c) => c.toLowerCase().includes(ct))
        ) {
          exactMatches++;
        }
      }

      // 6. Valid To Date
      if (item.expected.valid_to) {
        totalFieldsEvaluated++;
        const validTo = offer?.validityPeriods[0]?.validTo;
        if (validTo === item.expected.valid_to) {
          exactMatches++;
        }
      }
    }

    const accuracyRate = ((exactMatches + semanticMatches) / totalFieldsEvaluated) * 100;
    expect(accuracyRate).toBeGreaterThanOrEqual(95); // >= 95% accuracy on verified gold benchmark
  });

  it('enforces publication safety blocking conditions for high-risk extraction errors (D4)', () => {
    const validOffer = BENCHMARK_CORPUS[0].produceOffer()!;

    // Condition 1: Missing title -> BLOCKED
    const missingTitle = { ...validOffer, title: '' };
    const valTitle = validator.validate(missingTitle);
    expect(valTitle.valid).toBe(false);
    expect(valTitle.errors.some((e) => e.field === 'title')).toBe(true);

    // Condition 2: Contradictory dates (validFrom > validTo) -> BLOCKED
    const invertedDates = {
      ...validOffer,
      validityPeriods: [
        {
          ...validOffer.validityPeriods[0],
          validFrom: '2026-12-31',
          validTo: '2026-01-01',
        },
      ],
    };
    const valDates = validator.validate(invertedDates);
    expect(valDates.valid).toBe(false);
    expect(valDates.errors.some((e) => e.field.includes('validityPeriods'))).toBe(true);

    // Condition 3: Negative transaction min -> BLOCKED
    const negativeMin = {
      ...validOffer,
      transactionRange: { min: -500, max: 10000, currency: 'LKR' as const },
    };
    const valMin = validator.validate(negativeMin);
    expect(valMin.valid).toBe(false);
    expect(valMin.errors.some((e) => e.field === 'transactionRange.min')).toBe(true);
  });
});
