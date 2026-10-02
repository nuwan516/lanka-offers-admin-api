import * as cheerio from 'cheerio';
import { HttpClient } from '@/infrastructure/http/http-client';
import { BankCategory } from '@/config/banks';
import { SampathListItem, SampathDetailPage } from './sampath-parser';

// ─── API response shapes ──────────────────────────────────────────────────────

interface SampathApiResponse {
  data?: SampathListItem[];
  offers?: SampathListItem[];
  totalPages?: number;
  total_pages?: number;
  /** Live API (July 2026) paginates via total/size/page_number, not totalPages. */
  total?: number;
  size?: number;
  page_number?: number;
}

// ─── SampathFetcher ───────────────────────────────────────────────────────────

/**
 * Fetches Sampath Bank promotions from their API + detail pages.
 *
 * Sampath API endpoint: https://www.sampath.lk/api/card-promotions?category=<slug>&page=<n>
 * Detail pages: https://www.sampath.lk/<detail_url> (HTML, parsed with Cheerio)
 */
export class SampathFetcher {
  private static readonly BASE_WEB_URL = 'https://www.sampath.lk';
  private static readonly BASE_API_URL = 'https://www.sampath.lk/api/card-promotions';

  constructor(
    private readonly http: HttpClient,
    private readonly skipDetails = false,
  ) {}

  // ── List fetching ──────────────────────────────────────────────────────────

  async fetchList(category: BankCategory): Promise<SampathListItem[]> {
    const firstUrl = category.url.includes('{page}')
      ? category.url.replace('{page}', '1')
      : `${SampathFetcher.BASE_API_URL}?category=${category.slug ?? category.name.toLowerCase().replace(/\s+/g, '_')}&page=1`;

    const { data: firstPage } = await this.http.getJSON<SampathApiResponse>(firstUrl);
    const items: SampathListItem[] = [...(firstPage.data ?? firstPage.offers ?? [])];
    const totalPages =
      firstPage.totalPages ??
      firstPage.total_pages ??
      (firstPage.total && firstPage.size ? Math.ceil(firstPage.total / firstPage.size) : 1);

    if (totalPages > 1) {
      const pageNums = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
      const pages = await Promise.all(
        pageNums.map(async (page) => {
          const url = category.url.includes('{page}')
            ? category.url.replace('{page}', String(page))
            : `${SampathFetcher.BASE_API_URL}?category=${category.slug ?? category.name.toLowerCase().replace(/\s+/g, '_')}&page=${page}`;
          const { data } = await this.http.getJSON<SampathApiResponse>(url);
          return data.data ?? data.offers ?? [];
        }),
      );
      pages.forEach((p) => items.push(...p));
    }

    return items.map((item) => ({
      ...item,
      _categoryName: category.name,
      _categoryId: category.id,
    }));
  }

  // ── Detail page fetching ───────────────────────────────────────────────────

  async fetchDetail(item: SampathListItem): Promise<SampathDetailPage | null> {
    // The list API rarely includes a detail URL — derive it from the id
    // (detail pages live at /sampath-cards/credit-card-offer/<id>).
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

    // Parse structured info boxes (Sampath-specific CSS class).
    // Labels are manually entered and wildly inconsistent (July 2026 survey:
    // 15 address-label variants incl. misspellings "Loacation"/"Paticipating"/
    // "Paricipating"/"Restuarants"; period labels Promotion/Booking/Stay/Travel,
    // sometimes two on one offer) — match loosely and in the right order.
    $('.aliya-resort-and-spa-box').each((_, box) => {
      const heading = $(box).find('.box-heading').text().trim();
      const content = $(box).find('.box-txt').text().trim();
      if (!content) return;

      if (/^partners?$/i.test(heading)) partner = content;
      else if (/period/i.test(heading)) periodEntries.push({ heading, content });
      // "cation" covers Location + the Loacation typo; "cipating" covers every
      // Participating/Paticipating/Paricipating variant; outlets covers
      // Partner(ing) Outlet(s)
      else if (/cation|outlets?|cipating/i.test(heading)) {
        if (!location) location = content;
        if (!fullAddress) fullAddress = content;
      } else if (/eligible\s+card/i.test(heading)) eligibleCards = content;
      else if (/reservation\s+numbers?|inquir/i.test(heading)) reservationNumber = content;
      else if (/reservation\s+e-?mail/i.test(heading)) reservationEmail = content;
    });

    // A lone "Promotion Period" stays bare; typed labels (Booking/Stay/Travel)
    // and dual-period offers keep their label prefix so the period engine can
    // assign PeriodType per entry.
    const promotionPeriod = buildPeriodText(periodEntries);

    // Promotion details text
    const promoDetailsHeading = $('h1:contains("Promotion Details")');
    const promotionDetailsText =
      promoDetailsHeading.length > 0
        ? promoDetailsHeading.next('p').text().trim() || null
        : null;

    // Terms & Conditions
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

function buildPeriodText(entries: Array<{ heading: string; content: string }>): string | null {
  if (entries.length === 0) return null;
  if (entries.length === 1 && /promotion\s+period/i.test(entries[0].heading)) {
    return entries[0].content;
  }
  return entries.map((e) => `${e.heading}: ${e.content}`).join(' ');
}
