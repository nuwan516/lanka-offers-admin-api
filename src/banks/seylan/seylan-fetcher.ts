import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { stripHtml } from '@/parsing/text/html';
import { SeylanListItem, SeylanRawOffer } from './seylan-parser';

const BASE_URL = 'https://www.seylan.lk';

export class SeylanFetcher {
  constructor(private readonly http: HttpClient) {}

  async fetchList(category: BankCategory): Promise<SeylanListItem[]> {
    // Category pages paginate 6 offers per page via ?page=N (observed 2026-07).
    // Follow pages until one adds nothing new.
    const seen = new Set<string>();
    const items: SeylanListItem[] = [];

    for (let page = 1; page <= 40; page++) {
      const pageUrl = page === 1 ? category.url : `${category.url}?page=${page}`;
      const before = items.length;
      this.collectListItems(await this.http.getHTML(pageUrl).then((r) => r.data), seen, items);
      if (items.length === before) break;
    }

    return items;
  }

  private collectListItems(html: string, seen: Set<string>, items: SeylanListItem[]): void {
    const $ = cheerio.load(html);

    // Detail pages live at root-level slugs (seylan.lk/{slug}) — only the
    // card buttons link to them. Anchors containing "/promotions/" are nav,
    // category, and filter links (site redesign observed 2026-07), including
    // a malformed "/https://..." href that 404s if followed.
    $('.new-promotion-btn').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || /\/promotions(\/|\?|$)/.test(href)) return;
      const url = ensureAbsolute(href);
      if (!url.includes('seylan.lk') || seen.has(url)) return;
      seen.add(url);
      const card = $(el).closest('.offer-card, .promotion-card, .item, .col-md-4, .col-md-3, .col-sm-6');
      const title = card.find('h2, h3, h4, .h11, .title').first().text().trim() || $(el).text().trim();
      items.push({
        url,
        title,
        rawHtml: card.length > 0 ? $.html(card) : $.html(el),
      });
    });
  }

  async fetchDetail(item: SeylanListItem): Promise<SeylanRawOffer | null> {
    const { data: html } = await this.http.getHTML(item.url);
    const raw = this.parseDetailPage(html, item);
    return raw;
  }

  private parseDetailPage(html: string, item: SeylanListItem): SeylanRawOffer | null {
    const $ = cheerio.load(html);
    const detailSection = $('.offer-detail').first();
    if (detailSection.length === 0) return null;

    const rightCol = detailSection.find('.col-md-6').last();
    const leftCol = detailSection.find('.col-md-6').first();
    const title = rightCol.find('h2.h11, h1, h2, .title').first().text().trim() || item.title || '';
    if (!title) return null;

    const description = rightCol.find('p.h44, .description, .desc, p').first().text().trim();
    const address = extractLabeledText($, rightCol, /address/i, /Address\s*:?\s*/i);
    const phoneText = extractLabeledText($, rightCol, /tel|phone|contact|hotline/i, /(?:Tel No|Tel|Phone|Contact|Hotline)\s*(?:No)?\s*:?\s*-?\s*/i);
    const validity = extractValidity($, rightCol);
    const terms = extractTerms($, rightCol);
    const imageUrl = leftCol.find('img').first().attr('src') ?? detailSection.find('img').first().attr('src') ?? null;
    const transactionRange = extractTransactionValues(terms.join('\n'));

    return {
      ...item,
      title,
      description: stripHtml(description),
      address,
      phone: parsePhones(phoneText),
      validity,
      imageUrl: imageUrl ? ensureAbsolute(imageUrl) : null,
      terms,
      minTransaction: transactionRange.min,
      maxTransaction: transactionRange.max,
      // Only the offer-detail section — the full page's first 8KB is <head>
      // boilerplate, which is all the LLM validator's truncated evidence
      // window would ever see.
      rawDetailHtml: $.html(detailSection),
    };
  }
}

function ensureAbsolute(url: string): string {
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractLabeledText(
  $: cheerio.Root,
  root: cheerio.Cheerio,
  label: RegExp,
  stripPattern: RegExp,
): string | null {
  let value: string | null = null;
  root.find('div, p, span, li').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!value && label.test(text)) {
      value = text.replace(stripPattern, '').trim();
    }
  });
  return value;
}

function extractValidity($: cheerio.Root, root: cheerio.Cheerio): string {
  let validity = '';
  root.find('p, h4, div, li').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!validity && /valid\s+(?:until|from|till|every|on)|offers?\s+valid|epp\s+valid|discount\s+valid|periods?\s*[:\-–]|validity\s+from|easy\s+payment\s+plans?\s+valid/i.test(text)) {
      validity = text;
    }
  });
  return validity;
}

function extractTerms($: cheerio.Root, root: cheerio.Cheerio): string[] {
  const terms: string[] = [];
  root.find('div.des ul li, .des li, .terms li, ul li').each((_, el) => {
    const term = $(el).text().replace(/\s+/g, ' ').trim();
    if (term && !terms.includes(term)) terms.push(term);
  });
  return terms;
}

function parsePhones(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/(?:\+94|0)?[\d\s/-]{7,}/g) ?? [];
  return [...new Set(matches.map((phone) => phone.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function extractTransactionValues(text: string): { min: number | null; max: number | null } {
  const minMatch = text.match(/Minimum\s+(?:Transaction\s+)?Value\s*[–-]?\s*Rs\.?\s*([\d,]+)/i);
  const maxMatch = text.match(/[Mm]aximum\s*Rs\.?\s*([\d,]+)/i);
  return {
    min: minMatch ? parseInt(minMatch[1].replace(/,/g, ''), 10) : null,
    max: maxMatch ? parseInt(maxMatch[1].replace(/,/g, ''), 10) : null,
  };
}
