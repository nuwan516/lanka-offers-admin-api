import { ComBankFetcher } from '@/banks/combank/combank-fetcher';
import { HttpClient } from '@/infrastructure/http/http-client';

function listingHtml(): string {
  return `
    <div class="offers-area">
      <div class="offers-row" id="seasonal-offers">
        <div class="title-row"><h3 class="sub-title">Seasonal Offers</h3></div>
        <div class="rewards-row">
          <a class="reward" href="/rewards-promotion/food-restaurants/softlogic">
            <div class="reward-image" style="background-image: url('https://cdn.combank.lk/thumb.jpg')"></div>
            <div class="offer-tag percentage"><p>Up to</p><p class="percentage">20%</p><p>Off</p></div>
            <div class="reward-content">
              <p class="category">Food &amp; Restaurants</p>
              <h3>Enjoy dining at Softlogic Restaurants with ComBank Credit and Debit Cards</h3>
              <p class="valid-date">Offer valid on every Wednesday from 01st July to 26th August 2026</p>
            </div>
          </a>
        </div>
      </div>
      <div class="offers-row" id="travel-offers">
        <div class="title-row"><h3 class="sub-title">Travel</h3></div>
        <div class="rewards-row">
          <a class="reward" href="/rewards-promotion/travel/hotel-deal">
            <div class="reward-image" style="background-image: url('https://cdn.combank.lk/hotel.jpg')"></div>
            <div class="offer-tag percentage"><p>15%</p><p>Off</p></div>
            <div class="reward-content">
              <p class="category">Travel</p>
              <h3>15% off at Cinnamon Hotels with ComBank Credit Cards</h3>
              <p class="valid-date">Offer valid till 31st December 2026</p>
            </div>
          </a>
        </div>
      </div>
    </div>`;
}

function detailHtml(): string {
  return `
    <div class="news-content-container">
      <figure class="reward-image"><img src="https://cdn.combank.lk/detail.jpg" /></figure>
      <div class="editor-content">
        <p><br></p>
        <p><b><u>Offer terms and conditions</u></b></p>
        <ul>
          <li>Offer – 20% for Credit Cards and 10% for Debit Cards</li>
          <li>Visit – <br>Burger King<br>Popeyes<br>Delifrance</li>
        </ul>
        <p><b><u>Terms and conditions</u></b></p>
        <ul><li>Open to all Commercial Bank cards</li></ul>
      </div>
    </div>`;
}

describe('ComBankFetcher — single-page listing across offers-row blocks', () => {
  it('extracts items from every offers-row with its own category label', async () => {
    const http = { getHTML: async () => ({ data: listingHtml(), fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new ComBankFetcher(http);

    const items = await fetcher.fetchList({ id: 1, name: 'Rewards & Promotions', url: 'https://www.combank.lk/rewards-promotions' } as any);

    expect(items).toHaveLength(2);
    expect(items[0].categoryLabel).toBe('Food & Restaurants');
    expect(items[0].discountPercentage).toBe(20);
    expect(items[0].isUpTo).toBe(true);
    expect(items[1].categoryLabel).toBe('Travel');
    expect(items[1].discountPercentage).toBe(15);
    expect(items[1].isUpTo).toBe(false);
  });

  it('parses the offer-tag fragments with spaces (not glued together)', async () => {
    const http = { getHTML: async () => ({ data: listingHtml(), fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new ComBankFetcher(http);
    const items = await fetcher.fetchList({ id: 1, name: 'x', url: 'https://www.combank.lk/rewards-promotions' } as any);
    expect(items[0].discountText).toBe('Up to 20% Off');
  });
});

describe('ComBankFetcher — detail page section parsing', () => {
  it('splits editor-content into named sections and excludes boilerplate from offer terms', async () => {
    const http = { getHTML: async () => ({ data: detailHtml(), fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new ComBankFetcher(http);

    const raw = await fetcher.fetchDetail({
      title: 'x', categoryLabel: 'x', discountText: '', discountPercentage: null, isUpTo: false,
      validityRaw: '', imageUrl: null, detailUrl: 'https://www.combank.lk/offer/1',
    });

    const sections = raw.detail?.sections ?? {};
    expect(Object.keys(sections)).toEqual(expect.arrayContaining(['Offer terms and conditions', 'Terms and conditions']));
    expect(sections['Offer terms and conditions'][0].text).toContain('20% for Credit Cards');
  });

  it('preserves multi-line <br>-separated list items as a `lines` array', async () => {
    const http = { getHTML: async () => ({ data: detailHtml(), fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new ComBankFetcher(http);
    const raw = await fetcher.fetchDetail({
      title: 'x', categoryLabel: 'x', discountText: '', discountPercentage: null, isUpTo: false,
      validityRaw: '', imageUrl: null, detailUrl: 'https://www.combank.lk/offer/1',
    });

    const visitEntry = raw.detail?.sections['Offer terms and conditions'].find((e) => e.text.startsWith('Visit'));
    expect(visitEntry?.lines).toEqual(['Visit –', 'Burger King', 'Popeyes', 'Delifrance']);
  });

  it('captures an embedded table (DHL/NCG-style) as one row-per-entry instead of dropping it', async () => {
    const html = `
      <div class="news-content-container">
        <div class="editor-content">
          <p><b><u>Offer terms and conditions</u></b></p>
          <table>
            <tr><th>Location</th><th>Contact No.</th><th>Address</th></tr>
            <tr><td>Colombo 03</td><td>011 2 345 678</td><td>No 10, Galle Road</td></tr>
            <tr><td>Kandy</td><td>081 2 345 678</td><td>No 5, Peradeniya Road</td></tr>
          </table>
        </div>
      </div>`;
    const http = { getHTML: async () => ({ data: html, fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new ComBankFetcher(http);
    const raw = await fetcher.fetchDetail({
      title: 'x', categoryLabel: 'x', discountText: '', discountPercentage: null, isUpTo: false,
      validityRaw: '', imageUrl: null, detailUrl: 'https://www.combank.lk/offer/dhl',
    });

    const rows = raw.detail?.sections['Offer terms and conditions'] ?? [];
    // header row + 2 data rows
    expect(rows).toHaveLength(3);
    expect(rows[1].text).toBe('Colombo 03 | 011 2 345 678 | No 10, Galle Road');
    expect(rows[2].text).toBe('Kandy | 081 2 345 678 | No 5, Peradeniya Road');
  });
});
