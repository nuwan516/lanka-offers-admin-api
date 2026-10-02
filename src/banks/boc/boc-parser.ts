import { Offer, Merchant, OfferDetails, CardEligibility, TransactionRange, InstallmentPlan, ImageInfo } from '@/core/types/offers';
import { PeriodType } from '@/core/types/offers';
import { parsePeriod, parseHumanDate } from '@/parsing/period/period-engine';
import { AddressEngine } from '@/parsing/address/address-engine';
import { stripHtml } from '@/parsing/text/html';
import { applyRegexRule, applyKeywordRule } from '@/banks/bank-rules-loader';
import * as crypto from 'crypto';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface BOCRawOffer {
  /** Relative URL, e.g. "/credit-cards/promotions/dining/my-restaurant/product" */
  url: string;
  title: string;
  offerValue?: string;
  expirationDate?: string;
  imageUrl?: string;
  fullAddress?: string | null;
  location?: string | null;
  addresses?: string[];
  contactNumbers?: string[];
  description: string[];
  /** Injected by scraper with category context. */
  _categoryName?: string;
  _categoryId?: number;
}

// ─── Address engine ───────────────────────────────────────────────────────────

const addressEngine = new AddressEngine({ country: 'Sri Lanka' });

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a BOC raw offer (scraped from HTML) into a typed Offer.
 */
export function parseBOCOffer(raw: BOCRawOffer): Offer | null {
  const title = raw.title?.trim();
  if (!title) return null;

  const descriptionText = Array.isArray(raw.description)
    ? raw.description.join('\n')
    : (typeof raw.description === 'string' ? raw.description : ((raw as any).rawHtml || (raw as any).offer?.description || ''));
  const promoDetails = stripHtml(descriptionText);

  // ── Unique ID ────────────────────────────────────────────────────────────────
  const urlSlugMatch = raw.url?.match(/\/([^/]+)\/product$/);
  const urlId = urlSlugMatch ? urlSlugMatch[1] : null;
  const uniqueId = urlId
    ? `boc_${urlId}`
    : `boc_${crypto.createHash('sha256').update((`boc|${raw.url ?? ''}`).toLowerCase().trim()).digest('hex').substring(0, 16)}`;

  // ── Validity ─────────────────────────────────────────────────────────────────
  // BOC's universal "Expiration date : 31 Dec 2026" field is human-formatted;
  // normalize to ISO or parsePeriod will silently discard it as apiTo.
  const expiryIso = raw.expirationDate ? parseHumanDate(raw.expirationDate) : null;
  const rawPeriodText = promoDetails || (raw.expirationDate ? `Till ${raw.expirationDate}` : '');
  const validityPeriods = parsePeriod(rawPeriodText, {
    apiTo: expiryIso,
    defaultPeriodType: PeriodType.OFFER,
  });

  // ── Merchant ─────────────────────────────────────────────────────────────────
  // Line structure matters: BOC lists one branch address per description line
  const extractedAddresses =
    raw.addresses && raw.addresses.length > 0
      ? raw.addresses
      : addressEngine.extract(
          [raw.fullAddress ?? '', ...(Array.isArray(raw.description) ? raw.description : [descriptionText])].join('\n').trim(),
          title,
        );

  const merchant: Merchant = {
    name: title,
    location: (raw.location && raw.location.toLowerCase() !== title.toLowerCase())
      ? raw.location
      : (extractedAddresses.length > 0 && !extractedAddresses[0].startsWith(title) ? extractedAddresses[0].split(',')[0].trim() : null),
    addresses: extractedAddresses,
    phone: raw.contactNumbers ?? [],
    email: [],
    website: null,
    logo: null,
  };

  // ── Offer details ────────────────────────────────────────────────────────────
  const ruleContext = {
    bank: 'boc',
    category: raw._categoryName ?? null,
    sourceType: 'html-http',
    rawOffer: raw as unknown as Record<string, unknown>,
  };

  const isUpTo = /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(promoDetails) || /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(title);
  const discountRaw = applyRegexRule('boc', 'discount_pct', raw.offerValue ?? promoDetails, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const discountPercentage = discountRaw ? parseFloat(discountRaw) : null;
  const bookingRequired = applyKeywordRule('boc', 'booking_required', promoDetails, /reservation|booking/i, ruleContext);

  // ── Card eligibility ──────────────────────────────────────────────────────────
  const hasCredit = applyKeywordRule('boc', 'card_types', promoDetails, /credit/i, ruleContext);
  const hasDebit = /debit/i.test(promoDetails);
  const cardEligibility: CardEligibility = {
    includedCards: [],
    excludedCards: [],
    cardTypes: [
      ...(hasCredit ? ['Credit Card'] : []),
      ...(hasDebit ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(promoDetails),
    restrictions: [],
  };

  const offerDetails: OfferDetails = {
    description: promoDetails,
    discountPercentage,
    applicableCards: cardEligibility.cardTypes,
    bookingRequired,
    restrictions: [
      ...extractRestrictions(promoDetails),
      ...(isUpTo ? ['Discount is "up to" the stated percentage, may vary by item/venue'] : []),
    ],
    specialConditions: [],
    generalTerms: [],
  };

  // ── Images ────────────────────────────────────────────────────────────────────
  const logo: ImageInfo | null = raw.imageUrl
    ? { url: ensureAbsolute(raw.imageUrl), alt: title, type: 'logo' }
    : null;

  // ── Source URL ────────────────────────────────────────────────────────────────
  const sourceUrl = raw.url
    ? raw.url.startsWith('http')
      ? raw.url
      : `https://www.boc.lk${raw.url}`
    : null;

  return {
    uniqueId,
    source: 'boc',
    sourceId: urlId ?? uniqueId,
    sourceUrl,
    title,
    category: raw._categoryName ?? 'General',
    categoryId: raw._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer: offerDetails,
    installmentPlans: extractInstallmentPlans(promoDetails),
    transactionRange: extractTransactionRange(promoDetails),
    cardEligibility,
    images: { logo, gallery: [], images: logo ? [logo] : [] },
    validityPeriods,
    contentHash: crypto.createHash('sha256').update(`${title}|${promoDetails}`).digest('hex'),
    // Raw source text — without it the LLM validator has no evidence to
    // compare against and scores every offer as unverifiable.
    rawHtml: [raw.expirationDate ? `Expiration date : ${raw.expirationDate}` : '', descriptionText]
      .filter(Boolean)
      .join('\n'),
  };
}

// ─── Private helpers ───────────────────────────────────────────────────────────

function extractRestrictions(text: string): string[] {
  const r: string[] = [];
  if (/cannot be combined/i.test(text)) r.push('Cannot be combined with other offers');
  if (/subject to availability/i.test(text)) r.push('Subject to availability');
  if (/minimum spend/i.test(text)) r.push('Minimum spend required');
  return r;
}

function extractNetworks(text: string): string[] {
  const nets: string[] = [];
  if (/visa/i.test(text)) nets.push('Visa');
  if (/mastercard/i.test(text)) nets.push('Mastercard');
  return nets;
}

function extractTransactionRange(text: string): TransactionRange {
  const m = text.match(/Rs\.?\s*([\d,]+)\s*(?:to|[-–])\s*Rs\.?\s*([\d,]+)/i);
  if (m) {
    return { min: parseFloat(m[1].replace(/,/g, '')), max: parseFloat(m[2].replace(/,/g, '')), currency: 'LKR' };
  }
  return { min: null, max: null, currency: 'LKR' };
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  const m = text.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\s*,\s*\d+)*)\s*months/i);
  if (m) {
    const interest = parseFloat(m[1]);
    m[2].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
      .forEach((mo) => plans.push({ months: mo, interestRate: interest, type: 'installment' }));
  }
  return plans;
}

function ensureAbsolute(url: string): string {
  if (url.startsWith('http')) return url;
  return `https://www.boc.lk${url}`;
}
