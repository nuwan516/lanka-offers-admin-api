import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, NSB_CATEGORIES } from '@/config/banks';
import { NSBFetcher } from './nsb-fetcher';
import { NSBListItem, NSBRawOffer, parseNSBOffer } from './nsb-parser';

export class NSBScraper extends BaseScraper {
  readonly bankName = 'nsb';
  readonly categories = NSB_CATEGORIES;

  private readonly fetcher: NSBFetcher;

  constructor(config: ScraperConfig & { skipDetails?: boolean }) {
    super(config);
    this.fetcher = new NSBFetcher(this.http, !config.skipDetails);
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<NSBListItem[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<NSBRawOffer> {
    return this.fetcher.fetchDetail(rawItem as NSBListItem);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parseNSBOffer(rawDetail as NSBRawOffer);
  }
}
