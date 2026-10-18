import {
  parseFinancialTerms,
  parseCurrencyAmount,
  extractStructuredTransactionRange,
} from '@/parsing/transaction/transaction-parser';

describe('Financial Terms & Transaction Range Parser (Phase 5)', () => {
  describe('parseCurrencyAmount', () => {
    it('parses standard integer and comma amounts', () => {
      expect(parseCurrencyAmount('2500')).toBe(2500);
      expect(parseCurrencyAmount('2,500')).toBe(2500);
      expect(parseCurrencyAmount('50,000')).toBe(50000);
    });

    it('handles Sri Lankan currency notations and trailing slash-hyphen', () => {
      expect(parseCurrencyAmount('Rs. 2,500/-')).toBe(2500);
      expect(parseCurrencyAmount('Rs.2,500')).toBe(2500);
      expect(parseCurrencyAmount('LKR 10,000/-')).toBe(10000);
      expect(parseCurrencyAmount('Rs 750/-')).toBe(750);
    });

    it('handles verbal units like Million, Lakh, k', () => {
      expect(parseCurrencyAmount('1.5 Million')).toBe(1500000);
      expect(parseCurrencyAmount('2 Lakhs')).toBe(200000);
      expect(parseCurrencyAmount('50k')).toBe(50000);
    });

    it('returns null for empty or invalid values', () => {
      expect(parseCurrencyAmount('')).toBeNull();
      expect(parseCurrencyAmount(null)).toBeNull();
      expect(parseCurrencyAmount('abc')).toBeNull();
    });
  });

  describe('Semantically Separate Financial Fields', () => {
    it('correctly parses minimum bill Rs. 2,500 without setting max spend or max discount', () => {
      const text = 'Enjoy 20% off at Delifrance with your credit card. Minimum bill Rs. 2,500.';
      const res = parseFinancialTerms(text);

      expect(res.minimum_transaction_amount).toBe(2500);
      expect(res.maximum_transaction_amount).toBeNull();
      expect(res.maximum_discount_amount).toBeNull();
      expect(res.discount_percentage).toBe(20);
    });

    it('correctly parses maximum discount Rs. 750 without confusing it with maximum spend', () => {
      const text = 'Get 25% discount on your purchase. Maximum discount Rs. 750 applies.';
      const res = parseFinancialTerms(text);

      expect(res.maximum_discount_amount).toBe(750);
      expect(res.maximum_transaction_amount).toBeNull(); // CRITICAL: Never infer max spend from max discount!
      expect(res.discount_percentage).toBe(25);
    });

    it('handles Up to 30% off with UP_TO qualifier', () => {
      const text = 'Up to 30% off on selected items at Keells.';
      const res = parseFinancialTerms(text);

      expect(res.discount_percentage).toBe(30);
      expect(res.discount_qualifier).toBe('UP_TO');
    });

    it('correctly separates Minimum bill Rs. 2,500 and Maximum discount Rs. 750 in one offer', () => {
      const text = 'Up to 30% off. Minimum bill Rs. 2,500. Maximum discount Rs. 750.';
      const res = parseFinancialTerms(text);

      expect(res.minimum_transaction_amount).toBe(2500);
      expect(res.maximum_discount_amount).toBe(750);
      expect(res.maximum_transaction_amount).toBeNull();
      expect(res.discount_percentage).toBe(30);
      expect(res.discount_qualifier).toBe('UP_TO');
    });

    it('correctly parses Maximum transaction Rs. 50,000 as maximum spend, distinct from discount cap', () => {
      const text = 'Minimum bill value Rs. 5,000. Maximum transaction Rs. 50,000. Maximum discount Rs. 10,000.';
      const res = parseFinancialTerms(text);

      expect(res.minimum_transaction_amount).toBe(5000);
      expect(res.maximum_transaction_amount).toBe(50000);
      expect(res.maximum_discount_amount).toBe(10000);
    });

    it('handles multiple discounts in one campaign with TIERED qualifier and records warning', () => {
      const text = 'Enjoy 20% off for Platinum cards and 30% off for World Mastercard.';
      const res = parseFinancialTerms(text);

      expect(res.discount_percentage).toBe(30);
      expect(res.discount_qualifier).toBe('TIERED');
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain('Multiple discount percentages detected');
    });

    it('handles missing numeric values gracefully without throwing', () => {
      const text = 'Discount available on bill value subject to conditions apply.';
      const res = parseFinancialTerms(text);

      expect(res.minimum_transaction_amount).toBeNull();
      expect(res.maximum_transaction_amount).toBeNull();
      expect(res.maximum_discount_amount).toBeNull();
      expect(res.discount_percentage).toBeNull();
    });

    it('detects invalid and contradictory transaction ranges (min > max) and records warning', () => {
      const text = 'Minimum spend Rs. 50,000. Maximum bill Rs. 10,000.';
      const res = parseFinancialTerms(text);

      expect(res.minimum_transaction_amount).toBe(50000);
      expect(res.maximum_transaction_amount).toBeNull();
      expect(res.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Contradictory transaction range: minimum (50000) exceeds maximum (10000)'),
        ])
      );
    });

    it('handles currency formatting variants: LKR, Rs, with/without dots, commas, and trailing slashes', () => {
      const text1 = 'Min spend: LKR 10,000/- per transaction. Max spend: LKR 100,000/-';
      const res1 = parseFinancialTerms(text1);
      expect(res1.minimum_transaction_amount).toBe(10000);
      expect(res1.maximum_transaction_amount).toBe(100000);

      const text2 = 'Minimum bill value at Delifrance is Rs.2,500';
      const res2 = parseFinancialTerms(text2);
      expect(res2.minimum_transaction_amount).toBe(2500);

      const text3 = 'Discount is capped at Rs 5,000';
      const res3 = parseFinancialTerms(text3);
      expect(res3.maximum_discount_amount).toBe(5000);
    });
  });

  describe('extractStructuredTransactionRange helper', () => {
    it('maps correctly to core TransactionRange entity without leaking discount cap into max spend', () => {
      const text = 'Minimum bill Rs. 2,500. Maximum discount Rs. 750.';
      const { transactionRange, terms } = extractStructuredTransactionRange(text);

      expect(transactionRange.min).toBe(2500);
      expect(transactionRange.max).toBeNull(); // Must not be 750!
      expect(transactionRange.currency).toBe('LKR');
      expect(terms.maximum_discount_amount).toBe(750);
    });
  });
});
