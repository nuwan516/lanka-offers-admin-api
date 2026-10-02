/**
 * DFCC fetcher additions (2026-07-19): a fallback selector chain for
 * category pages mid-migration off the a.cardd template (matches the
 * tested legacy scraper's approach), and PDF terms extraction — DFCC
 * categories were flagged pdfRequired in config but nothing consumed it.
 */
import { DFCCFetcher } from '@/banks/dfcc/dfcc-fetcher';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import { HttpClient } from '@/infrastructure/http/http-client';

describe('DFCCFetcher — listing selector fallback chain', () => {
  it('falls back to a[href*="cards-promotions"] when a.cardd is absent', async () => {
    const browser = {
      extract: jest.fn(async (_url: string, extractor: () => unknown) => {
        (globalThis as any).document = makeDoc(`
          <a href="/cards-promotions/laugfs" class="promo-link">
            <h4>10% off at Laugfs</h4>
            <img src="/laugfs.png" alt="Laugfs" />
          </a>
        `);
        return extractor();
      }),
    } as unknown as BrowserClient;

    const fetcher = new DFCCFetcher(browser, true);
    const items = await fetcher.fetchList({ id: 1, name: 'Supermarkets', url: 'https://www.dfcc.lk/x' } as any);

    expect(items).toHaveLength(1);
    expect(items[0].offerText).toBe('10% off at Laugfs');
    expect(items[0].detailUrl).toBe('https://www.dfcc.lk/cards-promotions/laugfs');
  });
});

describe('DFCCFetcher — detail pages are disabled (confirmed always-404 live 2026-08-01)', () => {
  // Every "Read More" link 200s at the HTTP level but client-side-routes to
  // "Page Not Found (404)" — there is no working detail page on this site.
  // fetchDetail short-circuits before ever navigating, so these assert the
  // browser is never invoked at all rather than exercising PDF enrichment
  // (which is unreachable dead code, kept only in case DFCC fixes routing).
  it('never navigates to the detail page — detail is always null', async () => {
    const browser = { extract: jest.fn() } as unknown as BrowserClient;
    const http = { downloadBuffer: jest.fn() } as unknown as HttpClient;

    const fetcher = new DFCCFetcher(browser, true, http);
    const raw = await fetcher.fetchDetail({ detailUrl: 'https://www.dfcc.lk/offer/1' } as any);

    expect(browser.extract).not.toHaveBeenCalled();
    expect(raw.detail).toBeNull();
  });

  it('does not attempt PDF extraction since detail fetching is disabled', async () => {
    const browser = { extract: jest.fn() } as unknown as BrowserClient;
    const http = { downloadBuffer: jest.fn() } as unknown as HttpClient;
    const fetcher = new DFCCFetcher(browser, true, http);
    await fetcher.fetchDetail({ detailUrl: 'https://www.dfcc.lk/offer/2' } as any);

    expect(http.downloadBuffer).not.toHaveBeenCalled();
  });
});

function makeDoc(bodyHtml: string) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(`<html><body>${bodyHtml}</body></html>`);
  // Minimal DOM shim matching what the extractor functions call.
  return {
    querySelectorAll: (sel: string) => {
      const found = $(sel).toArray();
      return found.map((el: any) => wrapEl($, el));
    },
  };
}

function wrapEl($: any, el: any) {
  const $el = $(el);
  return {
    tagName: (el.tagName ?? '').toUpperCase(),
    getAttribute: (name: string) => $el.attr(name) ?? null,
    querySelector: (sel: string) => {
      const found = $el.find(sel).first();
      if (found.length === 0) return null;
      return wrapEl($, found.get(0));
    },
    get textContent() {
      return $el.text();
    },
    get src() {
      return $el.attr('src') ?? '';
    },
    get alt() {
      return $el.attr('alt') ?? '';
    },
    get href() {
      return $el.attr('href') ?? '';
    },
  };
}
