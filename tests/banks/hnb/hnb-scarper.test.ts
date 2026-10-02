import { HNBScraper } from '@/banks/hnb/hnb-scraper';
import { HttpClient } from '@/infrastructure/http/http-client';
import { Logger } from '@/infrastructure/logger/logger';
import { FileCache } from '@/infrastructure/cache/file-cache';
import * as path from 'path';
import * as fs from 'fs';

jest.mock('@/infrastructure/http/http-client');

describe('HNBScraper', () => {
    let httpClient: jest.Mocked<HttpClient>;
    let logger: Logger;
    let cache: FileCache;
    let scraper: HNBScraper;

    const fixtureDir = path.join(__dirname, '__fixtures__');
    const listingFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'hnb-listing.json'), 'utf-8'));
    const detailFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'hnb-detail.json'), 'utf-8'));

    beforeEach(() => {
        httpClient = {
            getJSON: jest.fn(),
        } as any;
        logger = new Logger('test-hnb', path.join(__dirname, '..', '..', 'logs'));
        cache = new FileCache(path.join(__dirname, '..', '..', 'cache'));
        scraper = new HNBScraper({
            http: httpClient,
            logger,
            concurrency: 2,
        });
    });

    afterEach(() => {
        cache.clear();
    });

    it('scrapes a category and returns offers', async () => {
        httpClient.getJSON.mockImplementation(async (url: string) => {
            if (url.includes('get_all_web_card_promos')) {
                return { data: listingFixture, fromCache: false, status: 200 };
            } else if (url.includes('get_web_card_promo')) {
                return { data: detailFixture, fromCache: false, status: 200 };
            }
            throw new Error(`Unexpected url: ${url}`);
        });

        const offers = await scraper.scrape();
        expect(offers.length).toBeGreaterThan(0);
        expect(offers[0].source).toBe('hnb');
    });
});