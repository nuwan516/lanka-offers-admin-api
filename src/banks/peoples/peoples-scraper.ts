import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, PEOPLES_CATEGORIES } from '@/config/banks';
import { PeoplesFetcher } from './peoples-fetcher';
import { parsePeoplesOffer, PeoplesListItem, PeoplesRawOffer } from './peoples-parser';

interface PeoplesScraperConfig extends ScraperConfig {
  skipDetails?: boolean;
}

export class PeoplesScraper extends BaseScraper {
  readonly bankName = 'peoples';
  readonly categories = PEOPLES_CATEGORIES;

  private readonly fetcher: PeoplesFetcher;

  constructor(config: PeoplesScraperConfig) {
    super(config);
    this.fetcher = new PeoplesFetcher(this.http, !config.skipDetails);
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<PeoplesListItem[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<PeoplesRawOffer> {
    return this.fetcher.fetchDetail(rawItem as PeoplesListItem);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parsePeoplesOffer(rawDetail as PeoplesRawOffer);
  }
}
