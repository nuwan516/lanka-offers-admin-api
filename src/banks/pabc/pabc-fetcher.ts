/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { PABCRawOffer } from './pabc-parser';

export const PABC_CARD_OFFERS_URL = 'https://www.pabcbank.com/card-offers/';

export class PABCFetcher {
  constructor(private readonly browser: BrowserClient) {}

  async fetchOffers(): Promise<PABCRawOffer[]> {
    const offers = await this.browser.extract<PABCRawOffer[]>(
      PABC_CARD_OFFERS_URL,
      extractPABCOffersFromPage,
      {
        waitUntil: 'domcontentloaded',
        waitForSelector: '.flip-card, .flip-card-inner',
        evaluateOnNewDocument: () => {
          Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
        },
      },
    );

    return offers.map((offer) => ({
      ...offer,
      _categoryName: 'Card Offers',
      _categoryId: 1,
      _sourceUrl: PABC_CARD_OFFERS_URL,
    }));
  }
}

function extractPABCOffersFromPage(): PABCRawOffer[] {
  const doc = (globalThis as any).document;
  const cards = Array.from(doc.querySelectorAll('.flip-card')) as any[];
  return cards.map((card) => {
    const front = card.querySelector('.flip-card-front');
    const back = card.querySelector('.flip-card-back');
    if (!front || !back) return null;
    const img = front.querySelector('img');
    return {
      imageUrl: img?.src ?? '',
      imageAlt: img?.alt ?? '',
      discount: front.querySelector('h2')?.textContent?.trim() ?? '',
      validityDate: front.querySelector('p')?.textContent?.trim() ?? '',
      description: back.querySelector('p')?.textContent?.trim() ?? '',
    };
  }).filter(Boolean) as PABCRawOffer[];
}
