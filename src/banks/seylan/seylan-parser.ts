import {
  CardEligibility,
  ImageInfo,
  InstallmentPlan,
  Merchant,
  Offer,
  OfferDetails,
  TransactionRange,
} from '@/core/types/offers';
import { PeriodType } from '@/core/types/offers';
import { parsePeriod } from '@/parsing/period/period-engine';
import { AddressEngine } from '@/parsing/address/address-engine';
import { stripHtml } from '@/parsing/text/html';
import { stableHash, stableOfferId } from '@/parsing/normalization/offer-normalizer';
import { applyRegexRule, applyKeywordRule, applyTransactionRule } from '@/banks/bank-rules-loader';

export interface SeylanListItem {
  url: string;
  title?: string;
  rawHtml?: string;
  _categoryName?: string;
  _categoryId?: number;
}

export interface SeylanRawOffer extends SeylanListItem {
  title: string;
  description: string;
  address: string | null;
  phone: string[];
  validity: string;
  imageUrl: string | null;
  terms: string[];
  minTransaction: number | null;
  maxTransaction: number | null;
  rawDetailHtml: string;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

export function parseSeylanOffer(raw: SeylanRawOffer): Offer | null {
  const title = stripHtml(raw.title).trim();
  if (!title) return null;

  const description = stripHtml(raw.description || raw.terms.join('\n'));
  const termsText = raw.terms.join('\n');
  const rawText = [description, raw.address, termsText, raw.validity].filter(Boolean).join('\n');
  const addresses = raw.address
    ? addressEngine.extract(raw.address, title)
    : addressEngine.extract(rawText, title);

  const merchant: Merchant = {
    name: title,
    location: addresses[0]?.split(',')[0]?.trim() ?? raw.address ?? null,
    addresses,
    phone: raw.phone,
    email: [],
    website: null,
    logo: null,
  };

  const image = raw.imageUrl ? buildImage(raw.imageUrl, title) : null;
  merchant.logo = image;

  const ruleContext = {
    bank: 'seylan',
    category: raw._categoryName ?? 'General',
    sourceType: 'html-http',
    rawOffer: raw as unknown as Record<string, unknown>,
  };

  const offerText = [description, termsText].filter(Boolean).join('\n');
  const discountRaw = applyRegexRule('seylan', 'discount_pct', offerText, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const isUpTo = /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(`${title} ${offerText}`);
  const offer: OfferDetails = {
    description: description || termsText,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractApplicableCards(offerText),
    bookingRequired: applyKeywordRule('seylan', 'booking_required', offerText, /booking|reservation|prior appointment/i, ruleContext),
    restrictions: [
      ...extractRestrictions(offerText),
      ...(isUpTo ? ['Discount is "up to" the stated percentage, may vary by item/venue'] : []),
    ],
    specialConditions: [],
    generalTerms: raw.terms,
  };

  const cardEligibility: CardEligibility = {
    includedCards: extractIncludedCards(offerText),
    excludedCards: extractExcludedCards(offerText),
    cardTypes: [
      ...(applyKeywordRule('seylan', 'card_types', offerText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(offerText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(offerText),
    restrictions: [],
  };

  const sourceId = sourceIdFromUrl(raw.url);
  const uniqueId = stableOfferId({
    source: 'seylan',
    sourceId,
    sourceUrl: raw.url,
    merchantName: title,
    title,
    category: raw._categoryName,
    address: addresses[0] ?? raw.address,
    phone: raw.phone.join(','),
  });

  return {
    uniqueId,
    source: 'seylan',
    sourceId: sourceId ?? uniqueId,
    sourceUrl: raw.url,
    title,
    category: raw._categoryName ?? 'General',
    categoryId: raw._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(offerText),
    transactionRange: {
      min: raw.minTransaction ?? extractTransactionRange(offerText).min,
      max: raw.maxTransaction ?? extractTransactionRange(offerText).max,
      currency: 'LKR',
    },
    cardEligibility,
    images: { logo: image, gallery: image ? [image] : [], images: image ? [image] : [] },
    validityPeriods: parsePeriod(raw.validity || offerText, { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['seylan', title, offerText, raw.validity], 64),
    rawHtml: raw.rawDetailHtml,
  };
}

function buildImage(url: string, alt: string): ImageInfo {
  return {
    url: ensureAbsolute(url),
    alt,
    type: 'logo',
  };
}

function ensureAbsolute(url: string): string {
  if (url.startsWith('http')) return url;
  return `https://www.seylan.lk${url.startsWith('/') ? '' : '/'}${url}`;
}

function sourceIdFromUrl(url: string): string | null {
  const clean = url.replace(/[?#].*$/, '').replace(/\/$/, '');
  return clean.split('/').filter(Boolean).at(-1) ?? null;
}

function extractDiscount(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
}

function extractApplicableCards(text: string): string[] {
  return extractCardTypes(text);
}

function extractCardTypes(text: string): string[] {
  const cardTypes: string[] = [];
  if (/credit/i.test(text)) cardTypes.push('Credit Card');
  if (/debit/i.test(text)) cardTypes.push('Debit Card');
  return [...new Set(cardTypes)];
}

function extractNetworks(text: string): string[] {
  const networks: string[] = [];
  if (/visa/i.test(text)) networks.push('Visa');
  if (/mastercard|master\s+card/i.test(text)) networks.push('Mastercard');
  if (/amex|american express/i.test(text)) networks.push('Amex');
  return [...new Set(networks)];
}

function extractIncludedCards(text: string): string[] {
  const included: string[] = [];
  const match = text.match(/(?:valid|applicable)\s+(?:for|on)\s+([^.\n]+)/i);
  if (match) included.push(match[1].trim());
  return included;
}

function extractExcludedCards(text: string): string[] {
  const match = text.match(/(?:not\s+valid|excluding|except)\s+([^.\n]+)/i);
  if (!match) return [];
  const clause = match[1];
  if (/category|categories|packed|packeted|vegetable|produce|rice|sugar|flour|milk|liquor|tobacco|fuel|bill|service|tax|voucher/i.test(clause)) {
    return [];
  }
  return match[1]
    .split(/,\s*|\s*&\s*|\s+and\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/^(?:and|or|cards?)$/i.test(c))
    .filter((c) => /card|debit|credit|corporate|commercial|mastercard|visa|fuel/i.test(c));
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/cannot be combined|not be combined/i.test(text)) restrictions.push('Cannot be combined with other offers');
  if (/minimum\s+(?:transaction|spend|bill|purchase)/i.test(text)) restrictions.push('Minimum spend required');
  if (/blackout/i.test(text)) restrictions.push('Blackout dates apply');
  return restrictions;
}

function extractTransactionRange(text: string): TransactionRange {
  return {
    min: applyTransactionRule('seylan', 'transaction_min', text,
      /(?:minimum|min)\s+(?:transaction\s+)?(?:value|spend|bill|purchase)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[-:]?\s*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i),
    max: applyTransactionRule('seylan', 'transaction_max', text,
      /(?:maximum|max)\s+(?:transaction\s+)?(?:value|bill|spend)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[-:]?\s*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i),
    currency: 'LKR',
  };
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  const matches = text.matchAll(/(?:0\s*%\s*)?(?:easy\s+payment|installment|instalment|epp).*?(\d{1,2})\s*(?:months?|mths?)/gi);
  for (const match of matches) {
    const months = parseInt(match[1], 10);
    if (!Number.isNaN(months)) {
      plans.push({ months, interestRate: /0\s*%/.test(match[0]) ? 0 : 0, type: 'installment' });
    }
  }
  return plans;
}
