/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { HttpClient } from '@/infrastructure/http/http-client';
import { PdfTextExtractor } from '@/infrastructure/pdf/pdf-text-extractor';
import { DFCCDetailPage, DFCCListItem, DFCCRawOffer } from './dfcc-parser';

export class DFCCFetcher {
  private readonly pdfExtractor: PdfTextExtractor | null;
  private readonly http?: HttpClient;

  constructor(
    private readonly browser?: BrowserClient,
    private readonly fetchDetails = true,
    http?: HttpClient,
  ) {
    this.http = http;
    this.pdfExtractor = http ? new PdfTextExtractor(http) : null;
  }

  async fetchList(category: BankCategory): Promise<DFCCListItem[]> {
    let rawItems: DFCCListItem[] = [];

    // 1. Fast HTTP fetch with Cheerio
    if (this.http) {
      try {
        const res = await this.http.getHTML(category.url);
        if (res.data && typeof res.data === 'string' && !res.data.includes('Page Not Found')) {
          rawItems = extractDFCCPromotionsFromHtml(res.data);
        }
      } catch {
        // Fall back to browser if available
      }
    }

    // 2. Fall back to headless browser automation if HTTP returned nothing
    if (rawItems.length === 0 && this.browser) {
      try {
        rawItems = await this.browser.extract<DFCCListItem[]>(
          category.url,
          extractDFCCPromotionsFromListing,
          {
            waitUntil: 'domcontentloaded',
            waitForSelector: 'a.cardd, a[href*="cards-promotions"], .promotion-item, article',
          },
        );
      } catch {
        rawItems = [];
      }
    }

    const seen = new Set<string>();
    const uniqueItems: DFCCListItem[] = [];
    for (const item of rawItems) {
      const key = `${item.detailUrl || ''}|${item.cardType}|${item.offerText}`.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniqueItems.push({
        ...item,
        _categoryName: category.name,
        _categoryId: category.id,
        _sourceUrl: category.url,
      });
    }

    return uniqueItems;
  }

  // CONFIRMED LIVE 2026-08-01: every "Read More" detailUrl 200s at the raw
  // HTTP level but client-side-routes to "Page Not Found (404)" — the
  // Next.js routing table doesn't recognize any of these slugs. There is no
  // working detail page architecture on this site; the listing card
  // (offerText + cardOfferValid + discount badge) is the only real data
  // source. This used to still navigate to the dead page on every offer — a
  // full page load that always resolved to nothing, which is why Dining (41
  // cards) could time out at 60s on a cold run. Disabled via this flag
  // rather than deleted, in case DFCC ever fixes their routing.
  private readonly detailPagesAreLive = false;

  async fetchDetail(item: DFCCListItem): Promise<DFCCRawOffer> {
    if (!this.fetchDetails || !item.detailUrl || !this.detailPagesAreLive) {
      return { listing: item, detail: null };
    }

    if (!this.browser) {
      return { listing: item, detail: null };
    }

    try {
      let detail = await this.browser.extract<DFCCDetailPage>(
        item.detailUrl,
        extractDFCCPromotionDetail,
        {
          waitUntil: 'domcontentloaded',
          waitForSelector: '.pageMainBlock-main-title-1, .pageMainBlock-description, body',
        },
      );

      if (detail.termsAndConditionsPdfUrl && this.pdfExtractor && PdfTextExtractor.isAvailable()) {
        const pdf = await this.pdfExtractor.extract(detail.termsAndConditionsPdfUrl);
        if (pdf.extracted && pdf.text) {
          detail = { ...detail, rawText: [detail.rawText, pdf.text].filter(Boolean).join('\n\n') };
        }
      }

      return { listing: item, detail };
    } catch {
      return { listing: item, detail: null };
    }
  }
}

export function extractDFCCPromotionsFromHtml(html: string): DFCCListItem[] {
  const $ = cheerio.load(html);
  const items: DFCCListItem[] = [];

  $('a[href*="/cards/cards-promotions/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.endsWith('credit-card-offers') || href.endsWith('today-promotions') || href.endsWith('cards-promotions')) return;

    const cardContainer = $(el).closest('.cardd, [class*="card"], div.bIRM').parent();
    const offerText = cardContainer.find('.cardOfferText, .card-title, h4, h5, p')
      .filter((_, p) => $(p).text().length > 15)
      .first()
      .text().trim().replace(/\s+/g, ' ');

    const validityText = cardContainer.find('.cardOfferValid, [class*="valid" i]').text().trim().replace(/\s+/g, ' ');
    const discountBadge = cardContainer.find('.Offerpercentage, .discount-badgee, [class*="discount-badge" i]').text().trim().replace(/\s+/g, ' ');

    let img = '';
    let alt = '';
    cardContainer.find('img').each((_, im) => {
      const src = $(im).attr('src') || '';
      const a = $(im).attr('alt') || '';
      if (!src.endsWith('.svg') && !src.includes('arrow') && !a.toLowerCase().includes('relivenet')) {
        img = src;
        alt = a;
      }
    });

    const fullDetailUrl = href.startsWith('http') ? href : `https://www.dfcc.lk${href}`;

    if (offerText || href) {
      items.push({
        cardType: cardContainer.find('.tag, .card-tags p, [class*="tag"], .badge').text().trim(),
        offerText,
        validityText,
        discountBadge,
        imageUrl: img.startsWith('http') ? img : img ? `https://www.dfcc.lk${img}` : '',
        imageAlt: alt,
        detailUrl: fullDetailUrl,
      });
    }
  });

  return items;
}

function extractDFCCPromotionsFromListing(): DFCCListItem[] {
  const doc = (globalThis as any).document;

  let cards = Array.from(doc.querySelectorAll('a.cardd')) as any[];
  if (cards.length === 0) cards = Array.from(doc.querySelectorAll('a[href*="cards-promotions"]')) as any[];
  if (cards.length === 0) cards = Array.from(doc.querySelectorAll('.promotion-item')) as any[];
  if (cards.length === 0) {
    cards = Array.from(doc.querySelectorAll('article, [class*="card"][class*="offer"], [class*="promo"]')) as any[];
  }

  return cards.map((card) => {
    const link = card.tagName === 'A' ? card : card.querySelector('a[href*="cards-promotions"], a[href*="promotion"], a');
    const detailUrl = link?.getAttribute('href') || '';
    const imgElements = Array.from(card.querySelectorAll('img')) as any[];
    const validImg = imgElements.find((im) => !im.src.endsWith('.svg') && !im.src.includes('arrow') && !im.alt?.toLowerCase().includes('relivenet'));

    return {
      cardType: card.querySelector('.tag, .card-tags p, [class*="tag"], .badge')?.textContent?.trim() ?? '',
      offerText: card.querySelector('.cardOfferText, .card-title, h4, h5')?.textContent?.trim() ?? '',
      validityText: card.querySelector('.cardOfferValid, [class*="valid" i]')?.textContent?.trim() ?? '',
      discountBadge: card.querySelector('.Offerpercentage, .discount-badgee, [class*="discount-badge" i]')?.textContent?.trim() ?? '',
      imageUrl: validImg?.src ?? '',
      imageAlt: validImg?.alt ?? '',
      detailUrl: detailUrl.startsWith('http') ? detailUrl : `https://www.dfcc.lk${detailUrl}`,
    };
  }).filter((item) => item.offerText || item.detailUrl);
}

function extractDFCCPromotionDetail(): DFCCDetailPage {
  const doc = (globalThis as any).document;
  const terms = Array.from(doc.querySelectorAll([
    '.pageMainBlock-description p',
    '.pageMainBlock-description li',
    'main p',
    'main li',
    '.entry-content p',
    '.entry-content li',
    '[class*="terms"] p',
    '[class*="terms"] li',
  ].join(',')))
    .map((block: any) => block.textContent?.trim())
    .filter((text: string) => text && text.length > 10 && text.length < 500)
    .filter((text: string) => !/About Us|Investor|Media Center|DFCC Bank|Contact Us|Corporate Information/i.test(text));

  const pdfLink = doc.querySelector('a[href$=".pdf"], a[href*=".pdf"]') as any;

  return {
    title: doc.querySelector('.pageMainBlock-main-title-1')?.textContent?.trim() ?? '',
    description: doc.querySelector('.pageMainBlock-description p')?.textContent?.trim() ?? '',
    image: doc.querySelector('.pageMainBlock-image-block img')?.src ?? '',
    termsAndConditions: Array.from(new Set(terms)).slice(0, 30) as string[],
    rawText: doc.querySelector('main')?.textContent?.trim() ?? doc.body?.innerText ?? '',
    termsAndConditionsPdfUrl: pdfLink?.href ?? null,
  };
}
