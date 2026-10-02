import { PeoplesScraper } from '@/banks/peoples/peoples-scraper';
import { PEOPLES_CATEGORIES } from '@/config/banks';
import { HttpClient } from '@/infrastructure/http/http-client';
import { Logger } from '@/infrastructure/logger/logger';
import * as path from 'path';

describe('PeoplesScraper', () => {
  let httpClient: jest.Mocked<HttpClient>;
  let scraper: PeoplesScraper;
  const category = PEOPLES_CATEGORIES[8];

  beforeEach(() => {
    httpClient = {
      getHTML: jest.fn(),
    } as unknown as jest.Mocked<HttpClient>;

    scraper = new PeoplesScraper({
      http: httpClient,
      logger: new Logger('test-peoples', path.join(__dirname, '..', '..', 'logs')),
      concurrency: 2,
    });
    (scraper as { categories: typeof PEOPLES_CATEGORIES }).categories = [category];
  });

  it('scrapes listing and detail pages into typed offers', async () => {
    httpClient.getHTML.mockImplementation(async (url: string) => {
      if (url === category.url) {
        return {
          data: `
            <html><body>
              <div class="offer-card">
                <div class="offer-image">
                  <a href="https://www.peoplesbank.lk/promotions/vision-care/">
                    <img src="/uploads/vision-care.jpg" />
                  </a>
                </div>
                <div class="discount-badge">20% OFF</div>
                <div class="promo-short">Vision Care</div>
                <div class="merchant-name">Eye care discount <span>hidden</span></div>
                <div class="valid-date">Till April 30, 2026 (Weekend Only)</div>
              </div>
            </body></html>
          `,
          fromCache: false,
          status: 200,
        };
      }

      return {
        data: `
          <article class="single-card">
            <div class="hero-left"><img src="/uploads/vision-care-detail.jpg" /></div>
            <h1 class="title">Vision Care - People's Bank Offer</h1>
            <div class="validity">Validity: Till April 30, 2026 (Weekend Only)</div>
            <div class="meta-row"><div>Location: No. 5, Main Street, Colombo 04</div></div>
            <div class="desc">
              <p>Minimum Spend: Rs. 5,000</p>
              <p>Maximum Bill Value: Rs. 25,000</p>
              <p>Applicable for People's Bank credit cards.</p>
            </div>
            <a class="terms-link" href="/terms/vision-care.pdf">Terms</a>
          </article>
        `,
        fromCache: false,
        status: 200,
      };
    });

    const offers = await scraper.scrape();

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      source: 'peoples',
      title: "Vision Care - People's Bank Offer",
      category: category.name,
      categoryId: category.id,
    });
    expect(offers[0].offer.discountPercentage).toBe(20);
    expect(offers[0].transactionRange).toMatchObject({ min: 5000, max: 25000 });
    expect(offers[0].cardEligibility.cardTypes).toContain('Credit Card');
    expect(offers[0].validityPeriods[0].validTo).toBe('2026-04-30');
    expect(offers[0].validityPeriods[0].recurrenceDays).toEqual(['saturday', 'sunday']);
    expect(offers[0].rawHtml).toContain('single-card');
  });
});
