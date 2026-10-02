import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { PABC_CARD_OFFERS_URL, PABCFetcher } from './pabc-fetcher';
import { PABCRawOffer, parsePABCOffer } from './pabc-parser';

const PABC_RUNTIME_CATEGORY: BankCategory = {
  id: 1,
  name: 'Card Offers',
  slug: 'card-offers',
  url: PABC_CARD_OFFERS_URL,
  sourceType: 'headless-browser',
  browserRequired: true,
};

export class PABCScraper extends BaseScraper {
  readonly bankName = 'pabc';
  readonly categories = [PABC_RUNTIME_CATEGORY];

  private readonly fetcher: PABCFetcher;
  private readonly browser: BrowserClient;

  constructor(config: ScraperConfig) {
    super(config);
    this.browser = new BrowserClient({
      waitForContentMs: 5_000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      blockResourceTypes: ['stylesheet', 'font', 'media'],
      launchArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    this.fetcher = new PABCFetcher(
      this.browser,
    );
  }

  async scrape(): Promise<Offer[]> {
    try {
      return await super.scrape();
    } finally {
      await this.browser.close();
    }
  }

  protected async fetchCategoryRawData(_category: BankCategory): Promise<PABCRawOffer[]> {
    return this.fetcher.fetchOffers();
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parsePABCOffer(rawDetail as PABCRawOffer);
  }
}
