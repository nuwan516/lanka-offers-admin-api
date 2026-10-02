import { Offer, Merchant, OfferDetails, CardEligibility, TransactionRange, InstallmentPlan, ImageInfo } from '@/core/types/offers';
import { PeriodType } from '@/core/types/offers';
import { parsePeriod } from '@/parsing/period/period-engine';
import { AddressEngine } from '@/parsing/address/address-engine';
import { stripHtml } from '@/parsing/text/html';
import { applyRegexRule, applyKeywordRule, applyTransactionRule } from '@/banks/bank-rules-loader';
import * as crypto from 'crypto';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface SampathListItem {
  id: string | number;
  title: string;
  company_name?: string;
  merchant_name?: string;
  short_discount?: string;
  discount?: string;
  category?: string;
  city?: string;
  /** Relative URL to the detail page, e.g. "/sampath-cards/credit-card-offer/2150" */
  detail_url?: string;
  image_url?: string;
  expire_ts?: string;
  display_ts?: string;
  /** Live API (July 2026): epoch-milliseconds strings. */
  expire_on?: string | number;
  display_on?: string | number;
  eligible_cards?: string[];
  eligible_card_categories?: string;
  promotion_period?: string;
  promotion_details?: string;
  /** Inline copies of the detail-page info boxes (often empty in list responses). */
  partner?: string;
  location?: string;
  short_description?: string;
  terms_and_conditions?: string;
  contact_no?: string;
  /** Injected by scraper with category context. */
  _categoryName?: string;
  _categoryId?: number;
}

export interface SampathDetailPage {
  sourceUrl: string;
  images: Array<{ url: string; alt: string; type: string }>;
  partner: string | null;
  location: string | null;
  fullAddress: string | null;
  promotionPeriod: string | null;
  eligibleCards: string | null;
  reservationNumber: string | null;
  reservationEmail?: string | null;
  promotionDetailsText: string | null;
  termsArray: string[];
}

// ─── Address engine ───────────────────────────────────────────────────────────

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a Sampath list item + optional detail page into a complete Offer.
 */
export function parseSampathOffer(
  item: SampathListItem,
  detail: SampathDetailPage | null,
): Offer | null {
  const merchantName = stripHtml(item.company_name ?? item.merchant_name ?? item.title ?? '');
  if (!merchantName) return null;

  const rawPeriodText =
    item.promotion_period ||
    detail?.promotionPeriod ||
    '';

  const promoDetails = stripHtml(
    item.promotion_details ?? detail?.promotionDetailsText ?? '',
  );

  // ── Validity ────────────────────────────────────────────────────────────────
  // The labeled period field is the structured source — prefer it. Only when it
  // holds no parseable date (placeholder text like "Offer Details" appears on
  // some offers) fall back to mining the promotion-details prose.
  const probe = rawPeriodText ? parsePeriod(rawPeriodText, { defaultPeriodType: PeriodType.OFFER }) : [];
  const labeledFieldHasDates = probe.some((v) => v.validTo !== null || (v.recurrenceDays?.length ?? 0) > 0);
  const periodText = labeledFieldHasDates ? rawPeriodText : (promoDetails || rawPeriodText);
  const validityPeriods = parsePeriod(periodText, {
    apiFrom: epochMsToIsoDate(item.display_on) ?? item.display_ts ?? undefined,
    apiTo: epochMsToIsoDate(item.expire_on) ?? item.expire_ts ?? undefined,
    defaultPeriodType: PeriodType.OFFER,
  });

  // ── Merchant ────────────────────────────────────────────────────────────────
  const fullAddress = detail?.fullAddress ?? detail?.location ?? item.location ?? null;
  const city = item.city ?? '';

  const rawAddressText = `${fullAddress ?? ''} ${promoDetails}`.trim();
  // Bulleted multi-location lists ("• No 1, ... • No 2, ...") split into one
  // address per bullet; everything else stays whole.
  const addresses = fullAddress
    ? fullAddress.includes('•')
      ? fullAddress.split('•').map((a) => a.trim()).filter((a) => a.length > 3)
      : [city ? `${fullAddress}, ${city}` : fullAddress]
    : addressEngine.extract(rawAddressText, merchantName);

  const merchant: Merchant = {
    name: merchantName,
    location: detail?.location ?? (city || null),
    addresses,
    phone: item.contact_no ? [item.contact_no] : (detail?.reservationNumber ? [detail.reservationNumber] : []),
    email: detail?.reservationEmail ? [detail.reservationEmail] : [],
    website: null,
    logo: null,
  };

  // ── Offer details ───────────────────────────────────────────────────────────
  const ruleContext = {
    bank: 'sampath',
    category: item.category ?? null,
    sourceType: 'html-http',
    rawOffer: { ...item, ...(detail ?? {}) } as Record<string, unknown>,
  };

  const discountSrc = item.short_discount ?? item.discount ?? promoDetails;
  const discountRaw = applyRegexRule('sampath', 'discount_pct', discountSrc, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const discountPercentage = discountRaw ? parseFloat(discountRaw) : null;

  const offerDetails: OfferDetails = {
    description: promoDetails || stripHtml(item.short_discount ?? item.short_description ?? ''),
    discountPercentage,
    applicableCards: parseApplicableCards(
      item.eligible_cards ??
        (item.eligible_card_categories ? [item.eligible_card_categories] : null) ??
        (detail?.eligibleCards ? [detail.eligibleCards] : []),
    ),
    bookingRequired: applyKeywordRule('sampath', 'booking_required', promoDetails, /reservation|booking/i, ruleContext),
    restrictions: extractRestrictions(promoDetails),
    specialConditions: [],
    generalTerms: detail?.termsArray ?? [],
  };

  // ── Card eligibility ────────────────────────────────────────────────────────
  const cardEligibility: CardEligibility = {
    includedCards: item.eligible_cards ?? [],
    excludedCards: [],
    cardTypes: applyKeywordRule('sampath', 'card_types', promoDetails, /credit/i, ruleContext) ? ['Credit Card'] : [],
    networks: extractNetworks(promoDetails),
    restrictions: [],
  };

  // ── Images ──────────────────────────────────────────────────────────────────
  const images = buildImages(item, detail);

  // ── Transaction range ────────────────────────────────────────────────────────
  const transactionRange = extractTransactionRange(promoDetails, ruleContext);

  // ── Unique ID ────────────────────────────────────────────────────────────────
  const uniqueId = `sampath_${String(item.id)}`;

  return {
    uniqueId,
    source: 'sampath',
    sourceId: String(item.id),
    sourceUrl: detail?.sourceUrl ?? null,
    title: item.title ?? merchantName,
    category: item._categoryName ?? item.category ?? 'General',
    categoryId: item._categoryId ?? null,
    cardType: item.eligible_cards?.join(', ') ?? '',
    scrapedAt: new Date().toISOString(),
    merchant,
    offer: offerDetails,
    installmentPlans: extractInstallmentPlans(promoDetails),
    transactionRange,
    cardEligibility,
    images,
    validityPeriods,
    contentHash: crypto
      .createHash('sha256')
      .update(`${merchantName}|${promoDetails}`)
      .digest('hex'),
    // Raw source evidence — without it the LLM validator scores every offer
    // as unverifiable (NO_RAW_EVIDENCE).
    rawHtml: [
      `List item: ${JSON.stringify(item)}`,
      detail
        ? [
            detail.partner && `Partner: ${detail.partner}`,
            detail.fullAddress && `Location: ${detail.fullAddress}`,
            detail.promotionPeriod && `Period: ${detail.promotionPeriod}`,
            detail.eligibleCards && `Eligible Card Categories: ${detail.eligibleCards}`,
            detail.reservationNumber && `Reservation: ${detail.reservationNumber}`,
            detail.promotionDetailsText && `Promotion Details: ${detail.promotionDetailsText}`,
            detail.termsArray.length > 0 && `Terms: ${detail.termsArray.join(' | ')}`,
          ].filter(Boolean).join('\n')
        : '',
    ].filter(Boolean).join('\n\n'),
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * The live API sends expire_on/display_on as epoch-milliseconds strings.
 * Convert to a YYYY-MM-DD in Sri Lanka time (+5:30) so a midnight-SL expiry
 * doesn't land on the previous UTC day.
 */
function epochMsToIsoDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 1e12 || ms > 4e12) return null;
  return new Date(ms + 5.5 * 3_600_000).toISOString().split('T')[0];
}

function parseApplicableCards(eligibleCards: string[]): string[] {
  const result: string[] = [];
  for (const c of eligibleCards) {
    if (/credit/i.test(c)) result.push('Credit Card');
    if (/debit/i.test(c)) result.push('Debit Card');
  }
  return [...new Set(result)];
}

function extractRestrictions(text: string): string[] {
  const r: string[] = [];
  if (/cannot be combined/i.test(text)) r.push('Cannot be combined with other offers');
  if (/subject to availability/i.test(text)) r.push('Subject to availability');
  if (/minimum spend/i.test(text) || /minimum purchase/i.test(text)) r.push('Minimum spend required');
  return r;
}

function extractNetworks(text: string): string[] {
  const nets: string[] = [];
  if (/visa/i.test(text)) nets.push('Visa');
  if (/mastercard/i.test(text)) nets.push('Mastercard');
  if (/amex|american express/i.test(text)) nets.push('Amex');
  return nets;
}

function extractTransactionRange(text: string, context?: Record<string, unknown>): TransactionRange {
  const txMin = applyTransactionRule('sampath', 'transaction_min', text,
    /minimum\s+(?:bill|spend|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context);
  const txMax = applyTransactionRule('sampath', 'transaction_max', text,
    /maximum\s+(?:bill|transaction|discount)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i, context);
  if (txMin !== null || txMax !== null) return { min: txMin, max: txMax, currency: 'LKR' };

  const m = text.match(/Rs\.?\s*([\d,.]+(?:\s*(?:Million|Lakh|Mn|k|m))?)\s*(?:to|[-–])\s*Rs\.?\s*([\d,.]+(?:\s*(?:Million|Lakh|Mn|k|m))?)/i);
  if (m) {
    let min = parseAmount(m[1]);
    let max = parseAmount(m[2]);
    if (min !== null && max !== null && min > max) { const temp = min; min = max; max = temp; }
    return { min, max, currency: 'LKR' };
  }
  return { min: null, max: null, currency: 'LKR' };
}

function parseAmount(str: string): number | null {
  const num = parseFloat(str.replace(/[^\d.]/g, ''));
  if (isNaN(num)) return null;

  if (/million|mn|m/i.test(str)) {
      return num * 1_000_000;
  }
  if (/lakh/i.test(str)) {
      return num * 100_000;
  }
  if (/k/i.test(str)) {
      return num * 1_000;
  }
  return num;
}

function extractInstallmentPlans(text: string): InstallmentPlan[] {
  const plans: InstallmentPlan[] = [];
  const m = text.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\s*,\s*\d+)*(?:\s*&\s*\d+)?)\s*months/i);
  if (m) {
    const interest = parseFloat(m[1]);
    const months = m[2]
      .replace(/&/g, ',')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
    months.forEach((mo) => plans.push({ months: mo, interestRate: interest, type: 'installment' }));
  }
  return plans;
}

function buildImages(
  item: SampathListItem,
  detail: SampathDetailPage | null,
): { logo: ImageInfo | null; gallery: ImageInfo[]; images: ImageInfo[] } {
  const all: ImageInfo[] = [];

  if (item.image_url) {
    const url = item.image_url.startsWith('http')
      ? item.image_url
      : `https://www.sampath.lk${item.image_url}`;
    all.push({ url, alt: item.title ?? '', type: 'logo' });
  }

  if (detail?.images) {
    for (const img of detail.images) {
      if (!all.some((a) => a.url === img.url)) {
        all.push({ url: img.url, alt: img.alt, type: 'gallery' });
      }
    }
  }

  const logo = all.length > 0 ? { ...all[0], type: 'logo' as const } : null;
  return { logo, gallery: all.filter((i) => i.type === 'gallery'), images: all };
}
