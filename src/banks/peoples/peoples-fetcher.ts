import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { PeoplesDetailPage, PeoplesListItem, PeoplesRawOffer } from './peoples-parser';

const BASE_URL = 'https://www.peoplesbank.lk';

export class PeoplesFetcher {
  constructor(
    private readonly http: HttpClient,
    private readonly fetchDetails = true,
  ) {}

  async fetchList(category: BankCategory): Promise<PeoplesListItem[]> {
    const urls = category.urls && category.urls.length > 0 ? category.urls : [category.url];
    const allItems: PeoplesListItem[] = [];

    for (const url of urls) {
      const { data: html } = await this.http.getHTML(url);
      const cardType = inferCardType(url, category.cardType);
      allItems.push(...this.parseListingPage(html, category, cardType));
    }

    return allItems;
  }

  async fetchDetail(item: PeoplesListItem): Promise<PeoplesRawOffer> {
    if (!this.fetchDetails || !item.detailPageUrl) {
      return { listing: item, detail: null };
    }

    try {
      const { data: html } = await this.http.getHTML(item.detailPageUrl);
      return {
        listing: item,
        detail: this.parseDetailPage(html, item.detailPageUrl),
      };
    } catch {
      return { listing: item, detail: null };
    }
  }

  private parseListingPage(html: string, category: BankCategory, cardType: string): PeoplesListItem[] {
    const $ = cheerio.load(html);
    const cards: PeoplesListItem[] = [];

    $('.offer-card').each((_, card) => {
      const $card = $(card);
      const merchantName = $card.find('.promo-short').text().trim() ||
        $card.find('.title, h2, h3').first().text().trim();
      const detailHref = $card.find('.offer-image a').attr('href') ||
        $card.find('.promo-short a').attr('href') ||
        $card.find('a').first().attr('href') ||
        null;

      if (!merchantName && !detailHref) return;

      const shortDescription = $card.find('.merchant-name').clone().children().remove().end().text().trim() ||
        $card.find('.desc, .description').first().text().trim();
      cards.push({
        merchantName,
        discount: $card.find('.discount-badge').text().trim(),
        shortDescription,
        validityRaw: $card.find('.valid-date, .validity').text().replace(/Validity\s*:/i, '').trim(),
        imageUrl: absolutize($card.find('.offer-image img, img').first().attr('src') ?? null),
        detailPageUrl: absolutize(detailHref),
        rawListHtml: $.html($card),
        _categoryName: category.name,
        _categoryId: category.id,
        _cardType: cardType,
      });
    });

    return cards;
  }

  private parseDetailPage(html: string, sourceUrl: string): PeoplesDetailPage {
    const $ = cheerio.load(html);
    const card = $('.single-card').first();
    const root = card.length > 0 ? card : $('body');
    const descHtml = root.find('.desc').html() || '';
    const terms = extractTerms(descHtml);
    const textTerms = terms.join('\n');

    return {
      sourceUrl,
      imageUrl: absolutize(root.find('.hero-left img, img').first().attr('src') ?? null),
      title: root.find('.title, h1, h2').first().text().trim() || null,
      location: root.find('.meta-row div').filter((_, el) => $(el).text().includes('Location:')).text().replace(/Location\s*:/i, '').trim() || null,
      validityText: root.find('.validity').text().replace(/Validity\s*:/i, '').trim() || null,
      terms,
      termsUrl: absolutize(root.find('a.terms-link, a[href$=".pdf"], a[href*=".pdf"]').first().attr('href') ?? null),
      structuredTerms: {
        minimumSpend: parseAmount(textTerms, /Minimum\s+Spend[:\s-]*Rs\.?\s*([\d,]+)/i),
        maximumBill: parseAmount(textTerms, /Maximum\s+Bill\s+Value[:\s-]*Rs\.?\s*([\d,]+)/i),
        minimumPax: parseAmount(textTerms, /Minimum\s+(\d+)\s+Pax/i),
        maximumPax: parseAmount(textTerms, /Maximum\s+(\d+)\s+Pax/i),
      },
      pdfTerms: null,
      rawDetailHtml: html,
    };
  }
}

function absolutize(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function inferCardType(url: string, fallback: BankCategory['cardType']): string {
  if (/debit/i.test(url)) return 'Debit Card';
  if (/credit/i.test(url)) return 'Credit Card';
  if (fallback === 'credit') return 'Credit Card';
  if (fallback === 'debit') return 'Debit Card';
  return '';
}

function extractTerms(descHtml: string): string[] {
  if (!descHtml) return [];
  const $ = cheerio.load(descHtml);
  const terms: string[] = [];
  $('p, li').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text) terms.push(text);
  });
  return terms;
}

function parseAmount(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : null;
}
