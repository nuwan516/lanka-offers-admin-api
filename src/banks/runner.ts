import { IFetcher } from './fetcher';
import { Offer } from '@/core/types/offers';
import { BankCategory } from '@/config/banks';
import { Logger } from '@/infrastructure/logger/logger';
import { ConcurrencyPool } from '@/infrastructure/concurrency/concurrency-pool';

export interface ScrapeOptions {
  fetcher: IFetcher;
  categories: BankCategory[];
  logger: Logger;
  concurrency: number;
  /** Turn raw detail into an Offer (pure function) */
  parseOffer: (rawDetail: unknown, category: BankCategory) => Offer | null;
}

export async function scrapeAll(options: ScrapeOptions): Promise<Offer[]> {
  const { fetcher, categories, logger, concurrency, parseOffer } = options;
  const pool = new ConcurrencyPool(concurrency);
  const allOffers: Offer[] = [];

  for (const category of categories) {
    logger.info('Category', `Processing ${category.name}`);

    // 1. Fetch list
    const rawList = await fetcher.fetchList(category);
    logger.debug('Category', `Fetched ${rawList.length} list items`);

    // 2. Fetch details in parallel (limited by pool)
    const details = await pool.all(rawList.map(item => () => fetcher.fetchDetail(item)));

    // 3. Parse offers (synchronous pure function, could be parallel if needed)
    const offers = details
      .map(detail => parseOffer(detail, category))
      .filter((o): o is Offer => o !== null);

    allOffers.push(...offers);
    logger.success('Category', `${category.name}: ${offers.length} offers`);
  }

  return allOffers;
}
