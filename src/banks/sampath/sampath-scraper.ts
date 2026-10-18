import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, SAMPATH_CATEGORIES } from '@/config/banks';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { SampathFetcher } from './sampath-fetcher';
import { SampathListItem, SampathDetailPage, parseSampathOffer } from './sampath-parser';

export interface SampathScraperConfig extends ScraperConfig {
  /** Skip fetching HTML detail pages (faster but less data). Default: false. */
  skipDetails?: boolean;
  /** Custom browser client (optional; one will be created if omitted). */
  browser?: BrowserClient;
}

export class SampathScraper extends BaseScraper {
  readonly bankName = 'sampath';
  readonly categories = SAMPATH_CATEGORIES;

  private readonly fetcher: SampathFetcher;
  private readonly browser?: BrowserClient;
  private readonly ownsBrowser: boolean;

  constructor(config: SampathScraperConfig) {
    super(config);
    if (config.browser) {
      this.browser = config.browser;
      this.ownsBrowser = false;
    } else {
      try {
        this.browser = new BrowserClient({
          waitForContentMs: 3000,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          // Only block media and fonts; stylesheets are necessary for Nuxt Webpack chunk loaders
          blockResourceTypes: ['media', 'font'],
        });
        this.ownsBrowser = true;
      } catch {
        this.browser = undefined;
        this.ownsBrowser = false;
      }
    }
    this.fetcher = new SampathFetcher(this.http, this.browser, config.skipDetails ?? false);
  }

  async scrape(): Promise<Offer[]> {
    try {
      return await super.scrape();
    } finally {
      if (this.ownsBrowser && this.browser) {
        await this.browser.close().catch(() => null);
      }
    }
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<SampathListItem[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(
    rawItem: unknown,
  ): Promise<{ item: SampathListItem; detail: SampathDetailPage | null }> {
    const item = rawItem as SampathListItem;
    const detail = await this.fetcher.fetchDetail(item);
    return { item, detail };
  }

  protected buildOffer(raw: unknown): Offer | null {
    const { item, detail } = raw as { item: SampathListItem; detail: SampathDetailPage | null };
    return parseSampathOffer(item, detail);
  }
}
