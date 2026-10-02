/**
 * Golden test suite for Card Eligibility Intelligence (Phase 7):
 * - BOC: non-empty cardType and applicableCards
 * - HNB: compound exclusions (Corporate, Business, Fuel) and luxury tier extraction
 * - Peoples: credit vs debit and product exclusion filtering
 * - Normalization integrity across all bank parsers
 */
import { parseBOCOffer } from '@/banks/boc/boc-parser';
import { parseHNBDetail } from '@/banks/hnb/hnb-parser';
import { parsePeoplesOffer } from '@/banks/peoples/peoples-parser';

describe('Phase 7: Card Eligibility Intelligence & Rules', () => {
  describe('BOC Card Eligibility Extraction', () => {
    it('extracts Credit and Debit Card from "BOC Credit & Debit Cardholders"', () => {
      const offer = parseBOCOffer({
        url: '/personal-banking/card-offers/dining/test-hotel/product',
        title: 'Luxury Ella Resort',
        expirationDate: '31 Dec 2026',
        description: [
          '20% off on Bed & Breakfast for BOC Credit & Debit Cardholders Booking Period: 01st August - 20th Nov',
        ],
      });

      expect(offer).not.toBeNull();
      expect(offer!.cardEligibility.cardTypes).toEqual(['Credit Card', 'Debit Card']);
      expect(offer!.cardType).toBe('Credit Card, Debit Card');
      expect(offer!.offer.applicableCards).toEqual(['Credit Card', 'Debit Card']);
      expect(offer!.cardEligibility.excludedCards).toEqual([]);
    });

    it('extracts Credit Card only and detects Mastercard network', () => {
      const offer = parseBOCOffer({
        url: '/personal-banking/card-offers/dining/castle/product',
        title: 'Reveal Castle',
        expirationDate: '31 Dec 2026',
        description: [
          '30% off with BOC Mastercard Credit Cardholders',
        ],
      });

      expect(offer).not.toBeNull();
      expect(offer!.cardEligibility.cardTypes).toEqual(['Credit Card']);
      expect(offer!.cardType).toBe('Credit Card');
      expect(offer!.cardEligibility.networks).toEqual(['Mastercard']);
    });
  });

  describe('HNB Card Eligibility Extraction', () => {
    it('splits compound exclusions containing &amp; or and into individual card types', () => {
      const offer = parseHNBDetail(
        '4040',
        {
          id: '4040',
          title: '0% installments at Auto Hub',
          from: '2026-01-01',
          to: '2026-12-31',
          cardType: 'credit',
          content: 'Merchant : Auto Hub<br/>Eligibility: All HNB Credit Cards (except Corporate, Business &amp; Fuel cards)<br/>Terms and conditions apply',
        },
        'Services',
        1
      );

      expect(offer).not.toBeNull();
      expect(offer!.cardEligibility.cardTypes).toEqual(['Credit Card']);
      expect(offer!.cardType).toBe('Credit Card');
      expect(offer!.cardEligibility.excludedCards).toEqual(['Corporate', 'Business', 'Fuel cards']);
      expect(offer!.cardEligibility.restrictions).toContain('Except: Corporate, Business & Fuel cards');
    });

    it('captures luxury tier mentions (Visa Signature, Visa Infinite) in includedCards', () => {
      const offer = parseHNBDetail(
        '5050',
        {
          id: '5050',
          title: 'VISA CONCIERGE PROGRAM',
          from: '2026-01-01',
          to: '2026-12-31',
          cardType: 'credit',
          content: 'As a valued HNB Visa Signature or Visa Infinite Credit cardholder, you now have the pleasure of enjoying world-class services at your fingertips.',
        },
        'General',
        1
      );

      expect(offer).not.toBeNull();
      expect(offer!.cardEligibility.includedCards).toContain('Visa Signature');
      expect(offer!.cardEligibility.includedCards).toContain('Visa Infinite');
      expect(offer!.cardEligibility.networks).toContain('Visa');
    });
  });

  describe('Peoples Bank Card Eligibility Extraction', () => {
    it('preserves clean Credit vs Debit distinction and ignores food/produce exclusions', () => {
      const offer = parsePeoplesOffer({
        listing: {
          merchantName: 'Keells Super',
          discount: '20%',
          shortDescription: '20% off on credit cards (excluding liquor & tobacco maximum bill value: Rs. 10,000)',
          validityRaw: 'Till 31st December 2026',
          imageUrl: null,
          detailPageUrl: 'https://www.peoplesbank.lk/promotion/keells-super-credit/',
          _cardType: 'Credit Card',
          _categoryName: 'Supermarket',
        },
        detail: null,
      });

      expect(offer).not.toBeNull();
      expect(offer!.cardEligibility.cardTypes).toEqual(['Credit Card']);
      expect(offer!.cardType).toBe('Credit Card');
      // Produce/commodity exclusion must NOT pollute excludedCards
      expect(offer!.cardEligibility.excludedCards).toEqual([]);
    });
  });
});
