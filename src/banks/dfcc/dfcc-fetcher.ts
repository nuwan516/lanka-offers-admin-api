/* eslint-disable @typescript-eslint/no-explicit-any */
import { BankCategory } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { HttpClient } from '@/infrastructure/http/http-client';
import { PdfTextExtractor } from '@/infrastructure/pdf/pdf-text-extractor';
import { DFCCDetailPage, DFCCListItem, DFCCRawOffer } from './dfcc-parser';

export class DFCCFetcher {
  private readonly pdfExtractor: PdfTextExtractor | null;

  constructor(
    private readonly browser: BrowserClient,
    private readonly fetchDetails = true,
    http?: HttpClient,
  ) {
    this.pdfExtractor = http ? new PdfTextExtractor(http) : null;
  }

  async fetchList(category: BankCategory): Promise<DFCCListItem[]> {
    const items = await this.browser.extract<DFCCListItem[]>(
      category.url,
      extractDFCCPromotionsFromListing,
      // a.cardd is DFCC's current card markup; the other selectors are a
      // fallback chain for categories mid-migration to a different template
      // (observed: some category pages still 200 but never render a.cardd).
      { waitForSelector: 'a.cardd, a[href*="cards-promotions"], .promotion-item, article' },
    );

    return items.map((item) => ({
      ...item,
      _categoryName: category.name,
      _categoryId: category.id,
      _sourceUrl: category.url,
    }));
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

    try {
      let detail = await this.browser.extract<DFCCDetailPage>(
        item.detailUrl,
        extractDFCCPromotionDetail,
        { waitForSelector: '.pageMainBlock-main-title-1, .pageMainBlock-description, body' },
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

function extractDFCCPromotionsFromListing(): DFCCListItem[] {
  const doc = (globalThis as any).document;

  // Fallback chain mirrors the tested legacy scraper: prefer the current
  // a.cardd markup, but degrade gracefully if a category page is still on
  // an older/different template.
  let cards = Array.from(doc.querySelectorAll('a.cardd')) as any[];
  if (cards.length === 0) cards = Array.from(doc.querySelectorAll('a[href*="cards-promotions"]')) as any[];
  if (cards.length === 0) cards = Array.from(doc.querySelectorAll('.promotion-item')) as any[];
  if (cards.length === 0) {
    cards = Array.from(doc.querySelectorAll('article, [class*="card"][class*="offer"], [class*="promo"]')) as any[];
  }

  return cards.map((card) => {
    const link = card.tagName === 'A' ? card : card.querySelector('a[href*="cards-promotions"], a[href*="promotion"], a');
    const detailUrl = link?.getAttribute('href') || '';
    const img = card.querySelector('.offerMainImage, img, figure img');
    return {
      cardType: card.querySelector('.tag, .card-tags p, [class*="tag"], .badge')?.textContent?.trim() ?? '',
      offerText: card.querySelector('.cardOfferText, .card-title, h4, h5')?.textContent?.trim() ?? '',
      // .cardOfferValid: a date-validity line SEPARATE from the offer
      // sentence — since detail pages are dead, this is the only source of
      // the real validity date and was previously never captured at all.
      validityText: card.querySelector('.cardOfferValid, [class*="valid" i]')?.textContent?.trim() ?? '',
      // .discount-badgee (sic — typo in DFCC's own CSS class name): the
      // structured percentage badge, distinct from the card-type tag.
      discountBadge: card.querySelector('.discount-badgee, [class*="discount-badge" i]')?.textContent?.trim() ?? '',
      imageUrl: img?.src ?? '',
      imageAlt: img?.alt ?? '',
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
