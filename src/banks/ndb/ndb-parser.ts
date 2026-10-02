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

export interface NDBRawOffer {
  merchantName: string;
  website?: string;
  location?: string;
  phoneNumbers?: string[];
  phone?: string;
  offerDetails: string;
  validity: string;
  cardType?: string;
  coverImage?: string;
  merchantLogo?: string;
  detailUrl?: string;
  termsAndConditionsPdfUrl?: string | null;
  pdfText?: string | null;
  rawText?: string;
  _categoryName?: string;
  _categoryId?: number;
  _sourceUrl?: string;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka' });

export function parseNDBOffer(raw: NDBRawOffer): Offer | null {
  const merchantName = stripHtml(raw.merchantName).trim();
  const description = stripHtml(raw.offerDetails);
  if (!merchantName && !description) return null;

  const title = description || merchantName;
  const evidenceText = [raw.location, description, raw.pdfText, raw.validity].filter(Boolean).join('\n');
  const directLocation = raw.location ? addressEngine.normalize(raw.location, merchantName) : null;
  const addresses = directLocation ? [directLocation] : addressEngine.extract(evidenceText, merchantName);
  const logo = buildImage(raw.merchantLogo, merchantName, 'logo');
  const cover = buildImage(raw.coverImage, title, 'gallery');
  const images = [logo, cover].filter((img): img is ImageInfo => img !== null);
  const cardText = `${description} ${raw.cardType ?? ''} ${raw.pdfText ?? ''}`;

  const merchant: Merchant = {
    name: merchantName || title,
    location: addresses[0]?.split(',')[0]?.trim() ?? raw.location ?? null,
    addresses,
    // Hotline field uses "." / "-" placeholders when there is no number
    phone: [...new Set([...(raw.phoneNumbers ?? []), raw.phone ?? ''].filter((p) => p.replace(/\D/g, '').length >= 7))],
    email: [],
    website: raw.website ?? null,
    logo,
  };

  const ruleContext = {
    bank: 'ndb',
    category: raw._categoryName ?? 'General',
    sourceType: 'html-http',
    rawOffer: raw as unknown as Record<string, unknown>,
  };

  const discountRaw = applyRegexRule('ndb', 'discount_pct', description, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: discountRaw ? parseFloat(discountRaw) : null,
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('ndb', 'booking_required', cardText, /booking|reservation/i, ruleContext),
    restrictions: extractRestrictions(cardText),
    specialConditions: [],
    generalTerms: raw.pdfText ? raw.pdfText.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 80) : [],
  };

  const cardEligibility: CardEligibility = {
    includedCards: raw.cardType ? [raw.cardType] : [],
    excludedCards: [],
    cardTypes: [
      ...(applyKeywordRule('ndb', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(cardText),
    restrictions: [],
  };

  const sourceId = sourceIdFromUrl(raw.detailUrl) ?? stableHash(['ndb', merchantName, description, raw._categoryName]);

  return {
    uniqueId: stableOfferId({
      source: 'ndb',
      sourceId,
      sourceUrl: raw.detailUrl ?? raw._sourceUrl,
      merchantName,
      title,
      category: raw._categoryName,
      address: addresses[0] ?? raw.location,
      phone: merchant.phone.join(','),
    }),
    source: 'ndb',
    sourceId,
    sourceUrl: raw.detailUrl || raw._sourceUrl || null,
    title,
    category: raw._categoryName ?? 'General',
    categoryId: raw._categoryId ?? null,
    cardType: raw.cardType ?? cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(cardText),
    transactionRange: extractTransactionRange(cardText, ruleContext),
    cardEligibility,
    images: { logo, gallery: cover ? [cover] : [], images },
    validityPeriods: parsePeriod(raw.validity, { defaultPeriodType: PeriodType.OFFER }),
    contentHash: stableHash(['ndb', merchantName, description, raw.validity, raw._categoryName], 64),
    rawHtml: raw.rawText,
  };
}

function buildImage(url: string | undefined, alt: string, type: ImageInfo['type']): ImageInfo | null {
  if (!url) return null;
  return { url, alt, type };
}

function sourceIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  return url.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').filter(Boolean).at(-1) ?? null;
}

function extractDiscount(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? parseFloat(match[1]) : null;
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
  return [...new Set(networks)];
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+(?:bill|spend|transaction)/i.test(text)) restrictions.push('Minimum spend required');
  if (/blackout/i.test(text)) restrictions.push('Blackout dates apply');
  return restrictions;
}

function extractTransactionRange(text: string, context?: Record<string, unknown>): TransactionRange {
  return {
    min: applyTransactionRule('ndb', 'transaction_min', text,
      /minimum\s+(?:bill|spend|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
    max: applyTransactionRule('ndb', 'transaction_max', text,
      /maximum\s+(?:transaction|bill|discount)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context),
    currency: 'LKR',
  };
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  for (const match of text.matchAll(/(?:installment|instalment|easy\s+payment|epp).*?(\d{1,2})\s*(?:months?|mths?)/gi)) {
    const months = parseInt(match[1], 10);
    if (!Number.isNaN(months)) plans.push({ months, interestRate: 0, type: 'installment' });
  }
  return plans;
}
