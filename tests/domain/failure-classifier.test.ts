import { classifyScraperFailure } from '@/domain/failure-classifier';

describe('Failure Classifier (Batch E4 & C4)', () => {
  it('classifies operator cancellations as CANCELLED', () => {
    const res = classifyScraperFailure('Cancelled by operator (reconciled orphaned run)');
    expect(res.classification).toBe('CANCELLED');
    expect(res.isRetryable).toBe(false);
    expect(res.alertSeverity).toBe('INFO');
  });

  it('classifies execution timeouts as TIMEOUT', () => {
    const res = classifyScraperFailure('Scraper for hnb exceeded maximum timeout (900s). Terminating...');
    expect(res.classification).toBe('TIMEOUT');
    expect(res.isRetryable).toBe(true);
    expect(res.alertSeverity).toBe('WARNING');
  });

  it('classifies anti-bot and rate-limiting blocks as RATE_LIMITED', () => {
    const res = classifyScraperFailure('Cloudflare WAF challenged request with 403 Forbidden', { httpStatus: 429 });
    expect(res.classification).toBe('RATE_LIMITED');
    expect(res.isRetryable).toBe(true);
    expect(res.isSourceOutage).toBe(true);
    expect(res.alertSeverity).toBe('CRITICAL');
  });

  it('classifies headless browser and chromium crashes as BROWSER_FAILURE', () => {
    const res = classifyScraperFailure('Puppeteer session closed: Target closed or browser process crashed');
    expect(res.classification).toBe('BROWSER_FAILURE');
    expect(res.isRetryable).toBe(true);
    expect(res.alertSeverity).toBe('WARNING');
  });

  it('classifies network connection drops as NETWORK_ERROR', () => {
    const res = classifyScraperFailure('Fetch failed: ECONNRESET socket hang up');
    expect(res.classification).toBe('NETWORK_ERROR');
    expect(res.isRetryable).toBe(true);
    expect(res.isSourceOutage).toBe(true);
  });

  it('classifies database errors as DATABASE_FAILURE', () => {
    const res = classifyScraperFailure('error: duplicate key value violates unique constraint "offers_unique_id_idx"');
    expect(res.classification).toBe('DATABASE_FAILURE');
    expect(res.isRetryable).toBe(false);
    expect(res.alertSeverity).toBe('CRITICAL');
  });

  it('classifies sudden zero offers when previous scrape had offers as SOURCE_CHANGED anomaly', () => {
    const res = classifyScraperFailure('', { offersFound: 0, prevFound: 45 });
    expect(res.classification).toBe('SOURCE_CHANGED');
    expect(res.isRetryable).toBe(false);
    expect(res.isSourceOutage).toBe(true);
    expect(res.alertSeverity).toBe('CRITICAL');
  });

  it('classifies routine zero offers with no previous baseline as NO_OFFERS_FOUND (non-error)', () => {
    const res = classifyScraperFailure('', { offersFound: 0, prevFound: 0 });
    expect(res.classification).toBe('NO_OFFERS_FOUND');
    expect(res.alertSeverity).toBe('INFO');
  });

  it('classifies DOM selector or parser syntax errors as PARSER_FAILURE', () => {
    const res = classifyScraperFailure('TypeError: Cannot read property of undefined evaluating selector');
    expect(res.classification).toBe('PARSER_FAILURE');
    expect(res.alertSeverity).toBe('WARNING');
  });
});
