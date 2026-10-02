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

export interface PeoplesListItem {
  merchantName: string;
  discount: string;
  shortDescription: string;
  validityRaw: string;
  imageUrl: string | null;
  detailPageUrl: string | null;
  rawListHtml?: string;
  _categoryName?: string;
  _categoryId?: number;
  _cardType?: string;
}

export interface PeoplesDetailPage {
  sourceUrl: string;
  imageUrl: string | null;
  title: string | null;
  location: string | null;
  validityText: string | null;
  terms: string[];
  termsUrl: string | null;
  structuredTerms: {
    minimumSpend: number | null;
    maximumBill: number | null;
    minimumPax: number | null;
    maximumPax: number | null;
  };
  pdfTerms?: string[] | null;
  rawDetailHtml: string;
}

export interface PeoplesRawOffer {
  listing: PeoplesListItem;
  detail: PeoplesDetailPage | null;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka' });

export function parsePeoplesOffer(raw: PeoplesRawOffer): Offer | null {
  const listing = raw.listing;
  const detail = raw.detail;
  const merchantName = stripHtml(listing.merchantName || detail?.title || '').trim();
  if (!merchantName) return null;

  const title = stripHtml(detail?.title || listing.shortDescription || merchantName).trim();
  const terms = [...(detail?.terms ?? []), ...(detail?.pdfTerms ?? [])].filter(Boolean);
  const description = stripHtml([listing.discount, listing.shortDescription, terms.join('\n')].filter(Boolean).join('\n'));
  const validityRaw = listing.validityRaw || detail?.validityText || '';
  const location = detail?.location || null;
  const addressText = [location, description, terms.join('\n')].filter(Boolean).join('\n');
  const addresses = addressEngine.extract(addressText, merchantName);
  const image = buildImage(detail?.imageUrl || listing.imageUrl, title);

  const ruleContext = {
    bank: 'peoples',
    category: listing._categoryName ?? 'General',
    sourceType: 'html-http',
    rawOffer: { ...listing, ...(detail ?? {}) } as Record<string, unknown>,
  };

  const transactionRange = extractTransactionRange(description, detail, ruleContext);
  const cardText = `${description} ${listing._cardType ?? ''}`;
  const isUpTo = /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(listing.discount || '') || /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(description) || /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(title);
  const discountRaw = applyRegexRule('peoples', 'discount_pct', listing.discount || description, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('peoples', 'booking_required', description, /booking|reservation|prior appointment/i, ruleContext),
    restrictions: [
      ...extractRestrictions(description),
      ...(isUpTo ? ['Discount is "up to" the stated percentage, may vary by item/venue'] : []),
    ],
    specialConditions: [],
    generalTerms: terms,
  };

  const merchant: Merchant = {
    name: merchantName,
    location: addresses[0]?.split(',')[0]?.trim() ?? location ?? null,
    addresses,
    phone: extractPhones(description),
    email: [],
    website: null,
    logo: image,
  };

  const cardEligibility: CardEligibility = {
    includedCards: [],
    excludedCards: extractExcludedCards(description),
    cardTypes: [
      ...(applyKeywordRule('peoples', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(description),
    restrictions: [],
  };

  const sourceId = sourceIdFromUrl(listing.detailPageUrl);
  const uniqueId = stableOfferId({
    source: 'peoples',
    sourceId,
    sourceUrl: listing.detailPageUrl,
    merchantName,
    title,
    category: listing._categoryName,
    address: addresses[0] ?? location,
  });

  return {
    uniqueId,
    source: 'peoples',
    sourceId: sourceId ?? uniqueId,
    sourceUrl: listing.detailPageUrl,
    title,
    category: listing._categoryName ?? 'General',
    categoryId: listing._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(description),
    transactionRange,
    cardEligibility,
    images: { logo: image, gallery: image ? [image] : [], images: image ? [image] : [] },
    validityPeriods: parsePeriod(validityRaw, { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['peoples', merchantName, title, description, validityRaw], 64),
    rawHtml: [listing.rawListHtml, detail?.rawDetailHtml].filter(Boolean).join('\n\n') || undefined,
  };
}

function buildImage(url: string | null | undefined, alt: string): ImageInfo | null {
  if (!url) return null;
  return {
    url: ensureAbsolute(url),
    alt,
    type: 'logo',
  };
}

function ensureAbsolute(url: string): string {
  if (url.startsWith('http')) return url;
  return `https://www.peoplesbank.lk${url.startsWith('/') ? '' : '/'}${url}`;
}

function sourceIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const clean = url.replace(/[?#].*$/, '').replace(/\/$/, '');
  return clean.split('/').filter(Boolean).at(-1) ?? null;
}

function extractDiscount(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
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
  return [...new Set(networks)];
}

function extractExcludedCards(text: string): string[] {
  const match = text.match(/(?:excluding|except|not\s+valid\s+for)\s+([^.\n]+)/i);
  if (!match) return [];
  const clause = match[1];
  // If the exclusion clause describes non-card items (categories, produce, groceries, bills, etc.), ignore for card exclusions
  if (/category|categories|packed|packeted|vegetable|produce|rice|sugar|flour|milk|liquor|tobacco|fuel|bill|service|tax|voucher/i.test(clause)) {
    return [];
  }
  return clause
    .split(/,\s*|\s*&\s*|\s+and\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/^(?:and|or|cards?)$/i.test(c))
    .filter((c) => /card|debit|credit|corporate|commercial|mastercard|visa|fuel/i.test(c));
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+(?:spend|bill|transaction|pax)/i.test(text)) restrictions.push('Minimum spend or pax required');
  if (/maximum\s+(?:bill|discount|pax)/i.test(text)) restrictions.push('Maximum cap applies');
  if (/blackout|excluding special promotional events/i.test(text)) restrictions.push('Exclusions or blackout dates apply');
  if (/excluding\s+(?:categories|items|tobacco|liquor|gift|alcohol|packed|produce)/i.test(text)) {
    restrictions.push('Selected items or categories excluded');
  }
  return restrictions;
}

function extractTransactionRange(text: string, detail: PeoplesDetailPage | null, context?: Record<string, unknown>): TransactionRange {
  const minRegex = /(?:minimum|min)\s+(?:spend|bill|transaction)(?:\s+value)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[:\s-]*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i;
  const maxRegex = /(?:maximum|max)\s+(?:bill|transaction|discount)(?:\s+value)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[:\s-]*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i;
  const txMin = detail?.structuredTerms.minimumSpend ??
    applyTransactionRule('peoples', 'transaction_min', text, minRegex, context);
  const txMax = detail?.structuredTerms.maximumBill ??
    applyTransactionRule('peoples', 'transaction_max', text, maxRegex, context);
  return { min: txMin, max: txMax, currency: 'LKR' };
}

function extractPhones(text: string): string[] {
  const matches = text.match(/(?:\+94|0)?[\d\s/-]{7,}/g) ?? [];
  return [...new Set(matches.map((phone) => phone.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  for (const match of text.matchAll(/(?:0\s*%\s*)?(?:installment|instalment|easy\s+payment|epp).*?(\d{1,2})\s*(?:months?|mths?)/gi)) {
    const months = parseInt(match[1], 10);
    if (!Number.isNaN(months)) {
      plans.push({ months, interestRate: 0, type: 'installment' });
    }
  }
  return plans;
}
