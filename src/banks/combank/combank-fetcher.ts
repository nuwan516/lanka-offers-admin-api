import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { ComBankDetailPage, ComBankDetailSectionEntry, ComBankListItem, ComBankRawOffer } from './combank-parser';

const BASE_URL = 'https://www.combank.lk';

/**
 * ComBank Rewards & Promotions — every category lives on a single listing
 * page (unlike DFCC/NDB/People's), grouped into `.offers-row` blocks each
 * carrying its own display name. Verified live 2026-08-01 against the
 * selectors this fetcher uses: 18 offers-rows, 47 a.reward cards.
 */
export class ComBankFetcher {
  constructor(
    private readonly http: HttpClient,
    private readonly fetchDetails = true,
  ) {}

  async fetchList(category: BankCategory): Promise<ComBankListItem[]> {
    const { data: html } = await this.http.getHTML(category.url);
    const $ = cheerio.load(html);
    const items: ComBankListItem[] = [];

    $('.offers-row').each((_, row) => {
      const $row = $(row);
      const displayName = $row.find('.title-row .sub-title').first().text().trim() || slugToTitle($row.attr('id') ?? '');

      $row.find('a.reward').each((__, el) => {
        const $reward = $(el);
        const title = $reward.find('.reward-content h3').first().text().trim();
        const detailHref = $reward.attr('href') ?? null;
        if (!title && !detailHref) return;

        const categoryLabel = $reward.find('.reward-content .category').first().text().trim() || displayName;
        const discount = extractDiscount($, $reward.find('.offer-tag').first());

        items.push({
          title,
          categoryLabel,
          discountText: discount.text,
          discountPercentage: discount.percentage,
          isUpTo: discount.isUpTo,
          validityRaw: $reward.find('.reward-content .valid-date').first().text().replace(/\s+/g, ' ').trim(),
          imageUrl: extractImageUrl($reward.find('.reward-image').attr('style')),
          detailUrl: detailHref ? ensureAbsolute(detailHref) : null,
        });
      });
    });

    return items.map((item) => ({ ...item, _categoryId: category.id }));
  }

  async fetchDetail(item: ComBankListItem): Promise<ComBankRawOffer> {
    if (!this.fetchDetails || !item.detailUrl) return { listing: item, detail: null };

    try {
      const { data: html } = await this.http.getHTML(item.detailUrl);
      return { listing: item, detail: this.parseDetailPage(html) };
    } catch {
      return { listing: item, detail: null };
    }
  }

  private parseDetailPage(html: string): ComBankDetailPage {
    const $ = cheerio.load(html);
    const wrapper = $('.news-content-container').first();
    const mainImageUrl = wrapper.find('.reward-image img').first().attr('src') ?? null;
    const content = wrapper.find('.editor-content').first();

    return { mainImageUrl, sections: parseEditorContent($, content) };
  }
}

/** .offer-tag wraps each fragment ("Up to" / "20%" / "Off") in its own <p>
 *  with no whitespace between them in the source — .text() alone collapses
 *  to "Up to20%Off", so each child <p> is joined with a space instead. */
function extractDiscount($: cheerio.Root, $tag: cheerio.Cheerio): { text: string; percentage: number | null; isUpTo: boolean } {
  const parts: string[] = [];
  $tag.find('p').each((_, p) => {
    const t = $(p).text().trim();
    if (t) parts.push(t);
  });
  const rawText = (parts.length ? parts.join(' ') : $tag.text()).replace(/\s+/g, ' ').trim();
  const percentMatch = rawText.match(/(\d+(?:\.\d+)?)\s*%/);
  return { text: rawText, percentage: percentMatch ? parseFloat(percentMatch[1]) : null, isUpTo: /up to/i.test(rawText) };
}

function extractImageUrl(styleAttr: string | undefined): string | null {
  if (!styleAttr) return null;
  const match = styleAttr.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
  return match ? match[1] : null;
}

/**
 * Walk editor-content's direct children in order, tracking the "current
 * section" as bold-underlined header paragraphs are encountered
 * (<p><b><u>Section Title</u></b></p>), attaching following <ol>/<ul> items
 * to that section. Multi-line list items (<br>-separated, e.g. a "Visit –"
 * bullet listing several venues) keep a `lines` array alongside flat `text`.
 */
function parseEditorContent($: cheerio.Root, $container: cheerio.Cheerio): Record<string, ComBankDetailSectionEntry[]> {
  const sections: Record<string, ComBankDetailSectionEntry[]> = {};
  let currentSection = 'General';

  $container.children().each((_, el) => {
    const tag = 'tagName' in el ? ((el as { tagName?: string }).tagName?.toLowerCase() ?? '') : '';
    const $el = $(el);

    if (tag === 'p') {
      const $u = $el.find('u').first();
      const text = $el.text().trim();

      if ($u.length > 0 && $u.text().trim() === text && text.length > 0) {
        currentSection = text;
        sections[currentSection] ??= [];
      } else if (text) {
        (sections[currentSection] ??= []).push({ type: 'note', text });
      }
    } else if (tag === 'ol' || tag === 'ul') {
      sections[currentSection] ??= [];
      $el.find('> li').each((__, li) => {
        const $li = $(li);
        const liHtml = $li.html() ?? '';
        const lineParts = liHtml
          .split(/<br\s*\/?>/i)
          .map((part) => cheerio.load(`<div>${part}</div>`)('div').text().trim())
          .filter(Boolean);

        const text = $li.text().replace(/\s+/g, ' ').trim();
        const entry: ComBankDetailSectionEntry = { type: 'item', text };
        if (lineParts.length > 1) entry.lines = lineParts;
        sections[currentSection].push(entry);
      });
    } else if (tag === 'table') {
      // A handful of offers (NCG Express route table, DHL's 19-branch
      // Location/Contact/Address table) embed real data as a table instead
      // of/alongside prose. Not parsed into structured columns — that's a
      // separate project — but captured as one row-per-line entry so the
      // data survives into rawHtml/generalTerms instead of being silently
      // dropped by the p/ol/ul-only switch above.
      sections[currentSection] ??= [];
      $el.find('tr').each((__, tr) => {
        const cells = $(tr).find('td, th').map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
        const text = cells.filter(Boolean).join(' | ');
        if (text) sections[currentSection].push({ type: 'item', text });
      });
    }
  });

  return sections;
}

function slugToTitle(slug: string): string {
  return slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function ensureAbsolute(url: string): string {
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}
