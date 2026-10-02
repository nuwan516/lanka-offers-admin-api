import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { NSBDetailPage, NSBListItem, NSBRawOffer } from './nsb-parser';

const BASE_URL = 'https://www.nsb.lk';

/**
 * NSB Bank promotions — WordPress site, listing at /category/card-offers/
 * paginated via /category/card-offers/page/N/. Verified live 2026-07-19
 * against the selectors this fetcher uses.
 */
export class NSBFetcher {
  constructor(
    private readonly http: HttpClient,
    private readonly fetchDetails = true,
    private readonly maxPages = 30,
  ) {}

  async fetchList(category: BankCategory): Promise<NSBListItem[]> {
    const items: NSBListItem[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= this.maxPages; page++) {
      const url = page === 1 ? category.url : `${category.url.replace(/\/$/, '')}/page/${page}/`;

      let html: string;
      try {
        ({ data: html } = await this.http.getHTML(url));
      } catch {
        break; // out-of-range pages 404
      }

      const $ = cheerio.load(html);
      const pageItems = this.parseListingPage($);
      if (pageItems.length === 0) break;

      const newItems = pageItems.filter((item) => !item.detailUrl || !seen.has(item.detailUrl));
      if (newItems.length === 0) break; // WP redirects out-of-range pages back to page 1

      for (const item of newItems) {
        if (item.detailUrl) seen.add(item.detailUrl);
        items.push({ ...item, _categoryName: category.name, _categoryId: category.id });
      }
    }

    return items;
  }

  async fetchDetail(item: NSBListItem): Promise<NSBRawOffer> {
    if (!this.fetchDetails || !item.detailUrl) return { listing: item, detail: null };

    try {
      const { data: html } = await this.http.getHTML(item.detailUrl);
      return { listing: item, detail: this.parseDetailPage(html) };
    } catch {
      return { listing: item, detail: null };
    }
  }

  private parseListingPage($: cheerio.Root): NSBListItem[] {
    const items: NSBListItem[] = [];
    $('.media-center-item').each((_, el) => {
      const $item = $(el);
      const title = $item.find('h5.mb-3.mt-0.col-md-12').first().text().trim();
      const excerpt = $item.find('.media-center-content p').first().text().trim();
      const thumbnailUrl = $item.find('.media-center-img img').first().attr('src') ?? null;
      const detailUrl =
        $item.find('.media-center-content a.btn-1').attr('href') ??
        $item.find('a.btn-1').attr('href') ??
        null;

      if (!title && !detailUrl) return;
      items.push({ title, excerpt, thumbnailUrl, detailUrl: detailUrl ? ensureAbsolute(detailUrl) : null });
    });
    return items;
  }

  private parseDetailPage(html: string): NSBDetailPage {
    const $ = cheerio.load(html);
    const item = $('.media-center-item').first();
    const content = item.find('.media-center-content').first();

    const title = item.find('h5.mb-3.mt-0.col-md-12').first().text().trim();

    // At least one live post duplicates its entire description+T&C block
    // twice within the same page DOM (confirmed 2026-08-01) — dedupe by
    // exact text so that doesn't double every paragraph/list item.
    const paragraphs = [...new Set(
      content.find('> p').toArray()
        .map((p) => $(p).clone().find('img').remove().end().text().trim())
        .filter(Boolean),
    )];

    const listItems = [...new Set(
      content.find('li').toArray()
        .map((li) => $(li).text().replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    )];

    const images: string[] = [];
    content.find('img').each((_, img) => {
      const src = $(img).attr('src');
      if (src) images.push(ensureAbsolute(src));
    });

    const fullText = content.text().replace(/\s+/g, ' ').trim();
    // Label varies: "Promo period –", "Offer Period –", "Promo Period:",
    // and the labelled-fields body style's "Duration:" field.
    const periodMatch = [...listItems, ...paragraphs].join(' | ')
      .match(/(?:promo|offer)\s*period[^\-–:]*[-–:]\s*([^|]+)|duration\s*[-–:]\s*([^|]+)/i);

    return {
      title,
      paragraphs,
      listItems,
      images,
      promoPeriod: periodMatch ? (periodMatch[1] ?? periodMatch[2]).trim() : null,
      fullText,
    };
  }
}

function ensureAbsolute(url: string): string {
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}
