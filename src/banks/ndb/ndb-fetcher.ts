/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cheerio from 'cheerio';
import { BankCategory } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { HttpClient } from '@/infrastructure/http/http-client';
import { PdfTextExtractor } from '@/infrastructure/pdf/pdf-text-extractor';
import { NDBRawOffer } from './ndb-parser';

export class NDBFetcher {
  constructor(
    private readonly browser: BrowserClient,
    private readonly pdfExtractor?: PdfTextExtractor,
    private readonly http?: HttpClient,
  ) {}

  async fetchList(category: BankCategory): Promise<NDBRawOffer[]> {
    const offers = await this.browser.extract<NDBRawOffer[]>(
      category.url,
      extractNDBOffersFromPage,
      { waitForSelector: '.ant-card, .offer-card, .col-12.col-md-6.col-lg-4' },
    );

    return offers.map((offer) => ({
      ...offer,
      _categoryName: category.name,
      _categoryId: category.id,
      _sourceUrl: category.url,
      rawText: JSON.stringify(offer),
    }));
  }

  async fetchDetail(raw: NDBRawOffer): Promise<NDBRawOffer> {
    let enriched = raw;

    // Detail pages (/cards/card-offers/offer-details/{id}) are fully
    // server-rendered — Address/Hotline/Website live only there, so a plain
    // HTTP fetch (cacheable) is enough; no browser needed.
    if (raw.detailUrl && this.http) {
      try {
        const { data: html } = await this.http.getHTML(raw.detailUrl);
        enriched = { ...raw, ...parseNDBDetailHtml(html, raw) };
      } catch {
        // keep listing-card data
      }
    }

    if (!enriched.termsAndConditionsPdfUrl || !this.pdfExtractor || !PdfTextExtractor.isAvailable()) {
      return enriched;
    }

    const pdf = await this.pdfExtractor.extract(enriched.termsAndConditionsPdfUrl);
    return {
      ...enriched,
      pdfText: pdf.text,
      rawText: [enriched.rawText, pdf.text].filter(Boolean).join('\n\n'),
    };
  }
}

/** Parse the server-rendered detail page's merchant-info block and period line. */
export function parseNDBDetailHtml(html: string, raw: NDBRawOffer): Partial<NDBRawOffer> {
  const $ = cheerio.load(html);
  const infoCard = $('.card.bg-light-subtle').first();

  const fieldAfterH5 = (label: string) =>
    infoCard
      .find('h5')
      .filter((_, el) => $(el).text().trim().toLowerCase() === label)
      .first()
      .next('p');

  const address = fieldAfterH5('address').text().trim();
  const hotline = fieldAfterH5('hotline').text().trim();
  const websiteEl = fieldAfterH5('website');
  const website = websiteEl.find('a').attr('href')?.trim() || websiteEl.text().trim();

  // Read the period from the element that IS the period line — bounding a
  // regex over the whole page text is fragile against layout reordering.
  let periodText = '';
  $('main p, main li, main h4, main h5').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!periodText && /^Offer\s+valid\s+period\s*:/i.test(t) && t.length < 200) {
      periodText = t.replace(/^Offer\s+valid\s+period\s*:\s*/i, '');
    }
  });

  const mainText = $('main').text().replace(/\s+/g, ' ');
  const typeMatch = mainText.match(/\bType\s*:\s*(.*?)(?=\s*(?:Special\s+Conditions|Address\b|Offer\s+valid|$))/i);

  const phones = hotline
    ? hotline.split(/[/,]/).map((p) => p.trim()).filter((p) => p.replace(/\D/g, '').length >= 7)
    : [];

  return {
    location: address && !/^[.\-]+$/.test(address) ? address : raw.location,
    phoneNumbers: phones.length > 0 ? phones : raw.phoneNumbers,
    website: website || raw.website,
    cardType: typeMatch?.[1]?.trim() || raw.cardType,
    validity: periodText || raw.validity,
    rawText: [raw.rawText, infoCard.text().replace(/\s+/g, ' ').trim()].filter(Boolean).join('\n\n'),
  };
}

function extractNDBOffersFromPage(): NDBRawOffer[] {
  const doc = (globalThis as any).document;
  const results: NDBRawOffer[] = [];
  const antCards = Array.from(doc.querySelectorAll('.ant-col.DesktopBlock_col__2q7cK')) as any[];

  for (const container of antCards) {
    const card = container.querySelector('.ant-card');
    if (!card) continue;
    const phones = Array.from(card.querySelectorAll('.PromotionMobile_phone__3t2ws li'))
      .map((li: any) => li.textContent?.trim())
      .filter(Boolean);
    results.push({
      merchantName: card.querySelector('.ant-card-meta-title')?.textContent?.trim() ?? '',
      website: card.querySelector('.PromotionMobile_website__5kRF6')?.href ?? '',
      location: card.querySelector('.PromotionMobile_merchantDescription__1BkVS > span.ant-typography')?.textContent?.trim() ?? '',
      phoneNumbers: phones,
      offerDetails: card.querySelector('.PromotionMobile_details__z7myj h5.ant-typography')?.textContent?.trim() ?? '',
      validity: card.querySelector('.PromotionMobile_validity__39zdc span.ant-typography')?.textContent?.trim() ?? '',
      coverImage: card.querySelector('.ant-card-cover img.PromotionMobile_cover__2YUwz')?.src ?? '',
      merchantLogo: card.querySelector('.PromotionMobile_avatar__11ePi img')?.src ?? '',
      termsAndConditionsPdfUrl: card.querySelector('.PromotionMobile_terms__3OCeo a[href*=".pdf"]')?.href ?? null,
    });
  }

  const bootstrapCards = Array.from(doc.querySelectorAll('.col-12.col-md-6.col-lg-4')) as any[];
  for (const container of bootstrapCards) {
    const card = container.querySelector('.offer-card') || container.querySelector('.ant-card');
    if (!card) continue;
    const text = card.textContent ?? '';
    const phoneMatch = text.match(/(\d{3}\s?\d{7})/);
    results.push({
      merchantName: card.querySelector('.card-body p.card-title:not(.text-muted)')?.textContent?.trim() ?? '',
      offerDetails: card.querySelector('.card-title.ndbcolor')?.textContent?.trim() ?? '',
      cardType: card.querySelector('.text-muted')?.textContent?.trim() ?? '',
      validity: card.querySelector('.offer-date')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      coverImage: card.querySelector('.card-img-top:not(.offercompanylogo)')?.src ?? '',
      merchantLogo: card.querySelector('.offercompanylogo')?.src ?? '',
      phone: phoneMatch ? phoneMatch[1].trim() : '',
      detailUrl: container.querySelector('a[href*="/offer-details/"]')?.href ?? '',
      termsAndConditionsPdfUrl: card.querySelector('a[href*=".pdf"]')?.href ?? null,
    });
  }

  return results.filter((offer) => offer.merchantName || offer.offerDetails);
}
