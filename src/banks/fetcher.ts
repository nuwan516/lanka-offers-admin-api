import { BankCategory } from '@/config/banks';

export interface IFetcher {
  /** Fetch the raw list of items for a given category (with optional pagination). */
  fetchList(category: BankCategory): Promise<unknown[]>;

  /** Fetch detailed data for a single raw item. */
  fetchDetail(rawItem: unknown): Promise<unknown>;
}
