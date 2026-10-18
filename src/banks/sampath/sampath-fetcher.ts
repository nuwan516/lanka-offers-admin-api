/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from 'cheerio';
import { HttpClient } from '@/infrastructure/http/http-client';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { BankCategory } from '@/config/banks';
import { SampathListItem, SampathDetailPage } from './sampath-parser';

// ─── API response shapes ──────────────────────────────────────────────────────

interface SampathApiResponse {
  data?: SampathListItem[];
  offers?: SampathListItem[];
  totalPages?: number;
  total_pages?: number;
  total?: number;
  size?: number;
  page_number?: number;
}

// ─── SampathFetcher ───────────────────────────────────────────────────────────

/**
 * Robust fetcher for Sampath Bank promotions.
 * Supports:
 * 1. Headless browser extraction of hydrated Nuxt state (`window.__NUXT__.state.promotion.cardPromotions`)
 * 2. Fallback to HTTP Nuxt SSR HTML parsing and REST API endpoint
 * 3. Detail page scraping with Cheerio for address, contact numbers, and terms
 */
export class SampathFetcher {
  private static readonly BASE_WEB_URL = 'https://www.sampath.lk';
  private static readonly BASE_API_URL = 'https://www.sampath.lk/api/card-promotions';
  private readonly browser?: BrowserClient;
  private readonly skipDetails: boolean;
  private cachedAllPromos: SampathListItem[] | null = null;

  constructor(
    private readonly http: HttpClient,
    browserOrSkipDetails?: BrowserClient | boolean,
    skipDetails = false,
  ) {
    if (typeof browserOrSkipDetails === 'boolean') {
      this.skipDetails = browserOrSkipDetails;
      this.browser = undefined;
    } else {
      this.browser = browserOrSkipDetails;
      this.skipDetails = skipDetails;
    }
  }

  // ── List fetching ──────────────────────────────────────────────────────────

  async fetchList(category: BankCategory): Promise<SampathListItem[]> {
    const slug = category.slug ?? category.name.toLowerCase().replace(/\s+/g, '_');

    // Strategy 1: Headless browser extraction of hydrated Nuxt state
    if (this.browser) {
      try {
        if (!this.cachedAllPromos) {
          const browserUrl = `${SampathFetcher.BASE_WEB_URL}/sampath-cards/credit-card-offer`;
          const rawItems = await this.browser.extract<Record<string, any>[]>(
            browserUrl,
            extractRawNuxtPromotionsFromPage,
            {
              waitUntil: 'networkidle2',
              waitForSelector: '.card-promo-slider, .aliya-resort-and-spa-box, body',
              waitForSelectorTimeoutMs: 15000,
            },
          );

          if (rawItems && rawItems.length > 0) {
            this.cachedAllPromos = rawItems.map(normalizeNuxtPromoItem);
          }
        }

        if (this.cachedAllPromos && this.cachedAllPromos.length > 0) {
          if (slug === 'all' || category.id === 0 || category.name.toLowerCase() === 'all') {
            return this.cachedAllPromos.map((item) => ({
              ...item,
              _categoryName: category.name,
              _categoryId: category.id,
            }));
          }

          const targetCat = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
          const relevant = this.cachedAllPromos.filter((o) => {
            if (!o.category) return false;
            const itemCat = o.category.toLowerCase().replace(/[^a-z0-9]/g, '');
            return itemCat === targetCat || itemCat.includes(targetCat) || targetCat.includes(itemCat);
          });

          return relevant.map((item) => ({
            ...item,
            _categoryName: category.name,
            _categoryId: category.id,
          }));
        }
      } catch {
        // Fall back to HTTP strategies
      }
    }

    // Strategy 2: HTTP API endpoint with pagination support
    const firstUrl = category.url.includes('{page}')
      ? category.url.replace('{page}', '1')
      : category.url.includes('/api/')
      ? category.url
      : `${SampathFetcher.BASE_API_URL}?category=${slug}&page_number=1&size=20`;

    try {
      const { data: firstPage } = await this.http.getJSON<SampathApiResponse>(firstUrl);
      const items: SampathListItem[] = [...(firstPage.data ?? firstPage.offers ?? [])];

      const totalPages =
        firstPage.totalPages ??
        firstPage.total_pages ??
        (firstPage.total && firstPage.size ? Math.ceil(firstPage.total / firstPage.size) : 1);

      if (totalPages > 1 && items.length > 0) {
        const pageNums = Array.from({ length: Math.min(totalPages - 1, 10) }, (_, i) => i + 2);
        const pages = await Promise.all(
          pageNums.map(async (page) => {
            const url = category.url.includes('{page}')
              ? category.url.replace('{page}', String(page))
              : `${SampathFetcher.BASE_API_URL}?category=${slug}&page_number=${page}&size=20`;
            const { data } = await this.http.getJSON<SampathApiResponse>(url);
            return data.data ?? data.offers ?? [];
          }),
        );
        pages.forEach((p) => items.push(...p));
      }

      if (items.length > 0) {
        return items.map((item) => ({
          ...item,
          _categoryName: category.name,
          _categoryId: category.id,
        }));
      }
    } catch {
      // API call failed or timed out
    }

    // Strategy 3: HTTP SSR HTML parse for inline cards if API is empty
    try {
      const webUrl = `${SampathFetcher.BASE_WEB_URL}/sampath-cards/credit-card-offer?firstTab=${slug}`;
      const { data: html } = await this.http.getHTML(webUrl);
      const parsedItems = parseSampathHtmlListing(html, category);
      if (parsedItems.length > 0) {
        return parsedItems;
      }
    } catch {
      // HTTP SSR fetch failed
    }

    return [];
  }

  // ── Detail page fetching ───────────────────────────────────────────────────

  async fetchDetail(item: SampathListItem): Promise<SampathDetailPage | null> {
    const detailPath =
      item.detail_url ?? (item.id != null ? `/sampath-cards/credit-card-offer/${item.id}` : null);
    if (this.skipDetails || !detailPath) return null;

    const url = detailPath.startsWith('http')
      ? detailPath
      : `${SampathFetcher.BASE_WEB_URL}${detailPath}`;

    try {
      const { data: html } = await this.http.getHTML(url);
      return this.parseDetailPage(html, url);
    } catch {
      return null;
    }
  }

  // ── Detail page parser (Cheerio) ───────────────────────────────────────────

  private parseDetailPage(html: string, sourceUrl: string): SampathDetailPage {
    const $ = cheerio.load(html);

    const images: Array<{ url: string; alt: string; type: string }> = [];
    $('img[src*="/api/uploads/"]').each((_, elem) => {
      const src = $(elem).attr('src');
      const alt = $(elem).attr('alt') ?? '';
      if (src?.includes('/api/uploads/')) {
        const fullUrl = src.startsWith('http')
          ? src
          : `${SampathFetcher.BASE_WEB_URL}${src}`;
        images.push({
          url: fullUrl,
          alt,
          type: alt.toLowerCase().includes('promotion') ? 'promotion' : 'general',
        });
      }
    });

    let partner: string | null = null;
    let location: string | null = null;
    let fullAddress: string | null = null;
    let eligibleCards: string | null = null;
    let reservationNumber: string | null = null;
    let reservationEmail: string | null = null;
    const periodEntries: Array<{ heading: string; content: string }> = [];

    $('.aliya-resort-and-spa-box').each((_, box) => {
      const heading = $(box).find('.box-heading').text().trim();
      const content = $(box).find('.box-txt').text().trim();
      if (!content) return;

      if (/^partners?$/i.test(heading)) partner = content;
      else if (/period/i.test(heading)) periodEntries.push({ heading, content });
      else if (/cation|outlets?|cipating/i.test(heading)) {
        if (!location) location = content;
        if (!fullAddress) fullAddress = content;
      } else if (/eligible\s+card/i.test(heading)) eligibleCards = content;
      else if (/reservation\s+numbers?|inquir/i.test(heading)) reservationNumber = content;
      else if (/reservation\s+e-?mail/i.test(heading)) reservationEmail = content;
    });

    const promotionPeriod = buildPeriodText(periodEntries);

    const promoDetailsHeading = $('h1:contains("Promotion Details")');
    const promotionDetailsText =
      promoDetailsHeading.length > 0
        ? promoDetailsHeading.next('p').text().trim() || null
        : null;

    const termsArray: string[] = [];
    const termsHeading = $('h1:contains("Terms")').last();
    if (termsHeading.length > 0) {
      const termsHtml = termsHeading.next('p').html() ?? '';
      termsHtml.split(/<br\s*\/?>\s*<br\s*\/?>/i).forEach((part) => {
        const clean = part.replace(/<[^>]*>/g, '').trim().replace(/^\d+\.\s*/, '');
        if (clean.length > 10) termsArray.push(clean);
      });
    }

    return {
      sourceUrl,
      images,
      partner,
      location,
      fullAddress,
      promotionPeriod,
      eligibleCards,
      reservationNumber,
      reservationEmail,
      promotionDetailsText,
      termsArray,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPeriodText(entries: Array<{ heading: string; content: string }>): string | null {
  if (entries.length === 0) return null;
  if (entries.length === 1 && /promotion\s+period/i.test(entries[0].heading)) {
    return entries[0].content;
  }
  return entries.map((e) => `${e.heading}: ${e.content}`).join(' ');
}

/**
 * In-browser extractor executed in Puppeteer context.
 * Interrogates `window.__NUXT__` and DOM elements.
 */
/**
 * In-browser extractor executed in Puppeteer context.
 * Returns raw objects directly without relying on Node-only closures.
 */
export function extractRawNuxtPromotionsFromPage(): Record<string, any>[] {
  const w = (globalThis as any).window;
  const doc = (globalThis as any).document;

  const statePromos =
    (Array.isArray(w?.__NUXT__?.state?.home?.cardPromotions) && w.__NUXT__.state.home.cardPromotions.length > 0)
      ? w.__NUXT__.state.home.cardPromotions
      : w?.__NUXT__?.state?.promotion?.cardPromotions;

  if (Array.isArray(statePromos) && statePromos.length > 0) {
    return statePromos;
  }

  // Fallback to DOM elements if state was empty
  if (doc) {
    const cardElements = Array.from(
      doc.querySelectorAll('.card-promo-slider .hooper-slide, .aliya-resort-and-spa-box, [class*="offer-card"]'),
    ) as any[];

    return cardElements
      .map((el, i) => {
        const title = el.querySelector('h3, h4, h5, .title, .box-heading')?.textContent?.trim();
        const discount = el.querySelector('.discount, [class*="discount"]')?.textContent?.trim();
        const cardType = el.querySelector('.card-type, [class*="card"]')?.textContent?.trim();
        const link = el.querySelector('a')?.getAttribute('href') || '';
        const img = el.querySelector('img')?.getAttribute('src') || '';

        return {
          id: `dom_${i + 1}`,
          title: title || 'Sampath Card Promotion',
          company_name: title || '',
          short_discount: discount || '',
          discount: discount || '',
          eligible_card_categories: cardType || '',
          detail_url: link || undefined,
          image_url: img || undefined,
        };
      })
      .filter((item) => item.title || item.discount);
  }

  return [];
}

/**
 * In-browser extractor executed in Puppeteer context or unit tests.
 */
export function extractSampathPromotionsFromPage(): SampathListItem[] {
  return extractRawNuxtPromotionsFromPage().map(normalizeNuxtPromoItem);
}

/**
 * Normalizes any Nuxt promo object into a resilient SampathListItem without
 * depending on a rigid array position or exact key casing.
 * Fully unpacks cards_new metadata, terms, and date timestamps.
 */
export function normalizeNuxtPromoItem(p: Record<string, any>): SampathListItem {
  const id = p.id ?? p.uat_id ?? p.slug ?? `sampath_${Math.random().toString(36).slice(2, 7)}`;

  // Unpack cards_new if present
  let partnerFromCards: string | undefined;
  let periodFromCards: string | undefined;
  let eligibleCardsFromCards: string | undefined;
  let contactFromCards: string | undefined;
  let locationFromCards: string | undefined;

  if (Array.isArray(p.cards_new) && p.cards_new.length > 0) {
    const periodParts: string[] = [];
    for (const c of p.cards_new) {
      const t = String(c?.title || '').trim().toLowerCase();
      const rawDesc = String(c?.description || '').replace(/<[^>]*>/g, '').trim();
      if (!rawDesc) continue;

      if (t === 'partner' || t === 'hotel' || t === 'merchant') {
        if (!partnerFromCards) partnerFromCards = rawDesc;
      } else if (t.includes('period') || t.includes('date')) {
        periodParts.push(`${c.title}: ${rawDesc}`);
      } else if (t.includes('card')) {
        if (!eligibleCardsFromCards) eligibleCardsFromCards = rawDesc;
      } else if (t.includes('number') || t.includes('phone') || t.includes('hotline') || t.includes('inquir')) {
        if (!contactFromCards) contactFromCards = rawDesc;
      } else if (t.includes('location') || t.includes('outlet') || t.includes('address')) {
        if (!locationFromCards) locationFromCards = rawDesc;
      }
    }
    if (periodParts.length > 0) {
      periodFromCards = periodParts.join(' ');
    }
  }

  const partner = p.partner || partnerFromCards;
  const company = p.company_name || partner || p.merchant_name || p.title || '';
  const title = p.title || partner || p.merchant_name || p.company_name || 'Sampath Promotion';
  const discount = p.short_discount || p.discount || p.discount_percentage || p.discounts || '';
  const desc = p.description || p.promotion_details || p.short_description || '';
  const period =
    periodFromCards ||
    p.promotion_period ||
    p.validity_period ||
    (p.valid_to ? `${p.valid_from ? p.valid_from + ' to ' : ''}${p.valid_to}` : '');

  const cards = Array.isArray(p.cards)
    ? p.cards
    : Array.isArray(p.eligible_cards)
    ? p.eligible_cards
    : p.eligible_card_categories
    ? [p.eligible_card_categories]
    : [];

  const rawImg =
    p.image ||
    p.image_url ||
    p.logo ||
    (typeof p.images === 'string' ? p.images : Array.isArray(p.images) ? p.images[0]?.url : undefined);

  const imageUrl = rawImg
    ? String(rawImg).startsWith('http')
      ? String(rawImg)
      : `https://www.sampath.lk${rawImg}`
    : undefined;

  const detailUrl = p.detail_url
    ? p.detail_url
    : p.slug
    ? `/sampath-cards/credit-card-offer/${p.slug}`
    : p.id
    ? `/sampath-cards/credit-card-offer/${p.id}`
    : undefined;

  return {
    id,
    title: String(title).replace(/<[^>]*>/g, '').trim(),
    company_name: String(company).replace(/<[^>]*>/g, '').trim(),
    merchant_name: String(company).replace(/<[^>]*>/g, '').trim(),
    short_discount: String(discount).replace(/<[^>]*>/g, '').trim(),
    discount: String(discount).replace(/<[^>]*>/g, '').trim(),
    category: p.category ? String(p.category) : undefined,
    city: p.city ? String(p.city) : undefined,
    detail_url: detailUrl,
    image_url: imageUrl,
    expire_on: p.expire_on || p.valid_to,
    display_on: p.display_on || p.valid_from,
    eligible_cards: cards.map((c: any) => String(c).replace(/<[^>]*>/g, '').trim()),
    eligible_card_categories: typeof p.eligible_card_categories === 'string'
      ? p.eligible_card_categories.replace(/<[^>]*>/g, '').trim()
      : eligibleCardsFromCards || cards.join(', '),
    promotion_period: period ? String(period).trim() : undefined,
    promotion_details: desc ? String(desc).trim() : undefined,
    partner: partner ? String(partner).replace(/<[^>]*>/g, '').trim() : undefined,
    location: (p.location || locationFromCards) ? String(p.location || locationFromCards).replace(/<[^>]*>/g, '').trim() : undefined,
    short_description: p.short_description ? String(p.short_description).replace(/<[^>]*>/g, '').trim() : undefined,
    terms_and_conditions: p.terms_and_conditions ? String(p.terms_and_conditions).trim() : undefined,
    contact_no: (p.contact_no || p.phone || p.reservation_number || contactFromCards)
      ? String(p.contact_no || p.phone || p.reservation_number || contactFromCards).replace(/<[^>]*>/g, '').trim()
      : undefined,
  };
}

/**
 * Fallback Cheerio HTML listing parser when browser is unavailable.
 */
function parseSampathHtmlListing(html: string, category: BankCategory): SampathListItem[] {
  const $ = cheerio.load(html);
  const items: SampathListItem[] = [];

  $('.card-promo-slider .hooper-slide, .card-offer-box, a[href*="credit-card-offer/"]').each((i, el) => {
    const title = $(el).find('h3, h4, h5, .title, .box-heading').text().trim();
    const discount = $(el).find('.discount, [class*="discount"]').text().trim();
    const href = $(el).attr('href') || $(el).find('a').attr('href');
    if (title || discount) {
      items.push({
        id: href?.split('/').pop() || `html_${i + 1}`,
        title: title || 'Sampath Card Offer',
        company_name: title || '',
        short_discount: discount || '',
        discount: discount || '',
        detail_url: href,
        _categoryName: category.name,
        _categoryId: category.id,
      });
    }
  });

  return items;
}
