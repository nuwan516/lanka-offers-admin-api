import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, SAMPATH_CATEGORIES } from '@/config/banks';
import { SampathFetcher } from './sampath-fetcher';
import { SampathListItem, SampathDetailPage, parseSampathOffer } from './sampath-parser';

export interface SampathScraperConfig extends ScraperConfig {
  /** Skip fetching HTML detail pages (faster but less data). Default: false. */
  skipDetails?: boolean;
}

export class SampathScraper extends BaseScraper {
  readonly bankName = 'sampath';
  readonly categories = SAMPATH_CATEGORIES;

  private readonly fetcher: SampathFetcher;

  constructor(config: SampathScraperConfig) {
    super(config);
    this.fetcher = new SampathFetcher(this.http, config.skipDetails ?? false);
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
