/**
 * Lanka Offers — Reusable Financial Terms & Transaction Range Parser
 *
 * Enforces strict semantic separation between:
 * - minimum_transaction_amount (minimum spend / bill value)
 * - maximum_transaction_amount (spend cap / maximum bill value)
 * - maximum_discount_amount    (discount cap / ceiling on discount savings)
 * - discount_percentage        (percentage value)
 * - discount_qualifier         (UP_TO, FLAT, TIERED, etc.)
 *
 * CRITICAL INVARIANT:
 * Never infer maximum transaction amount from a maximum discount amount.
 */

import { TransactionRange } from '@/core/types/offers';

export type DiscountQualifier = 'UP_TO' | 'FLAT' | 'TIERED' | 'STARTING_AT' | 'ADDITIONAL' | 'FIXED_AMOUNT';

export type MinimumSpendState = 'NO_MINIMUM_SPECIFIED' | 'EXPLICIT_MINIMUM' | 'UNKNOWN_OR_AMBIGUOUS';

export interface ParsedFinancialTerms {
  minimum_transaction_amount: number | null;
  minimum_spend_state: MinimumSpendState;
  minimum_spend_condition: string | null;
  maximum_transaction_amount: number | null;
  maximum_discount_amount: number | null;
  discount_percentage: number | null;
  discount_qualifier: DiscountQualifier | null;
  currency: 'LKR';
  warnings: string[];
}

/**
 * Parses numeric currency strings commonly used in Sri Lankan bank promotions:
 * e.g. "2,500", "2500/-", "Rs. 50,000", "LKR 1.5 Mn", "100k", "2 Lakhs".
 */
export function parseCurrencyAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/^Rs\.?\s*/i, '').replace(/^LKR\s*/i, '').replace(/\/-\s*$/, '').trim();
  if (!clean) return null;

  // Handle words: million, mn, lakh, k
  const lower = clean.toLowerCase();
  const numMatch = lower.match(/^([\d,]+(?:\.\d+)?)\s*(million|mn|m|lakhs?|k)?$/i);
  if (!numMatch) {
    const fallbackNum = parseFloat(clean.replace(/[^\d.]/g, ''));
    return Number.isFinite(fallbackNum) ? fallbackNum : null;
  }

  const baseNum = parseFloat(numMatch[1].replace(/,/g, ''));
  if (isNaN(baseNum)) return null;

  const unit = numMatch[2]?.toLowerCase();
  if (unit === 'million' || unit === 'mn' || unit === 'm') {
    return Math.round(baseNum * 1_000_000);
  }
  if (unit === 'lakh' || unit === 'lakhs') {
    return Math.round(baseNum * 100_000);
  }
  if (unit === 'k') {
    return Math.round(baseNum * 1_000);
  }
  return baseNum;
}

/**
 * Parses all financial parameters from promo text, maintaining strict field boundaries.
 */
export function parseFinancialTerms(text: string): ParsedFinancialTerms {
  const warnings: string[] = [];
  if (!text || typeof text !== 'string') {
    return {
      minimum_transaction_amount: null,
      minimum_spend_state: 'NO_MINIMUM_SPECIFIED',
      minimum_spend_condition: null,
      maximum_transaction_amount: null,
      maximum_discount_amount: null,
      discount_percentage: null,
      discount_qualifier: null,
      currency: 'LKR',
      warnings: ['Empty or non-string input provided to financial terms parser'],
    };
  }

  // ── 1. Discount Percentage & Qualifier ───────────────────────────────────────
  let discountPercentage: number | null = null;
  let discountQualifier: DiscountQualifier | null = null;

  // Check for multiple percentage values ("15% & 20%", "up to 20% or 30%")
  const allPctMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  if (allPctMatches.length > 1) {
    discountQualifier = 'TIERED';
    // Take the maximum percentage offered in multi-tier promotion
    const pcts = allPctMatches.map((m) => parseFloat(m[1])).filter((p) => !isNaN(p));
    if (pcts.length > 0) {
      discountPercentage = Math.max(...pcts);
      warnings.push(`Multiple discount percentages detected (${pcts.join('%, ')}%); selected maximum ${discountPercentage}% with TIERED qualifier`);
    }
  } else if (allPctMatches.length === 1) {
    discountPercentage = parseFloat(allPctMatches[0][1]);
  }

  // Qualifiers
  if (/up\s+to\s+\d+(?:\.\d+)?\s*%/i.test(text) || /\bmaximum\s+(?:of\s+)?\d+(?:\.\d+)?\s*%\s+discount/i.test(text)) {
    discountQualifier = 'UP_TO';
  } else if (/flat\s+\d+(?:\.\d+)?\s*%/i.test(text)) {
    discountQualifier = 'FLAT';
  } else if (/starting\s+(?:from|at)\s+\d+(?:\.\d+)?\s*%/i.test(text)) {
    discountQualifier = 'STARTING_AT';
  } else if (/additional\s+\d+(?:\.\d+)?\s*%/i.test(text)) {
    discountQualifier = 'ADDITIONAL';
  }

  // ── 2. Maximum Discount Amount (Discount Cap) ────────────────────────────────
  // Must ONLY match discount cap, NEVER transaction amount
  let maxDiscountAmount: number | null = null;
  const maxDiscountPattern = /(?:maximum|max)\s+discount(?:\s+(?:cap|amount|value))?(?:\s+(?:is|of|at|capped\s+at))?\s*[:=\-–—\s]+\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;
  const discountCapPattern = /(?:discount\s+)?(?:is\s+)?capped\s+at\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;

  const maxDiscountMatch = text.match(maxDiscountPattern) || text.match(discountCapPattern);
  if (maxDiscountMatch) {
    maxDiscountAmount = parseCurrencyAmount(maxDiscountMatch[1]);
  }

  // ── 3. Minimum Transaction Amount ───────────────────────────────────────────
  let minTxAmount: number | null = null;
  let minSpendState: MinimumSpendState = 'NO_MINIMUM_SPECIFIED';
  let minSpendCondition: string | null = null;

  // Check for cumulative spend versus per-transaction spend
  if (/cumulative\s+(?:spend|spending|bill|purchases?)/i.test(text)) {
    warnings.push('Cumulative spend requirement detected across promo period');
    minSpendCondition = 'Cumulative spend requirement';
  }

  // Check for explicit "no minimum spend"
  if (/(?:no\s+minimum\s+(?:spend|bill|purchase|transaction)|any\s+(?:bill\s+value|transaction\s+amount|purchase\s+amount)|without\s+(?:any\s+)?minimum\s+spend)/i.test(text)) {
    minSpendState = 'NO_MINIMUM_SPECIFIED';
    minTxAmount = null;
    minSpendCondition = 'Explicitly stated no minimum spend requirement';
  } else {
    // 1. Standard "minimum spend/bill/transaction/purchase/order/invoice/booking" pattern
    const minTxPattern = /(?:minimum|min)\s+(?:total\s+)?(?:bill|spend|transaction|purchase|invoice|order|booking)(?:\s+(?:value|amount|threshold))?(?:\s+at\s+[^.:]+?)?(?:\s+(?:is|of|required))?\s*[:=\-–—\s]+\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;

    // 2. "Eligible transaction threshold" / "minimum threshold of"
    const thresholdPattern = /(?:eligible\s+transaction\s+threshold|minimum\s+(?:spend\s+)?threshold)(?:\s+of)?\s*[:=\-–—\s]+\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;

    // 3. "Bills/purchases/transactions of/exceeding/above/over Rs. X"
    const exceedingPattern = /(?:on\s+|for\s+)?(?:bills?|purchases?|transactions?|orders?|invoices?)\s+(?:of|exceeding|above|over|and\s+above)\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;

    // 4. "Rs. X and above / or more on total bill"
    const andAbovePattern = /(?:Rs\.?|LKR)\s*([\d,]+(?:\.\d+)?)\s*(?:and\s+above|or\s+more|\+)\s*(?:on\s+total\s+bill|on\s+bill|for\s+bill|per\s+transaction|per\s+bill)?/i;

    // 5. Installment minimum transaction ("minimum installment transaction Rs. 25,000")
    const installmentMinPattern = /minimum\s+(?:installment\s+)?(?:transaction|bill|amount|value)(?:\s+for\s+installments?)?\s*[:=\-–—\s]+\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;

    const minMatch = text.match(minTxPattern) ||
                     text.match(thresholdPattern) ||
                     text.match(installmentMinPattern) ||
                     text.match(exceedingPattern) ||
                     text.match(andAbovePattern);

    if (minMatch) {
      minTxAmount = parseCurrencyAmount(minMatch[1]);
      if (minTxAmount !== null && minTxAmount > 0) {
        minSpendState = 'EXPLICIT_MINIMUM';
        minSpendCondition = minMatch[0].trim();
      }
    } else if (/(?:minimum\s+(?:spend|bill|purchase)|conditions?\s+apply\s+on\s+bill\s+value)/i.test(text)) {
      minSpendState = 'UNKNOWN_OR_AMBIGUOUS';
      warnings.push('Ambiguous minimum spend mentioned in text without extractable numeric threshold');
    }
  }

  // ── 4. Maximum Transaction Amount ───────────────────────────────────────────
  // CRITICAL: Must match transaction/bill/spend limits, NEVER "maximum discount"
  let maxTxAmount: number | null = null;
  const maxTxPattern = /(?:maximum|max)\s+(?:total\s+)?(?:bill|spend|transaction|purchase|order)(?:\s+(?:value|amount|limit))?(?:\s+at\s+[^.:]+?)?(?:\s+(?:is|of))?\s*[:=\-–—\s]+\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:k|mn|million|lakh))?)(?:\/-)?/i;
  const maxTxMatch = text.match(maxTxPattern);
  if (maxTxMatch) {
    maxTxAmount = parseCurrencyAmount(maxTxMatch[1]);
  }

  // ── 5. Range Pattern ("Rs. 10,000 to Rs. 50,000") ───────────────────────────
  // Only evaluate range if min or max tx amount wasn't already explicitly matched
  if (minTxAmount === null && maxTxAmount === null) {
    const rangeMatch = text.match(/(?:Rs\.?|LKR)\s*([\d,]+(?:\.\d+)?(?:\s*(?:Million|Lakh|Mn|k|m))?)\s*(?:to|[-–—])\s*(?:Rs\.?|LKR)?\s*([\d,]+(?:\.\d+)?(?:\s*(?:Million|Lakh|Mn|k|m))?)(?:\/-)?/i);
    if (rangeMatch) {
      // Validate that this range isn't adjacent to "discount" or "date" words
      const preContext = text.substring(Math.max(0, (rangeMatch.index ?? 0) - 20), rangeMatch.index ?? 0);
      if (!/discount|period|validity|date/i.test(preContext)) {
        let rMin = parseCurrencyAmount(rangeMatch[1]);
        let rMax = parseCurrencyAmount(rangeMatch[2]);
        if (rMin !== null && rMax !== null && rMin > rMax) {
          const tmp = rMin;
          rMin = rMax;
          rMax = tmp;
        }
        minTxAmount = rMin;
        maxTxAmount = rMax;
        if (minTxAmount !== null && minTxAmount > 0) {
          minSpendState = 'EXPLICIT_MINIMUM';
          minSpendCondition = rangeMatch[0].trim();
        }
      }
    }
  }

  // ── 6. Sanity Checks & Contradictions ───────────────────────────────────────
  if (minTxAmount !== null && maxTxAmount !== null && minTxAmount > maxTxAmount) {
    warnings.push(`Contradictory transaction range: minimum (${minTxAmount}) exceeds maximum (${maxTxAmount}); discarding invalid maximum transaction amount`);
    maxTxAmount = null;
  }

  if (minTxAmount !== null && minTxAmount <= 0) {
    warnings.push(`Zero or negative minimum transaction amount (${minTxAmount}) discarded`);
    minTxAmount = null;
  }

  if (maxTxAmount !== null && maxTxAmount <= 0) {
    warnings.push(`Zero or negative maximum transaction amount (${maxTxAmount}) discarded`);
    maxTxAmount = null;
  }

  if (maxDiscountAmount !== null && maxDiscountAmount <= 0) {
    warnings.push(`Zero or negative maximum discount amount (${maxDiscountAmount}) discarded`);
    maxDiscountAmount = null;
  }

  return {
    minimum_transaction_amount: minTxAmount,
    minimum_spend_state: minSpendState,
    minimum_spend_condition: minSpendCondition,
    maximum_transaction_amount: maxTxAmount,
    maximum_discount_amount: maxDiscountAmount,
    discount_percentage: discountPercentage,
    discount_qualifier: discountQualifier,
    currency: 'LKR',
    warnings,
  };
}

/**
 * Adapter helper to map parsed financial terms directly onto the core TransactionRange entity.
 */
export function extractStructuredTransactionRange(text: string): {
  transactionRange: TransactionRange;
  terms: ParsedFinancialTerms;
} {
  const terms = parseFinancialTerms(text);
  return {
    transactionRange: {
      min: terms.minimum_transaction_amount,
      max: terms.maximum_transaction_amount,
      currency: 'LKR',
    },
    terms,
  };
}
