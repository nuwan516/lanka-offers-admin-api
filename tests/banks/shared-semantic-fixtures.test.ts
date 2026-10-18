/**
 * Shared Financial & Semantic Test Fixtures across all 10 Bank Adapters (Batch C3)
 *
 * Verifies uniform financial semantics across:
 * - HNB, BOC, Sampath, NDB, DFCC, Seylan, Peoples, PABC, NSB, Combank
 *
 * Validates:
 * 1. Percentage discount parsing and bounds
 * 2. Minimum bill requirement extraction
 * 3. Card eligibility (Credit vs Debit, networks)
 * 4. Natural language Sri Lankan date handling
 * 5. Structured merchant extraction
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

describe('Shared Bank Semantic Test Fixtures (Batch C3)', () => {
  describe('Bank 1: HNB Semantic Extraction', () => {
    it('extracts discount percentage, min bill, and card eligibility', () => {
      const offer = parseHNBDetail(
        '101',
        {
          id: '101',
          title: '20% off at The Kingsbury for HNB Cards',
          from: '2026-03-01',
          to: '2026-06-30',
          cardType: 'credit',
          content: '<p>Merchant: The Kingsbury</p><p>Offer: Enjoy 20% off with HNB Visa Signature Credit Cards. Minimum spend Rs. 5,000.</p>',
        },
        'Dining',
        1
      );

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('hnb');
      expect(offer?.offer.discountPercentage).toBe(20);
      expect(offer?.merchant.name).toBe('The Kingsbury');
      expect(offer?.cardEligibility.cardTypes).toContain('Credit Card');
      expect(offer?.cardEligibility.networks).toContain('Visa');
      expect(offer?.transactionRange.min).toBe(5000);
      expect(offer?.validityPeriods[0].validTo).toBe('2026-06-30');
    });
  });

  describe('Bank 2: BOC Semantic Extraction', () => {
    it('extracts discount, validity, and credit/debit eligibility', () => {
      const offer = parseBOCOffer({
        url: '/offers/dining/shangri-la',
        title: 'Shangri-La Colombo',
        expirationDate: '30 Sep 2026',
        description: [
          '25% off on food bill with BOC Credit and Debit Cards. Valid until 30th September 2026.',
        ],
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('boc');
      expect(offer?.merchant.name).toBe('Shangri-La Colombo');
      expect(offer?.offer.discountPercentage).toBe(25);
      expect(offer?.cardEligibility.cardTypes).toEqual(
        expect.arrayContaining(['Credit Card', 'Debit Card'])
      );
      expect(offer?.validityPeriods[0].validTo).toBe('2026-09-30');
    });
  });

  describe('Bank 3: Sampath Semantic Extraction', () => {
    it('extracts merchant company, discount, and card tiers', () => {
      const offer = parseSampathOffer(
        {
          id: 301,
          title: '30% Off at Cinnamon Grand Colombo',
          company_name: 'Cinnamon Grand Colombo',
          short_discount: '30% Off',
          eligible_cards: ['Visa Signature', 'Mastercard World'],
          promotion_period: 'Valid until 31st August 2026',
          promotion_details: '30% off for Sampath Visa Signature and Mastercard World Credit Cardholders.',
        },
        null
      );

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('sampath');
      expect(offer?.merchant.name).toBe('Cinnamon Grand Colombo');
      expect(offer?.offer.discountPercentage).toBe(30);
      expect(offer?.cardEligibility.cardTypes).toContain('Credit Card');
      expect(offer?.validityPeriods[0].validTo).toBe('2026-08-31');
    });
  });

  describe('Bank 4: NDB Semantic Extraction', () => {
    it('extracts merchant, min transaction, and Mastercard network', () => {
      const offer = parseNDBOffer({
        merchantName: 'Keells Super',
        location: 'Colombo',
        phoneNumbers: [],
        offerDetails: '20% discount on total bill for NDB Mastercard Credit Cards. Minimum transaction Rs. 4,000.',
        validity: 'Until 31st July 2026',
        cardType: 'Credit Cards',
        detailUrl: 'https://www.ndbbank.com/offers/keells',
        _categoryName: 'Supermarkets',
        _categoryId: 1,
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('ndb');
      expect(offer?.merchant.name).toBe('Keells Super');
      expect(offer?.offer.discountPercentage).toBe(20);
      expect(offer?.cardEligibility.networks).toContain('Mastercard');
      expect(offer?.transactionRange.min).toBe(4000);
      expect(offer?.validityPeriods[0].validTo).toBe('2026-07-31');
    });
  });

  describe('Bank 5: DFCC Semantic Extraction', () => {
    it('extracts discount percentage, min bill, and card types', () => {
      const offer = parseDFCCOffer({
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
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('dfcc');
      expect(offer?.merchant.name).toBe('Singer Mega');
      expect(offer?.offer.discountPercentage).toBe(15);
      expect(offer?.cardEligibility.cardTypes).toContain('Credit Card');
      expect(offer?.transactionRange.min).toBe(10000);
      expect(offer?.validityPeriods[0].validTo).toBe('2026-10-31');
    });
  });

  describe('Bank 6: Seylan Semantic Extraction', () => {
    it('extracts multi-detail discounts, date range, and Seylan cards', () => {
      const offer = parseSeylanOffer({
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
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('seylan');
      expect(offer?.merchant.name).toBe('Hilton Colombo');
      expect(offer?.offer.discountPercentage).toBe(20);
      expect(offer?.transactionRange.min).toBe(3500);
      expect(offer?.validityPeriods[0].validFrom).toBe('2026-05-01');
      expect(offer?.validityPeriods[0].validTo).toBe('2026-07-31');
    });
  });

  describe('Bank 7: Peoples Bank Semantic Extraction', () => {
    it('extracts Peoples cards and discount percentage', () => {
      const offer = parsePeoplesOffer({
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
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('peoples');
      expect(offer?.merchant.name).toBe('Cargills Food City');
      expect(offer?.offer.discountPercentage).toBe(15);
      expect(offer?.transactionRange.min).toBe(2500);
      expect(offer?.cardEligibility.networks).toEqual(
        expect.arrayContaining(['Visa', 'Mastercard'])
      );
      expect(offer?.validityPeriods[0].validTo).toBe('2026-11-30');
    });
  });

  describe('Bank 8: Pan Asia (PABC) Semantic Extraction', () => {
    it('extracts flip-card Pan Asia offer and ignores posted date for real expiry', () => {
      const offer = parsePABCOffer({
        imageUrl: 'https://www.pabcbank.com/card.jpg',
        imageAlt: 'Nolimit Clothing',
        discount: '20% OFF',
        validityDate: '01/01/2026',
        description: '20% OFF at Nolimit for Pan Asia Mastercard Credit Cardholders. Minimum spend Rs. 5,000. Valid until 15th August 2026.',
        _categoryName: 'Shopping',
        _categoryId: 2,
        _sourceUrl: 'https://www.pabcbank.com/card-offers/',
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('pabc');
      expect(offer?.merchant.name).toBe('Nolimit');
      expect(offer?.offer.discountPercentage).toBe(20);
      expect(offer?.transactionRange.min).toBe(5000);
      expect(offer?.cardEligibility.networks).toContain('Mastercard');
      expect(offer?.validityPeriods[0].validTo).toBe('2026-08-15');
    });
  });

  describe('Bank 9: NSB Semantic Extraction', () => {
    it('extracts prose HTML text into structured NSB offer', () => {
      const offer = parseNSBOffer({
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
          paragraphs: [
            'Get 10% discount at Arpico Supercentre with NSB Visa Debit Cards.',
            'Minimum bill Rs. 3,000.',
          ],
          listItems: ['Promo period – 01st to 31st December 2026'],
          images: [],
          promoPeriod: '01st to 31st December 2026',
          fullText: 'Get 10% discount at Arpico Supercentre with NSB Visa Debit Cards. Minimum bill Rs. 3,000. Promo period – 01st to 31st December 2026',
        },
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('nsb');
      expect(offer?.merchant.name).toBe('Arpico Supercentre');
      expect(offer?.offer.discountPercentage).toBe(10);
      expect(offer?.cardEligibility.cardTypes).toContain('Debit Card');
      expect(offer?.transactionRange.min).toBe(3000);
      expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
    });
  });

  describe('Bank 10: Commercial Bank Semantic Extraction', () => {
    it('extracts multi-tier discount, up-to qualifier, and minimum bill', () => {
      const offer = parseComBankOffer({
        listing: {
          title: 'Softlogic Restaurants Dining Promotion',
          categoryLabel: 'Dining',
          discountText: 'Up to 25% Off',
          discountPercentage: 25,
          isUpTo: true,
          validityRaw: 'Offer valid until 31st August 2026',
          imageUrl: 'https://cdn.combank.lk/thumb.jpg',
          detailUrl: 'https://www.combank.lk/promo/softlogic',
          _categoryId: 1,
        },
        detail: {
          mainImageUrl: 'https://cdn.combank.lk/banner.jpg',
          sections: {
            'Offer details': [
              { type: 'item', text: '25% off for ComBank Credit Cards and 15% off for Debit Cards' },
              { type: 'item', text: 'The minimum bill value at Delifrance is Rs.2,500' },
            ],
          },
        },
      });

      expect(offer).not.toBeNull();
      expect(offer?.source).toBe('combank');
      expect(offer?.offer.discountPercentage).toBe(25);
      expect(offer?.cardEligibility.cardTypes).toEqual(
        expect.arrayContaining(['Credit Card', 'Debit Card'])
      );
      expect(offer?.transactionRange.min).toBe(2500);
      expect(offer?.validityPeriods[0].validTo).toBe('2026-08-31');
    });
  });
});
