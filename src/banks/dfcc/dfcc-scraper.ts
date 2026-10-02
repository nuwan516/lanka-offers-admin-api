import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, DFCC_CATEGORIES } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { DFCCFetcher } from './dfcc-fetcher';
import { DFCCListItem, DFCCRawOffer, parseDFCCOffer } from './dfcc-parser';

interface DFCCScraperConfig extends ScraperConfig {
  skipDetails?: boolean;
}

export class DFCCScraper extends BaseScraper {
  readonly bankName = 'dfcc';
  readonly categories = DFCC_CATEGORIES;

  private readonly fetcher: DFCCFetcher;
  private readonly browser: BrowserClient;

  constructor(config: DFCCScraperConfig) {
    super(config);
    this.browser = new BrowserClient({ waitForContentMs: 3_000 });
    this.fetcher = new DFCCFetcher(
      this.browser,
      !config.skipDetails,
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

  protected async fetchCategoryRawData(category: BankCategory): Promise<DFCCListItem[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<DFCCRawOffer> {
    return this.fetcher.fetchDetail(rawItem as DFCCListItem);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parseDFCCOffer(rawDetail as DFCCRawOffer);
  }
}
