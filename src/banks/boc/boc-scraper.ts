import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, BOC_CATEGORIES } from '@/config/banks';
import { BOCFetcher } from './boc-fetcher';
import { BOCRawOffer, parseBOCOffer } from './boc-parser';

export class BOCScraper extends BaseScraper {
  readonly bankName = 'boc';
  readonly categories = BOC_CATEGORIES;

  private readonly fetcher: BOCFetcher;

  constructor(config: ScraperConfig) {
    super(config);
    this.fetcher = new BOCFetcher(this.http);
  }

  protected async fetchCategoryRawData(
    category: BankCategory,
  ): Promise<Array<{ url: string; title: string; _categoryName: string; _categoryId: number }>> {
    const items = await this.fetcher.fetchList(category);
    return items.map((item) => ({
      ...item,
      _categoryName: category.name,
      _categoryId: category.id,
    }));
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<BOCRawOffer> {
    const item = rawItem as { url: string; title: string; _categoryName: string; _categoryId: number };
    return this.fetcher.fetchDetail(item);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parseBOCOffer(rawDetail as BOCRawOffer);
  }
}
