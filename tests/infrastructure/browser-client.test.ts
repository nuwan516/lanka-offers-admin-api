import { BrowserClient, MissingBrowserDependencyError } from '@/infrastructure/browser/browser-client';

describe('BrowserClient', () => {
  it('reports missing Puppeteer with a clear runtime error', async () => {
    if (BrowserClient.isAvailable()) return;

    const client = new BrowserClient({ waitForContentMs: 0 });
    await expect(client.extract('https://example.com', () => [])).rejects.toBeInstanceOf(MissingBrowserDependencyError);
  });
});
