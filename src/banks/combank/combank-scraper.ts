import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { Offer } from '@/core/types/offers';
import { BankCategory, COMBANK_CATEGORIES } from '@/config/banks';
import { ComBankFetcher } from './combank-fetcher';
import { ComBankListItem, ComBankRawOffer, parseComBankOffer } from './combank-parser';

export class ComBankScraper extends BaseScraper {
  readonly bankName = 'combank';
  readonly categories = COMBANK_CATEGORIES;

  private readonly fetcher: ComBankFetcher;

  constructor(config: ScraperConfig & { skipDetails?: boolean }) {
    super(config);
    this.fetcher = new ComBankFetcher(this.http, !config.skipDetails);
  }

  protected async fetchCategoryRawData(category: BankCategory): Promise<ComBankListItem[]> {
    return this.fetcher.fetchList(category);
  }

  protected async fetchItemDetail(rawItem: unknown): Promise<ComBankRawOffer> {
    return this.fetcher.fetchDetail(rawItem as ComBankListItem);
  }

  protected buildOffer(rawDetail: unknown): Offer | null {
    return parseComBankOffer(rawDetail as ComBankRawOffer);
  }
}
