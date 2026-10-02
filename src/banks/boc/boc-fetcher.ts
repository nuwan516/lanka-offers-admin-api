import * as cheerio from 'cheerio';
import { HttpClient } from '@/infrastructure/http/http-client';
import { BankCategory } from '@/config/banks';
import { BOCRawOffer } from './boc-parser';
import { AddressEngine } from '@/parsing/address/address-engine';

const BASE_URL = 'https://www.boc.lk';

const addressEngine = new AddressEngine({ country: 'Sri Lanka', fallbackToMerchant: false });

// ─── BOCFetcher ───────────────────────────────────────────────────────────────

/**
 * Fetches BOC Bank promotions by HTML scraping with Cheerio.
 *
 * BOC uses a standard page listing with pagination. Each offer has a detail
 * page at /credit-cards/promotions/<category>/<slug>/product.
 */
export class BOCFetcher {
  /** Hub-page product URLs grouped by category slug (fetched once per run). */
  private hubLinksBySlug: Map<string, string[]> | null = null;

  constructor(private readonly http: HttpClient) {}

  // ── List fetching ──────────────────────────────────────────────────────────

  async fetchList(category: BankCategory): Promise<{ url: string; title: string }[]> {
    const items: { url: string; title: string }[] = [];
    let page = 1;

    for (;;) {
      const url = category.url.includes('{page}')
        ? category.url.replace('{page}', String(page))
        : page === 1
          ? category.url
          : '';
      if (!url) break;

      const { data: html } = await this.http.getHTML(url);
      const $ = cheerio.load(html);

      const found: { url: string; title: string }[] = [];
      $('.swiper-slide.product a, a.swiper-slide.product, .offer-item a, .product-item a, .card-offer-item a').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).find('h2, h3, .offer-title').first().text().trim() ||
          $(el).attr('title') ||
          href?.split('/').filter(Boolean).at(-2)?.replace(/-/g, ' ') ||
          '';
        if (href?.includes('/product')) {
          const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          found.push({ url: fullUrl, title: title.trim() });
        }
      });

      if (found.length === 0) break;
      items.push(...found.map((f) => ({ ...f })));

      if (!category.url.includes('{page}')) break;
      const hasNext = $('a.next, .pagination a[rel="next"]').length > 0;
      if (!hasNext) break;
      page++;
    }

    // Category pages are swiper carousels that only server-render the first
    // slides (e.g. Travel & Leisure shows 6 of 46). The card-offers hub page
    // lists every offer, so merge its links for this category.
    if (category.slug) {
      const hubLinks = await this.fetchHubLinks();
      const known = new Set(items.map((i) => i.url));
      for (const url of hubLinks.get(category.slug) ?? []) {
        if (known.has(url)) continue;
        const title = url.split('/').filter(Boolean).at(-2)?.replace(/-/g, ' ') ?? '';
        items.push({ url, title });
      }
    }

    return items;
  }

  /** Fetch the card-offers hub once and group its product links by category slug. */
  private async fetchHubLinks(): Promise<Map<string, string[]>> {
    if (this.hubLinksBySlug) return this.hubLinksBySlug;

    const map = new Map<string, string[]>();
    try {
      const { data: html } = await this.http.getHTML(`${BASE_URL}/personal-banking/card-offers`);
      const $ = cheerio.load(html);
      const seen = new Set<string>();
      $('a[href*="/product"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);
        const slugMatch = fullUrl.match(/card-offers\/([^/]+)\//);
        if (!slugMatch) return;
        const list = map.get(slugMatch[1]) ?? [];
        list.push(fullUrl);
        map.set(slugMatch[1], list);
      });
    } catch {
      // Hub unavailable — category pages alone still work, just incomplete.
    }

    this.hubLinksBySlug = map;
    return map;
  }

  // ── Detail page fetching ───────────────────────────────────────────────────

  async fetchDetail(raw: { url: string; title: string; _categoryName?: string; _categoryId?: number }): Promise<BOCRawOffer> {
    const { data: html } = await this.http.getHTML(raw.url);
    return this.parseDetailPage(html, raw.url, raw._categoryName, raw._categoryId);
  }

  // ── Detail parser ──────────────────────────────────────────────────────────

  private parseDetailPage(
    html: string,
    offerUrl: string,
    categoryName?: string,
    categoryId?: number,
  ): BOCRawOffer {
    const $ = cheerio.load(html);

    const section = $('.white-section').first();
    const title = section.find('.offer-logo-info .offer-logo h2').text().trim() ||
      section.find('h2').first().text().trim() || '';
    const imageUrl = section.find('.offer-logo-info .offer-logo img').attr('src') ?? '';
    const offerValue = section.find('.offer-info .offer-value strong').text().trim();
    const expirationDate = section.find('.offer-info .offer-expire strong').text().trim();

    const description: string[] = [];
    section.find('.offer-txt-info .expand-block p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) description.push(t);
    });

    // Location
    const location = this.parseLocation(description);
    const contactNumbers = this.parseContactNumbers(description);

    const rawAddressText = [location ?? '', ...description].join('\n');
    const addresses = addressEngine.extract(rawAddressText, title);
    const fullAddress = addresses[0] ?? location;

    return {
      url: offerUrl,
      title,
      offerValue,
      expirationDate: expirationDate || undefined,
      imageUrl: imageUrl || undefined,
      fullAddress,
      location: location ?? (addresses[0]?.split(',')[0].trim() ?? null),
      addresses,
      contactNumbers,
      description,
      _categoryName: categoryName,
      _categoryId: categoryId,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private parseLocation(lines: string[]): string | null {
    for (const line of lines) {
      const m = line.match(/(?:Location\s*:\s*)([^-]+?)(?:\s*-\s*Contact|\s*$)/i);
      if (m) return m[1].trim();
      if (/No\s+\d+[A-Z]?,/.test(line) || /Road|Street|Avenue|Lane/i.test(line)) {
        const beforeContact = line.split(/Contact\s*(?:No)?:/i)[0].trim();
        if (beforeContact.length > 5 && beforeContact.length < 200) {
          return beforeContact.replace(/^Location\s*:\s*/i, '').trim();
        }
      }
    }
    return null;
  }

  private parseContactNumbers(lines: string[]): string[] {
    const contacts: string[] = [];
    for (const line of lines) {
      const m = line.match(/Contact\s*(?:No)?:\s*([\d\s/,]+)/i);
      if (m) {
        m[1].split(/[/,]/)
          .map((n) => n.trim().replace(/\s+/g, ' '))
          .filter((n) => /\d{7,}/.test(n))
          .forEach((n) => contacts.push(n));
      }
      const phoneMatches = line.match(/\b\d{3}\s*\d{3}\s*\d{4}\b|\b\d{2}\s*\d{3}\s*\d{4}\b/g);
      if (phoneMatches) {
        phoneMatches.map((p) => p.replace(/\s+/g, ' ').trim()).forEach((p) => {
          if (!contacts.includes(p)) contacts.push(p);
        });
      }
    }
    return [...new Set(contacts)];
  }
}
