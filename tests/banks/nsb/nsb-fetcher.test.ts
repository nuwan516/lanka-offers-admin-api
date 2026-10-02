import { NSBFetcher } from '@/banks/nsb/nsb-fetcher';
import { HttpClient } from '@/infrastructure/http/http-client';

function listingHtml(items: Array<{ title: string; href: string }>): string {
  const cards = items
    .map(
      (i) => `
      <div class="media-center-item mb-5">
        <div class="row">
          <h5 class="mb-3 mt-0 col-md-12">${i.title}</h5>
          <div class="col-md-4 media-center-img"><img src="/thumb.jpg" /></div>
          <div class="col-md-8 media-center-content">
            <p>Excerpt text</p>
            <a class="btn btn-1" href="${i.href}">Read More</a>
          </div>
        </div>
      </div>`,
    )
    .join('\n');
  return `<div class="row item-boxes mt-4">${cards}</div>`;
}

function detailHtml(): string {
  return `
    <div class="media-center-item">
      <div class="row">
        <h5 class="mb-3 mt-0 col-md-12">Spend and Win</h5>
        <div class="col-md-12 media-center-content">
          <p>Spend and Win, merchant vouchers worth Rs. 1 million</p>
          <ul><li>Promo period – 10th to 31st December 2025</li></ul>
        </div>
      </div>
    </div>`;
}

describe('NSBFetcher — pagination', () => {
  it('follows /page/N/ until a page repeats or returns nothing new', async () => {
    const getHTML = jest.fn(async (url: string) => {
      if (url === 'https://www.nsb.lk/category/card-offers/') {
        return { data: listingHtml([{ title: 'Offer A', href: '/offer-a/' }]), fromCache: false, status: 200 };
      }
      if (url === 'https://www.nsb.lk/category/card-offers/page/2/') {
        return { data: listingHtml([{ title: 'Offer B', href: '/offer-b/' }]), fromCache: false, status: 200 };
      }
      // page 3 and beyond: WP redirects back to page 1 content
      return { data: listingHtml([{ title: 'Offer A', href: '/offer-a/' }]), fromCache: false, status: 200 };
    });
    const http = { getHTML } as unknown as HttpClient;

    const fetcher = new NSBFetcher(http, true, 5);
    const items = await fetcher.fetchList({ id: 1, name: 'Card Offers', url: 'https://www.nsb.lk/category/card-offers/' } as any);

    expect(items.map((i) => i.title)).toEqual(['Offer A', 'Offer B']);
  });

  it('stops immediately when a page 404s', async () => {
    const getHTML = jest.fn(async (url: string) => {
      if (url === 'https://www.nsb.lk/category/card-offers/') {
        return { data: listingHtml([{ title: 'Only Offer', href: '/only/' }]), fromCache: false, status: 200 };
      }
      throw new Error('404');
    });
    const http = { getHTML } as unknown as HttpClient;

    const fetcher = new NSBFetcher(http, true, 5);
    const items = await fetcher.fetchList({ id: 1, name: 'Card Offers', url: 'https://www.nsb.lk/category/card-offers/' } as any);

    expect(items).toHaveLength(1);
  });
});

describe('NSBFetcher — detail page parsing', () => {
  it('extracts title, paragraphs, list terms, and promo period', async () => {
    const http = { getHTML: async () => ({ data: detailHtml(), fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new NSBFetcher(http, true);

    const raw = await fetcher.fetchDetail({ title: 'x', excerpt: '', thumbnailUrl: null, detailUrl: 'https://www.nsb.lk/spend-and-win/' });

    expect(raw.detail?.title).toBe('Spend and Win');
    expect(raw.detail?.paragraphs).toContain('Spend and Win, merchant vouchers worth Rs. 1 million');
    expect(raw.detail?.promoPeriod).toBe('10th to 31st December 2025');
  });

  it('recognizes "Offer Period –" label too, not just "Promo period"', async () => {
    const html = `
      <div class="media-center-item">
        <div class="row">
          <h5 class="mb-3 mt-0 col-md-12">Test Offer</h5>
          <div class="col-md-12 media-center-content">
            <p>Some description</p>
            <ul><li>Offer Period – 07th to 09th August 2026</li></ul>
          </div>
        </div>
      </div>`;
    const http = { getHTML: async () => ({ data: html, fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new NSBFetcher(http, true);
    const raw = await fetcher.fetchDetail({ title: 'x', excerpt: '', thumbnailUrl: null, detailUrl: 'https://www.nsb.lk/test-offer/' });
    expect(raw.detail?.promoPeriod).toBe('07th to 09th August 2026');
  });

  it('recognizes the labelled-fields style "Duration:" field', async () => {
    const html = `
      <div class="media-center-item">
        <div class="row">
          <h5 class="mb-3 mt-0 col-md-12">Test Offer</h5>
          <div class="col-md-12 media-center-content">
            <p>Discount: 20%</p>
            <p>Duration: 07th to 09th August 2026</p>
          </div>
        </div>
      </div>`;
    const http = { getHTML: async () => ({ data: html, fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new NSBFetcher(http, true);
    const raw = await fetcher.fetchDetail({ title: 'x', excerpt: '', thumbnailUrl: null, detailUrl: 'https://www.nsb.lk/test-offer/' });
    expect(raw.detail?.promoPeriod).toBe('07th to 09th August 2026');
  });

  // Confirmed live: at least one post duplicates its entire body block
  // twice within the same page DOM — without dedup every paragraph and
  // list item (including the promo period line) would appear twice.
  it('dedupes a duplicated content block instead of doubling every paragraph/list item', async () => {
    const block = `
      <div class="media-center-item">
        <div class="row">
          <h5 class="mb-3 mt-0 col-md-12">Duplicated Post</h5>
          <div class="col-md-12 media-center-content">
            <p>Enjoy 20% off with your NSB card</p>
            <ul><li>Promo period – 10th to 31st December 2026</li></ul>
          </div>
        </div>
      </div>`;
    const http = { getHTML: async () => ({ data: block + block, fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new NSBFetcher(http, true);
    const raw = await fetcher.fetchDetail({ title: 'x', excerpt: '', thumbnailUrl: null, detailUrl: 'https://www.nsb.lk/dup/' });

    expect(raw.detail?.paragraphs).toEqual(['Enjoy 20% off with your NSB card']);
    expect(raw.detail?.listItems).toEqual(['Promo period – 10th to 31st December 2026']);
  });

  it('an image-only post with no extractable text does not crash', async () => {
    const html = `
      <div class="media-center-item">
        <div class="row">
          <h5 class="mb-3 mt-0 col-md-12">Image Only Post</h5>
          <div class="col-md-12 media-center-content">
            <p><img src="/promo-banner.jpg" /></p>
          </div>
        </div>
      </div>`;
    const http = { getHTML: async () => ({ data: html, fromCache: false, status: 200 }) } as unknown as HttpClient;
    const fetcher = new NSBFetcher(http, true);
    const raw = await fetcher.fetchDetail({ title: 'x', excerpt: '', thumbnailUrl: null, detailUrl: 'https://www.nsb.lk/image-only/' });

    expect(raw.detail?.paragraphs).toEqual([]);
    expect(raw.detail?.promoPeriod).toBeNull();
    expect(raw.detail?.images).toContain('https://www.nsb.lk/promo-banner.jpg');
  });
});
