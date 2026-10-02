import { Offer } from '@/core/types/offers';
import { HttpClient } from '@/infrastructure/http/http-client';
import { Logger } from '@/infrastructure/logger/logger';
import { ConcurrencyPool } from '@/infrastructure/concurrency/concurrency-pool';
import { BankCategory } from '@/config/banks';

export interface ScraperConfig {
    http: HttpClient;
    logger: Logger;
    concurrency: number;
    categoryConcurrency?: number;  // how many categories to process in parallel (default 1)
    maxCategories?: number;        // smoke-test limit; omitted means all categories
}

export abstract class BaseScraper {
    abstract readonly bankName: string;
    abstract readonly categories: BankCategory[];

    protected http: HttpClient;
    protected logger: Logger;
    protected pool: ConcurrencyPool;

    constructor(protected config: ScraperConfig) {
        this.http = config.http;
        this.logger = config.logger;
        this.pool = new ConcurrencyPool(config.concurrency);
    }

    /** Main entry point. Loops over categories and returns all offers. */
    async scrape(): Promise<Offer[]> {
        this.logger.info('Scraper', `Starting ${this.bankName}`);

        const allOffers: Offer[] = [];
        const categoryConcurrency = this.config.categoryConcurrency ?? 1;

        const categories = this.config.maxCategories && this.config.maxCategories > 0
            ? this.categories.slice(0, this.config.maxCategories)
            : this.categories;

        // Process categories with limited parallelism
        const categoryPool = new ConcurrencyPool(categoryConcurrency);
        const failedCategories: string[] = [];
        await categoryPool.all(
            categories.map(cat => async () => {
                // One dead category (stale seasonal URL → 404) must not abort the
                // whole bank run — log it and keep the offers we can get.
                try {
                    const offers = await this.processCategory(cat);
                    allOffers.push(...offers);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    failedCategories.push(cat.name);
                    this.logger.warn('Category', `${cat.name} failed, skipping: ${message}`);
                }
            })
        );
        if (failedCategories.length > 0) {
            this.logger.warn('Scraper', `${this.bankName}: ${failedCategories.length} categories failed`, { failedCategories });
        }

        // A "successful" run that found nothing is a red flag, not a clean
        // result — a bank's entire catalog going to zero, especially with no
        // category failures, usually means a WAF/bot-block soft-emptied the
        // response (200 status, empty payload) rather than a genuine
        // site-wide absence of offers. Surface it loudly so it can't be
        // mistaken for success in the logs.
        if (allOffers.length === 0 && categories.length > 0) {
            this.logger.warn(
                'Scraper',
                `${this.bankName}: 0 offers from ${categories.length} categories with no category failures — ` +
                'possible soft-block (WAF/rate-limit returning 200 with empty data) rather than a genuine empty catalog. Verify manually before trusting this result.',
            );
        }

        this.logger.info('Scraper', `Completed ${this.bankName}: ${allOffers.length} offers`);
        return allOffers;
    }

    /** Process one category: fetch raw list, then details, then build offers */
    private async processCategory(category: BankCategory): Promise<Offer[]> {
        this.logger.info('Category', `Processing ${category.name}`);

        const rawItems = await this.fetchCategoryRawData(category);
        this.logger.debug('Category', `Fetched ${rawItems.length} raw items`);

        const rawDetails = await this.fetchAllDetails(rawItems);
        this.logger.debug('Category', `Fetched ${rawDetails.length} details`);

        const offers = rawDetails
            .map(detail => this.buildOffer(detail))
            .filter((offer): offer is Offer => offer !== null);

        this.logger.success('Category', `${category.name}: ${offers.length} offers`);
        return offers;
    }

    /** Fetch the initial list of items for a category. Returns an array of raw data (type unknown). */
    protected abstract fetchCategoryRawData(category: BankCategory): Promise<unknown[]>;

    /** Fetch details for each raw item. Default: map over items calling fetchItemDetail. */
    protected async fetchAllDetails(rawItems: unknown[]): Promise<unknown[]> {
        return this.pool.all(rawItems.map(item => () => this.fetchItemDetail(item)));
    }

    /** Fetch detail for one raw item. Override if list already contains full detail. */
    protected async fetchItemDetail(rawItem: unknown): Promise<unknown> {
        return rawItem; // by default, identity
    }

    /** Build an Offer from a detail item. Must be overridden. */
    protected abstract buildOffer(rawDetail: unknown): Offer | null;
}
