import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, NDB_CATEGORIES } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { PdfTextExtractor } from '@/infrastructure/pdf/pdf-text-extractor';
import { NDBFetcher } from './ndb-fetcher';
import { NDBRawOffer, parseNDBOffer } from './ndb-parser';

export class NDBScraper extends BaseScraper {
  readonly bankName = 'ndb';
  readonly categories = NDB_CATEGORIES;

  private readonly fetcher: NDBFetcher;
  private readonly browser: BrowserClient;

  constructor(config: ScraperConfig) {
    super(config);
    this.browser = new BrowserClient({ waitForContentMs: 5_000, blockResourceTypes: ['image', 'stylesheet', 'font', 'media'] });
    this.fetcher = new NDBFetcher(
      this.browser,
      new PdfTextExtractor(this.http),
      this.http,
    );
  }

  async scrape(): Promise<Offer[]> {
    try {
      return await super.scrape();
    } finally {
      await this.browser.close();
    }
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<NDBRawOffer[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<NDBRawOffer> {
    return this.fetcher.fetchDetail(rawItem as NDBRawOffer);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parseNDBOffer(rawDetail as NDBRawOffer);
  }
}
