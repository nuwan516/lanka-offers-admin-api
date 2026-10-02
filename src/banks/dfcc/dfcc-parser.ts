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
import { stableHash, stableOfferId } from '@/parsing/normalization/offer-normalizer';
import { stripHtml } from '@/parsing/text/html';
import { applyRegexRule, applyKeywordRule, applyTransactionRule } from '@/banks/bank-rules-loader';

export interface DFCCListItem {
  cardType: string;
  offerText: string;
  /** Separate date-validity line from the card (.cardOfferValid) — the only
   *  source of real validity data since detail pages are dead (see fetcher). */
  validityText?: string;
  /** Structured percentage badge (.discount-badgee), distinct from cardType. */
  discountBadge?: string;
  imageUrl: string;
  imageAlt: string;
  detailUrl: string;
  _categoryName?: string;
  _categoryId?: number;
  _sourceUrl?: string;
}

export interface DFCCDetailPage {
  title: string;
  description: string;
  image: string;
  termsAndConditions: string[];
  rawText: string;
  termsAndConditionsPdfUrl?: string | null;
}

export interface DFCCRawOffer {
  listing: DFCCListItem;
  detail: DFCCDetailPage | null;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

export function parseDFCCOffer(raw: DFCCRawOffer): Offer | null {
  const listing = raw.listing;
  const detail = raw.detail;
  const sourceTitle = selectSourceTitle(listing, detail);

  const description = buildDescription(listing, detail);
  const merchantName = extractMerchantName(sourceTitle, description, listing);
  const title = buildOfferTitle(sourceTitle, merchantName, description);
  if (!title) return null;
  const addresses = addressEngine.extract(description, merchantName);
  const logo = buildImage(detail?.image || listing.imageUrl, title);
  const cardText = `${listing.cardType} ${description}`;

  const merchant: Merchant = {
    name: merchantName,
    location: addresses[0]?.split(',')[0]?.trim() ?? null,
    addresses,
    phone: extractPhones(description),
    email: [],
    website: null,
    logo,
  };

  const ruleContext = {
    bank: 'dfcc',
    category: listing._categoryName ?? 'General',
    sourceType: 'html-http',
    rawOffer: { ...listing, ...(detail ?? {}) } as Record<string, unknown>,
  };

  const discountRaw = applyRegexRule('dfcc', 'discount_pct', listing.discountBadge || description, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('dfcc', 'booking_required', description, /booking|reservation/i, ruleContext),
    restrictions: extractRestrictions(description),
    specialConditions: [],
    generalTerms: detail?.termsAndConditions ?? [],
  };

  const cardEligibility: CardEligibility = {
    includedCards: listing.cardType ? [listing.cardType] : [],
    excludedCards: [],
    cardTypes: [
      ...(applyKeywordRule('dfcc', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(cardText),
    restrictions: [],
  };

  const sourceId = sourceIdFromUrl(listing.detailUrl) ?? stableHash(['dfcc', listing.detailUrl, listing.cardType]);

  return {
    uniqueId: stableOfferId({
      source: 'dfcc',
      sourceId,
      sourceUrl: listing.detailUrl,
      merchantName,
      title,
      category: listing._categoryName,
      address: addresses[0],
    }),
    source: 'dfcc',
    sourceId,
    sourceUrl: listing.detailUrl || listing._sourceUrl || null,
    title,
    category: listing._categoryName ?? 'General',
    categoryId: listing._categoryId ?? null,
    cardType: listing.cardType,
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(description),
    transactionRange: extractTransactionRange(description, ruleContext),
    cardEligibility,
    images: { logo, gallery: [], images: logo ? [logo] : [] },
    // .cardOfferValid is the real validity line; description (the offer
    // sentence) rarely carries a date at all and is only a fallback.
    validityPeriods: parsePeriod(listing.validityText || description, { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['dfcc', title, description, listing.cardType], 64),
    // rawText includes appended PDF terms text when a T&C PDF was found and
    // extracted — full evidence for both parsing and LLM validation.
    rawHtml: [JSON.stringify(listing), detail?.rawText].filter(Boolean).join('\n\n'),
  };
}

function buildImage(url: string | undefined, alt: string): ImageInfo | null {
  return url ? { url, alt, type: 'logo' } : null;
}

function sourceIdFromUrl(url: string): string | null {
  return url.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').filter(Boolean).at(-1) ?? null;
}

function selectSourceTitle(listing: DFCCListItem, detail: DFCCDetailPage | null): string {
  const detailTitle = stripHtml(detail?.title ?? '').trim();
  const genericDetailTitle = detailTitle && detailTitle.toLowerCase() === listing._categoryName?.toLowerCase();
  if (detailTitle && !genericDetailTitle) return detailTitle;
  return stripHtml(listing.imageAlt || listing.offerText).trim();
}

function buildOfferTitle(sourceTitle: string, merchantName: string, description: string): string {
  if (sourceTitle && !isWeakTitle(sourceTitle) && !isLessSpecificThanMerchant(sourceTitle, merchantName)) {
    return sourceTitle;
  }

  const discountText = description.match(/(\d+(?:\.\d+)?)\s*%\s*(?:Savings|off)?/i)?.[0] ?? 'Offer';
  return `${discountText.replace(/\s+/g, ' ').trim()} at ${merchantName}`.trim();
}

function isWeakTitle(title: string): boolean {
  return /^\d+$/.test(title) || /banner|logo|web\s*banners?/i.test(title);
}

function isLessSpecificThanMerchant(title: string, merchantName: string): boolean {
  const normalizedTitle = title.toLowerCase();
  const normalizedMerchant = merchantName.toLowerCase();
  return normalizedMerchant.startsWith(normalizedTitle) && normalizedMerchant.length > normalizedTitle.length + 3;
}

function buildDescription(listing: DFCCListItem, detail: DFCCDetailPage | null): string {
  return [
    listing.offerText,
    detail?.description,
    ...(detail?.termsAndConditions ?? []),
  ]
    .filter((text): text is string => Boolean(text))
    .map((text) => stripHtml(text).trim())
    .filter((text) => text && !/About Us|Investor|Media Center|Corporate Information/i.test(text))
    .filter((text, index, all) => all.indexOf(text) === index)
    .join('\n');
}

function extractMerchantName(title: string, description: string, listing: DFCCListItem): string {
  const atMatch = description.match(/\bat\s+(.+?)(?:\s+for\s+bills?|\s+above\s+Rs|\s+over\s+Rs|\s+with\s+DFCC|\.|\n|$)/i);
  const textMerchant = atMatch?.[1] ? cleanMerchantName(atMatch[1]) : '';
  if (textMerchant) return textMerchant;

  const altMerchant = cleanMerchantName(listing.imageAlt);
  if (altMerchant && !/^\d+$/.test(altMerchant) && !/banner|logo|web/i.test(altMerchant)) return altMerchant;

  return cleanMerchantName(title.split(/[-|]/)[0]) || 'Unknown Merchant';
}

function cleanMerchantName(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .replace(/\s+/g, ' ')
    .replace(/^\s*all\s+/i, '')
    .replace(/\s+outlets?$/i, '')
    .replace(/\s*,\s*$/i, '')
    .trim();
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

function extractPhones(text: string): string[] {
  return [...new Set((text.match(/(?:\+94|0)?[\d\s/-]{7,}/g) ?? []).map((phone) => phone.replace(/\s+/g, ' ').trim()))];
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+(?:spend|bill|transaction)/i.test(text)) restrictions.push('Minimum spend required');
  return restrictions;
}

function extractTransactionRange(text: string, context?: Record<string, unknown>): TransactionRange {
  return {
    min: applyTransactionRule('dfcc', 'transaction_min', text,
      /minimum\s+(?:spend|bill|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
    max: applyTransactionRule('dfcc', 'transaction_max', text,
      /maximum\s+(?:bill|transaction|discount)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
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
