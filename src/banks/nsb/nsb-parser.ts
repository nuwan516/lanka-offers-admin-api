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

export interface NSBListItem {
  title: string;
  excerpt: string;
  thumbnailUrl: string | null;
  detailUrl: string | null;
  _categoryName?: string;
  _categoryId?: number;
}

export interface NSBDetailPage {
  title: string;
  paragraphs: string[];
  listItems: string[];
  images: string[];
  promoPeriod: string | null;
  fullText: string;
}

export interface NSBRawOffer {
  listing: NSBListItem;
  detail: NSBDetailPage | null;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

/**
 * NSB offer pages are much looser than the other banks': no labeled
 * Merchant/Address/Period fields, just a title and free-text paragraphs +
 * bullet terms. Everything is mined from that prose.
 */
export function parseNSBOffer(raw: NSBRawOffer): Offer | null {
  const listing = raw.listing;
  const detail = raw.detail;

  const title = stripHtml(detail?.title || listing.title || '').trim();
  if (!title) return null;

  const bodyParts = [listing.excerpt, ...(detail?.paragraphs ?? []), ...(detail?.listItems ?? [])];
  const description = stripHtml(bodyParts.filter(Boolean).join('\n'));
  // Card type/network is often only stated in the marketing headline
  // ("... with your NSB Mastercard Debit Card!"), never in the body prose.
  const cardText = `${title} ${description}`;

  const merchantName = extractMerchantName(title, description);
  const addresses = addressEngine.extract(description, merchantName);

  const image = listing.thumbnailUrl || detail?.images?.[0] || null;
  const logo: ImageInfo | null = image ? { url: ensureAbsolute(image), alt: title, type: 'logo' } : null;

  let location: string | null = addresses[0]?.split(',')[0]?.trim() ?? null;
  if (location && (/^(?:mastercard|visa|credit|debit|all\s+cards?|cards?)$/i.test(location) || location.toLowerCase() === merchantName.toLowerCase() || location.toLowerCase() === title.toLowerCase())) {
    location = null;
  }

  const merchant: Merchant = {
    name: merchantName,
    location,
    addresses,
    phone: extractPhones(description),
    email: [],
    website: null,
    logo,
  };

  const ruleContext = {
    bank: 'nsb',
    category: listing._categoryName ?? 'General',
    sourceType: 'html-http',
    rawOffer: { ...listing, ...(detail ?? {}) } as Record<string, unknown>,
  };

  const isUpTo = /\b(?:up\s*to|upto)\s+\d+%/i.test(cardText);
  const discountRaw = applyRegexRule('nsb', 'discount_pct', cardText, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('nsb', 'booking_required', description, /booking|reservation/i, ruleContext),
    restrictions: [
      ...extractRestrictions(description),
      ...(isUpTo ? ['Discount is "up to" the stated percentage, may vary by item/venue'] : []),
    ],
    specialConditions: [],
    generalTerms: detail?.listItems ?? [],
  };

  const cardEligibility: CardEligibility = {
    includedCards: [],
    excludedCards: [],
    cardTypes: [
      ...(applyKeywordRule('nsb', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(cardText),
    restrictions: [],
  };

  // "Promo period – 10th to 31st December 2025" is a labeled field when
  // present; otherwise mine the same free-text prose as everything else.
  const periodText = detail?.promoPeriod || description;

  const sourceId = sourceIdFromUrl(listing.detailUrl) ?? stableHash(['nsb', title, description]);

  return {
    uniqueId: stableOfferId({
      source: 'nsb',
      sourceId,
      sourceUrl: listing.detailUrl,
      merchantName,
      title,
      category: listing._categoryName,
      address: addresses[0],
    }),
    source: 'nsb',
    sourceId,
    sourceUrl: listing.detailUrl,
    title,
    category: listing._categoryName ?? 'General',
    categoryId: listing._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(description),
    transactionRange: extractTransactionRange(description, ruleContext),
    cardEligibility,
    images: { logo, gallery: [], images: logo ? [logo] : [] },
    validityPeriods: parsePeriod(periodText, { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['nsb', title, description], 64),
    rawHtml: detail?.fullText || description,
  };
}

function ensureAbsolute(url: string): string {
  return url.startsWith('http') ? url : `https://www.nsb.lk${url.startsWith('/') ? '' : '/'}${url}`;
}

function sourceIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').filter(Boolean).at(-1) ?? null;
}

/**
 * No "Merchant:" label exists at all — titles are marketing headlines
 * ("Spend and Win with your NSB Mastercard Debit Card!"), so the merchant
 * is usually just NSB itself unless the description names a specific
 * external partner ("at <Merchant>").
 */
export function extractMerchantName(title: string, description: string): string {
  // 1. Direct bank promotion check (cashback, savings promos) when no partner in title or description
  if (
    /\b(?:cash\s*back|spend and win|account holders)\b/i.test(title) &&
    !/(?:at|@)\s+/i.test(title) &&
    !/(?:at|@)\s+/i.test(description)
  ) {
    return 'National Savings Bank';
  }

  // 2. Title extraction: check "@" or "at"
  const titleMatch = title.match(/(?:^|\s)(?:at|@)\s+([A-Za-z0-9&'’.\s-]{2,60}?)(?:\s*\([^)]*\))?(?:\s+(?:with|for|on|valid|until|every|by\s+NSB)\b|[!?]|$)/i);
  if (titleMatch && titleMatch[1].trim().length > 1) {
    let candidate = titleMatch[1].trim();
    candidate = candidate.replace(/\s*\([^)]*\)\s*$/, '').trim();
    candidate = candidate.replace(/\s+Online(?:\s*(?:&|and)\s*In\s+store)?/i, '').trim();
    if (!/^(?:selected|all|any|our)\s+outlets?/i.test(candidate) && candidate.length > 0) {
      return candidate;
    }
  }

  // 3. Description extraction
  const descMatch = description.match(/(?:^|\s)(?:at|@)\s+([A-Z][A-Za-z0-9&'’.\s-]{2,60}?)(?:\s+(?:with|for|on|valid|until|every)\b|[!?.,\n]|$)/i);
  if (descMatch && descMatch[1].trim().length > 1) {
    const candidate = descMatch[1].trim();
    if (!/^(?:selected|all|any|our)\s+outlets?/i.test(candidate)) {
      return candidate;
    }
  }

  // 4. Broad title at/@ match
  const broadAt = title.match(/(?:^|\s)(?:at|@)\s+([A-Za-z0-9&'’.\s-]{2,60})/i);
  if (broadAt) {
    let candidate = broadAt[1]
      .replace(/\s+(?:with|for|on|by)\s+(?:your\s+)?NSB\b.*$/i, '')
      .replace(/[!?.]+$/, '')
      .trim();
    if (candidate.length > 1 && !/^(?:selected|all|any|our)\s+outlets?/i.test(candidate)) {
      return candidate;
    }
  }

  // 5. If title itself doesn't contain NSB or bank marketing filler, fall back to title
  if (!/\b(?:nsb|national savings|savings bank|cardholders?)\b/i.test(title)) {
    return title.replace(/[!?.]+$/, '').trim();
  }

  return 'National Savings Bank';
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
  return [...new Set((text.match(/(?:\+94|0)?[\d\s/-]{7,}/g) ?? []).map((p) => p.replace(/\s+/g, ' ').trim()))];
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+(?:spend|bill|transaction)/i.test(text)) restrictions.push('Minimum spend required');
  return restrictions;
}

function extractTransactionRange(text: string, context?: Record<string, unknown>): TransactionRange {
  return {
    min: applyTransactionRule('nsb', 'transaction_min', text,
      /minimum\s+(?:spend|bill|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
    max: applyTransactionRule('nsb', 'transaction_max', text,
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
