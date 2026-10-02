import { SeylanScraper } from '@/banks/seylan/seylan-scraper';
import { SEYLAN_CATEGORIES } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { Logger } from '@/infrastructure/logger/logger';
import * as path from 'path';

describe('SeylanScraper', () => {
  let httpClient: jest.Mocked<HttpClient>;
  let scraper: SeylanScraper;

  beforeEach(() => {
    httpClient = {
      getHTML: jest.fn(),
    } as unknown as jest.Mocked<HttpClient>;

    scraper = new SeylanScraper({
      http: httpClient,
      logger: new Logger('test-seylan', path.join(__dirname, '..', '..', 'logs')),
      concurrency: 2,
    });
    (scraper as { categories: typeof SEYLAN_CATEGORIES }).categories = [SEYLAN_CATEGORIES[0]];
  });

  it('scrapes listing and detail pages into typed offers', async () => {
    httpClient.getHTML.mockImplementation(async (url: string) => {
      if (url === SEYLAN_CATEGORIES[0].url) {
        return {
          data: `
            <html><body>
              <a class="new-promotion-btn" href="https://www.seylan.lk/cool-planet-1">View</a>
            </body></html>
          `,
          fromCache: false,
          status: 200,
        };
      }

      return {
        data: `
          <section class="offer-detail">
            <div class="col-md-6"><img src="/images/cool-planet.jpg" /></div>
            <div class="col-md-6">
              <h2 class="h11">Cool Planet</h2>
              <p class="h44">25% off on clothing for Seylan credit cards</p>
              <div class="h44">Address: No. 10, Galle Road, Colombo 03</div>
              <div class="h44">Tel No: 011 234 5678</div>
              <h4>Valid until 31st December 2026</h4>
              <div class="des">
                <ul>
                  <li>Minimum Transaction Value - Rs. 10,000</li>
                  <li>Offer cannot be combined with other offers.</li>
                </ul>
              </div>
            </div>
          </section>
        `,
        fromCache: false,
        status: 200,
      };
    });

    const offers = await scraper.scrape();

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      source: 'seylan',
      title: 'Cool Planet',
      category: SEYLAN_CATEGORIES[0].name,
      categoryId: SEYLAN_CATEGORIES[0].id,
    });
    expect(offers[0].merchant.addresses[0]).toContain('Galle Road');
    expect(offers[0].merchant.phone).toContain('011 234 5678');
    expect(offers[0].transactionRange.min).toBe(10000);
    expect(offers[0].validityPeriods[0].validTo).toBe('2026-12-31');
    expect(offers[0].rawHtml).toContain('offer-detail');
  });
});
