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

export interface ComBankListItem {
  title: string;
  categoryLabel: string;
  discountText: string;
  discountPercentage: number | null;
  isUpTo: boolean;
  validityRaw: string;
  imageUrl: string | null;
  detailUrl: string | null;
  _categoryId?: number;
}

export interface ComBankDetailSectionEntry {
  type: 'note' | 'item';
  text: string;
  lines?: string[];
}

export interface ComBankDetailPage {
  mainImageUrl: string | null;
  sections: Record<string, ComBankDetailSectionEntry[]>;
}

export interface ComBankRawOffer {
  listing: ComBankListItem;
  detail: ComBankDetailPage | null;
}

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

/**
 * ComBank lists every category on one page (unlike DFCC/NDB/People's), so
 * the real per-offer category comes from the listing row, not the fetch-level
 * BankCategory. Detail pages split terms into named sections via bold-
 * underlined headers ("Offer terms and conditions" vs the bank's boilerplate
 * "Terms and conditions") — only offer-specific sections feed the description,
 * so boilerplate doesn't dilute discount/validity extraction.
 */
export function parseComBankOffer(raw: ComBankRawOffer): Offer | null {
  const listing = raw.listing;
  const detail = raw.detail;
  const title = stripHtml(listing.title).trim();
  if (!title) return null;

  const offerSections = pickOfferSpecificSections(detail?.sections);
  const description = stripHtml(
    [listing.discountText, ...offerSections.map((e) => e.text)].filter(Boolean).join('\n'),
  );

  const merchantName = extractMerchantName(title);
  const addresses = addressEngine.extract(description, merchantName);

  const image = listing.imageUrl || detail?.mainImageUrl || null;
  const logo: ImageInfo | null = image ? { url: image, alt: title, type: 'logo' } : null;
  const cardText = `${title} ${description}`;

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
    bank: 'combank',
    category: listing.categoryLabel ?? 'General',
    sourceType: 'html-http',
    rawOffer: { ...listing, ...(detail ?? {}) } as Record<string, unknown>,
  };

  const discountRaw = applyRegexRule('combank', 'discount_pct', description, /(\d+(?:\.\d+)?)\s*%/, ruleContext);
  const offer: OfferDetails = {
    description,
    discountPercentage: listing.discountPercentage ?? (discountRaw ? parseFloat(discountRaw) : null),
    applicableCards: extractCardTypes(cardText),
    bookingRequired: applyKeywordRule('combank', 'booking_required', description, /booking|reservation/i, ruleContext),
    restrictions: [
      ...extractRestrictions(description),
      ...(listing.isUpTo ? ['Discount is "up to" the stated percentage, may vary by item/venue'] : []),
    ],
    specialConditions: [],
    generalTerms: offerSections.map((e) => e.text),
  };

  const cardEligibility: CardEligibility = {
    includedCards: [],
    excludedCards: [],
    cardTypes: [
      ...(applyKeywordRule('combank', 'card_types', cardText, /credit/i, ruleContext) ? ['Credit Card'] : []),
      ...(/debit/i.test(cardText) ? ['Debit Card'] : []),
    ],
    networks: extractNetworks(cardText),
    restrictions: [],
  };

  // Prefer the listing's own validity text; fall back to offer-specific
  // section prose (which sometimes restates or refines it, e.g. adding the
  // per-outlet minimum bill value that the card-front summary omits).
  const periodText = listing.validityRaw || description;

  // Two listing tiles can resolve to the IDENTICAL detail URL while carrying
  // different badge/validity metadata (confirmed live: two "Singapore" tiles,
  // one "Up to 52% Off / valid till 31st August 2027", one "Best Offer /
  // valid till 31st December 2026", same slug). Deriving sourceId from the
  // URL alone would collide and the global dedupe step would silently drop
  // one entry's data — so listing-specific fields are always folded in too.
  const urlSlug = sourceIdFromUrl(listing.detailUrl);
  const sourceId = stableHash([
    'combank',
    urlSlug ?? title,
    listing.validityRaw,
    listing.discountText,
    listing.categoryLabel,
  ]);

  return {
    uniqueId: stableOfferId({
      source: 'combank',
      sourceId,
      sourceUrl: listing.detailUrl,
      merchantName,
      title,
      category: listing.categoryLabel,
      address: addresses[0],
    }),
    source: 'combank',
    sourceId,
    sourceUrl: listing.detailUrl,
    title,
    category: listing.categoryLabel || 'General',
    categoryId: listing._categoryId ?? null,
    cardType: cardEligibility.cardTypes.join(', '),
    scrapedAt: new Date().toISOString(),
    merchant,
    offer,
    installmentPlans: extractInstallmentPlans(description),
    transactionRange: extractTransactionRange(description),
    cardEligibility,
    images: { logo, gallery: [], images: logo ? [logo] : [] },
    // The headline validity line is the primary window; some offers also
    // bury a DISTINCT secondary window inside the bullets ("Stay Period –
    // Till 30th September 2026" alongside a different headline offer date)
    // — both must be kept, not just the headline.
    validityPeriods: [
      ...parsePeriod(periodText, { defaultPeriodType: PeriodType.OFFER }),
      ...extractSecondaryPeriods(offerSections),
    ],
    contentHash: stableHash(['combank', title, description, listing.validityRaw], 64),
    rawHtml: [listing.validityRaw, description].filter(Boolean).join('\n\n'),
  };
}

const SECONDARY_PERIOD_LINE = /^(?:Stay|Booking|Travel)\s+Periods?\s*[-–:]/i;

/**
 * Bullets like "Stay Period – Till 30th September 2026" name a DISTINCT
 * window from the headline offer date and are easy to miss if only the
 * headline validity line is parsed — each matching bullet is parsed on its
 * own (its own label anchors the period type) and appended.
 */
function extractSecondaryPeriods(offerSections: ComBankDetailSectionEntry[]) {
  return offerSections
    .filter((e) => SECONDARY_PERIOD_LINE.test(e.text))
    .flatMap((e) => parsePeriod(e.text, { defaultPeriodType: PeriodType.OFFER }));
}

/**
 * "Offer terms and conditions" (and similar offer-specific headers, incl.
 * "Offer Terms and conditions" and "Call and Convert - Terms and
 * conditions") carry the discount/venue/validity detail; the bank-wide
 * bare "Terms and conditions" boilerplate section is excluded so it
 * doesn't pollute description/discount extraction with generic eligibility
 * text repeated on every offer.
 *
 * BUT ~1/3 of offers (LankaPay cashback, ABS facility, AICPA/CIMA, Q+ toll,
 * etc.) skip the offer-specific heading entirely and put everything —
 * discount, dates, promo code — inside the ONLY section, which happens to
 * be named exactly "Terms and conditions". Excluding it there would throw
 * away the offer's entire content, so the bare-name exclusion only applies
 * when another, more specific section exists alongside it.
 */
function pickOfferSpecificSections(
  sections: Record<string, ComBankDetailSectionEntry[]> | undefined,
): ComBankDetailSectionEntry[] {
  if (!sections) return [];
  const headings = Object.keys(sections);
  const hasOfferSpecificHeading = headings.some((h) => !/^terms and conditions$/i.test(h.trim()));

  const entries: ComBankDetailSectionEntry[] = [];
  for (const [heading, items] of Object.entries(sections)) {
    if (hasOfferSpecificHeading && /^terms and conditions$/i.test(heading.trim())) continue;
    entries.push(...items);
  }
  return entries;
}

function sourceIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/[?#].*$/, '').replace(/\/$/, '').split('/').filter(Boolean).at(-1) ?? null;
}

/**
 * No labeled "Merchant:" field — titles are marketing sentences ("Enjoy the
 * art of dining at your favourite Softlogic Restaurants with ComBank Credit
 * and Debit Cards"). The merchant sits between "at" and the trailing
 * "with ComBank ... Cards" clause.
 */
// Marketing filler ("your favourite restaurant/holiday destination") that
// survives the "at X" extraction as generic lowercase noun(s), not a real
// merchant name — every actual merchant in this data is capitalized
// ("Cargills Online", "tudo.lk", "Cinnamon Hotels"), so "no capital letter
// anywhere in the capture" is a reliable signal to fall back to the title.
function isGenericPlaceholder(text: string): boolean {
  return text.length > 0 && !/[A-Z]/.test(text) && !/\.\w{2,3}$/.test(text);
}

function extractMerchantName(title: string): string {
  // 1. Locative match: "at/via <Merchant> with/using ComBank"
  const atViaAnchored = title.match(
    /\b(?:at|via)\s+(?:your\s+favourite\s+(?:holiday\s+destination\s+)?(?:\([^)]*\)\s*)?)?([A-Za-z0-9&'’.\s-]+?)\s+(?:using|with|and)\s+(?:all\s+)?(?:ComBank|Q\+|LankaPay)\b/i,
  );
  if (atViaAnchored) {
    let candidate = atViaAnchored[1].trim();
    candidate = candidate.replace(/^\((?:on\s+)?/i, '').replace(/\)$/, '').trim();
    if (
      !isGenericPlaceholder(candidate) &&
      !/^(?:selected|holiday destination|destination|restaurant|hotel)/i.test(candidate) &&
      candidate.length > 1
    ) {
      return candidate;
    }
  }

  // 2. Partner match: "with/from <Merchant> using/with/and ComBank"
  const withFromAnchored = title.match(
    /\b(?:with|from)\s+(?:your\s+favourite\s+(?:holiday\s+destination\s+)?(?:\([^)]*\)\s*)?)?([A-Za-z0-9&'’.\s-]+?)\s+(?:using|with|and)\s+(?:all\s+)?(?:ComBank|Q\+|LankaPay)\b/i,
  );
  if (withFromAnchored) {
    let candidate = withFromAnchored[1].trim();
    candidate = candidate.replace(/^\((?:on\s+)?/i, '').replace(/\)$/, '').trim();
    candidate = candidate.replace(/^(?:savings\s+on|discounts?\s+on)\s+/i, '').trim();
    if (
      !isGenericPlaceholder(candidate) &&
      !/^(?:selected|holiday destination|destination|restaurant|hotel)/i.test(candidate) &&
      candidate.length > 1
    ) {
      return candidate;
    }
  }

  // 3. Product brand: "savings on <Merchant/Brand> with ComBank"
  const onAnchored = title.match(
    /\b(?:savings\s+on|discounts?\s+on)\s+([A-Za-z0-9&'’.\s-]+?)\s+(?:using|with|and)\s+(?:all\s+)?(?:ComBank|Q\+|LankaPay)\b/i,
  );
  if (onAnchored) {
    let candidate = onAnchored[1].trim();
    if (!isGenericPlaceholder(candidate) && candidate.length > 1) {
      return candidate;
    }
  }

  // 4. Bare domain named directly in the title ("Great online deals with
  // tudo.lk using ComBank...") — no "at/via" preposition at all.
  const domainMatch = title.match(/\b([\w-]+\.(?:lk|com|net|org))\b/i);
  if (domainMatch) return domainMatch[1];

  // 5. Fallback "at/via <Merchant>"
  const atMatch = title.match(/\b(?:at|via)\s+(?:your\s+favourite\s+)?([^.,!]+)/i);
  if (atMatch) {
    const captured = atMatch[1].replace(/\s+(?:with|for|using)\s+(?:all\s+)?ComBank\b.*$/i, '').trim();
    if (!isGenericPlaceholder(captured) && !/^(?:selected|holiday destination|destination)/i.test(captured)) {
      return captured;
    }
  }

  // 6. Partner organization named with "for the Student and Members of <Merchant>"
  const partnerMatch = title.match(/\b(?:members?\s+of)\s+([^.,!]+)/i);
  if (partnerMatch) {
    return partnerMatch[1].trim();
  }

  // 7. If it's a general bank utility or payment facility
  if (
    /\b(?:hospital bills|education|bill settlement|insurance premiums?|cashback for expressway|0%\s*installment|travel insurance|medical care abroad|solar|supermarkets with lankapay)\b/i.test(
      title,
    )
  ) {
    return 'Commercial Bank';
  }

  return title.replace(/[!?.]+$/, '').trim();
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
  if (/amex|american express/i.test(text)) networks.push('Amex');
  return [...new Set(networks)];
}

function extractPhones(text: string): string[] {
  return [...new Set((text.match(/(?:\+94|0)?[\d\s/-]{7,}/g) ?? []).map((p) => p.replace(/\s+/g, ' ').trim()))];
}

function extractRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/subject to availability/i.test(text)) restrictions.push('Subject to availability');
  if (/minimum\s+bill\s+value/i.test(text)) restrictions.push('Minimum bill value required');
  return restrictions;
}

function extractTransactionRange(text: string): TransactionRange {
  const minFallback = /minimum\s+bill\s+value(?:\s+at\s+[^.]+)?\s+is\s+Rs\.?\s*([\d,]+)/i;
  const minFallback2 = /minimum\s+(?:spend|bill|transaction)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i;
  const txMin = applyTransactionRule('combank', 'transaction_min', text, minFallback)
    ?? applyTransactionRule('combank', 'transaction_min', text, minFallback2);
  return {
    min: txMin,
    max: applyTransactionRule('combank', 'transaction_max', text,
      /maximum\s+(?:bill|transaction|discount)(?:\s+value)?\s*[:-]?\s*Rs\.?\s*([\d,]+)/i),
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
