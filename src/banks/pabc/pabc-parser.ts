import {
  CardEligibility,
  InstallmentPlan,
  Merchant,
  Offer,
  OfferDetails,
  TransactionRange,
} from '@/core/types/offers';
import { PeriodType } from '@/core/types/offers';
import { parsePeriod } from '@/parsing/period/period-engine';
import { AddressEngine } from '@/parsing/address/address-engine';
import { stableHash, stableOfferId } from '@/parsing/normalization/offer-normalizer';
import { stripHtml } from '@/parsing/text/html';
import { applyRegexRule, applyKeywordRule, applyTransactionRule } from '@/banks/bank-rules-loader';

export interface PABCRawOffer {
  imageUrl: string;
  imageAlt: string;
  discount: string;
  /**
   * The flip-card FRONT date (e.g. "15-07-2026"). This is the post date,
   * NOT the offer's expiry — the real validity lives in `description`
   * ("Offer valid until 31st July 2026"). Never feed this into parsePeriod.
   */
  validityDate: string;
  description: string;
  _categoryName?: string;
  _categoryId?: number;
  _sourceUrl?: string;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

export function parsePABCOffer(raw: PABCRawOffer): Offer | null {
  const description = stripHtml(raw.description);
  // imageAlt is ALWAYS the literal string "Avatar" on every PABC card (a
  // generic placeholder, not real content) — using it as a fallback would
  // make "Avatar" win over parsing the description whenever the "at X"
  // patterns fail to match, which is worse than no fallback at all.
  const usableFallback = raw.imageAlt && /^avatar$/i.test(raw.imageAlt.trim()) ? '' : (raw.imageAlt || '');
  const merchantName = extractMerchantName(description, usableFallback);
  if (!merchantName && !description) return null;

  const title = `${raw.discount || extractDiscountText(description) || 'Offer'} at ${merchantName}`.trim();
  const addresses = addressEngine.extract(description, merchantName);
  const logo = raw.imageUrl ? { url: raw.imageUrl, alt: raw.imageAlt || title, type: 'logo' as const } : null;
  const cardText = `${description} ${raw.discount}`;

  const merchant: Merchant = {
    name: merchantName || title,
    location: addresses[0]?.split(',')[0]?.trim() ?? null,
    addresses,
    phone: [],
    email: [],
    website: null,
    logo,
  };

  const maxDiscountLKR = extractMaxDiscountLKR(description);
  const ruleContext = {
    bank: 'pabc',
    category: raw._categoryName ?? 'Card Offers',
    sourceType: 'html-http',
    rawOffer: raw as unknown as Record<string, unknown>,
  };

  const discountRaw = applyRegexRule('pabc', 'discount_pct', cardText, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('pabc', 'booking_required', description, /booking|reservation/i, ruleContext),
    restrictions: [
      ...extractRestrictions(description),
      ...(maxDiscountLKR ? [`Maximum discount: LKR ${maxDiscountLKR}`] : []),
    ],
    specialConditions: [],
    generalTerms: [],
  };

  const paCardTypes = [
    ...(applyKeywordRule('pabc', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
    ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
  ];
  const cardEligibility: CardEligibility = {
    includedCards: paCardTypes,
    excludedCards: [],
    cardTypes: paCardTypes,
    networks: extractNetworks(cardText),
    restrictions: [],
  };

  const sourceId = stableHash(['pabc', raw._sourceUrl, merchantName, raw.validityDate, description]);

  return {
    uniqueId: stableOfferId({
      source: 'pabc',
      sourceId,
      sourceUrl: raw._sourceUrl,
      merchantName,
      title,
      category: raw._categoryName,
      address: addresses[0],
    }),
    source: 'pabc',
    sourceId,
    sourceUrl: raw._sourceUrl ?? null,
    title,
    category: raw._categoryName ?? 'Card Offers',
    categoryId: raw._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(description),
    transactionRange: extractTransactionRange(description, ruleContext),
    cardEligibility,
    images: { logo, gallery: [], images: logo ? [logo] : [] },
    // The description's "valid until/till" phrase is the real expiry; the
    // front-card date (raw.validityDate) is a post date and must not be used
    // as period input (it isn't a validity signal at all).
    validityPeriods: parsePeriod(extractValidityText(description), { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['pabc', merchantName, raw.discount, raw.validityDate, description], 64),
    rawHtml: JSON.stringify(raw),
  };
}

// Marketing filler that can follow a venue/merchant name before the real
// sentence boundary — cut the capture here rather than swallowing it.
// Covers: "... Oak Ray Elephant Lake, Habarana and enjoy exclusive
// discounts with your Pan Asia..." and "... Dinapala into a 12 & 24 Months
// 0% Instalment Plan with...".
const MERCHANT_TRAILING_FILLER =
  /\s+(?:and\s+(?:enjoy|receive|get)\b|with\s+(?:exclusive|special|flexible)\b|into\s+).*$/i;

function extractMerchantName(description: string, fallback: string): string {
  // Most specific first: "... at Singhagiri into 0% instalment plans ..." /
  // "... at Dinapala into a 12 & 24 Months 0% Instalment Plan ..." — the
  // merchant name sits between "at" and "into", not at "with/using your Pan
  // Asia" (which appears much later in the same sentence and would
  // otherwise swallow the "into ... instalment" clause too — tried first).
  // Non-greedy up to "instal?ment" since arbitrary filler ("a 12 & 24
  // Months 0%") can sit between "into" and the word "instalment".
  const instalmentMatch = description.match(
    /\bat\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})\s+into\s+.*?\binstal?ment/i,
  );
  if (instalmentMatch) return instalmentMatch[1].trim();

  // "... at Breeze Bar, Cheers Pub ... with/using your Pan Asia Bank Credit
  // Card" — anchoring on both ends avoids swallowing trailing prose
  // ("Softlogic using your Pan Asia..." from the looser fallback below).
  // MERCHANT_TRAILING_FILLER trims connector phrases the non-greedy match
  // would otherwise include ("... Habarana and enjoy exclusive discounts").
  const anchoredMatch = description.match(/\bat\s+([^.]+?)\s+(?:with|using)\s+your\s+Pan\s+Asia/i);
  if (anchoredMatch) return anchoredMatch[1].replace(MERCHANT_TRAILING_FILLER, '').trim();

  // Reached only when "with/using your Pan Asia" is in a LATER sentence
  // (anchoredMatch can't cross the period) — e.g. "at Oak Ray City Hotel
  // Kandy with exclusive cardholder privileges. Enjoy 35% off ...". Stop at
  // the first "with" clause too, since venue names never contain one.
  const stopAhead = /(?=\s+with\b|\s+(?:on|for)\s+(?:transactions?|purchases?)\b|[-,.!]|$)/;
  const atMatch =
    description.match(new RegExp(`\\bat\\s+([^-,.!]+?)${stopAhead.source}`, 'i')) ??
    description.match(new RegExp(`OFF\\s+at\\s+([^-,.!]+?)${stopAhead.source}`, 'i'));
  if (atMatch) return atMatch[1].replace(/\s+for\s+.*$/i, '').trim();

  return fallback || description.split(/[.!]/)[0].slice(0, 60).trim();
}

/** Pull the offer's real expiry phrase out of the description prose. */
function extractValidityText(description: string): string {
  const match =
    description.match(/\boffers?\s+valid\s+(?:until|till)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}/i) ??
    description.match(/\bvalid\s+(?:until|till)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}/i) ??
    // Bare "... packages until 31 October 2026" — the hotel-package offers
    // never say "valid" at all, just "until <date>" at the end of the
    // discount sentence.
    description.match(/\b(?:until|till)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}/i);
  return match ? match[0] : '';
}

function extractMaxDiscountLKR(description: string): string | null {
  const match = description.match(/Maximum\s+discount:?\s*LKR\s*([\d,]+)/i);
  return match ? match[1].replace(/,/g, '') : null;
}

function extractDiscountText(text: string): string | null {
  return text.match(/(\d+(?:\.\d+)?)\s*%\s*off/i)?.[0] ?? null;
}

function extractCardTypes(text: string): string[] {
  const types: string[] = [];
  if (/credit/i.test(text)) types.push('Credit Card');
  if (/debit/i.test(text)) types.push('Debit Card');
  return [...new Set(types)];
}

function extractNetworks(text: string): string[] {
  const networks: string[] = [];
  if (/visa/i.test(text)) networks.push('Visa');
  if (/mastercard|master\s+card/i.test(text)) networks.push('Mastercard');
  return networks;
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+(?:spend|bill|transaction)/i.test(text)) restrictions.push('Minimum spend required');
  return restrictions;
}

function extractTransactionRange(text: string, context?: Record<string, unknown>): TransactionRange {
  return {
    min: applyTransactionRule('pabc', 'transaction_min', text,
      /minimum\s+(?:spend|bill|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
    max: applyTransactionRule('pabc', 'transaction_max', text, null, context),
    currency: 'LKR',
  };
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  for (const match of text.matchAll(/(?:installment|instalment|easy\s+payment).*?(\d{1,2})\s*(?:months?|mths?)/gi)) {
    const months = parseInt(match[1], 10);
    if (!Number.isNaN(months)) plans.push({ months, interestRate: 0, type: 'installment' });
  }
  return plans;
}
