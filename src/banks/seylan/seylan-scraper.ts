import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, SEYLAN_CATEGORIES } from '@/config/banks';
import { SeylanFetcher } from './seylan-fetcher';
import { parseSeylanOffer, SeylanListItem, SeylanRawOffer } from './seylan-parser';

export class SeylanScraper extends BaseScraper {
  readonly bankName = 'seylan';
  readonly categories = SEYLAN_CATEGORIES;

  private readonly fetcher: SeylanFetcher;

  constructor(config: ScraperConfig) {
    super(config);
    this.fetcher = new SeylanFetcher(this.http);
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<SeylanListItem[]> {
    const items = await this.fetcher.fetchList(category);
    return items.map((item) => ({
      ...item,
      _categoryName: category.name,
      _categoryId: category.id,
    }));
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<SeylanRawOffer | null> {
    return this.fetcher.fetchDetail(rawItem as SeylanListItem);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return rawDetail ? parseSeylanOffer(rawDetail as SeylanRawOffer) : null;
  }
}
