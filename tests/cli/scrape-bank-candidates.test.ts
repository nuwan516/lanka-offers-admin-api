import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';
import { getDuplicatePolicyConfig } from '@/config/duplicate-policy';

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  closePool: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('@/infrastructure/db/offer-repository', () => ({
  createScrapeRun: jest.fn(),
  completeScrapeRun: jest.fn(),
  failScrapeRun: jest.fn(),
  upsertOffer: jest.fn(),
  saveValidationReport: jest.fn(),
  getLlmFingerprints: jest.fn(),
}));

jest.mock('@/infrastructure/db/duplicate-repository', () => ({
  detectAndRecordDuplicates: jest.fn(),
  flagOfferAsDuplicate: jest.fn(),
  shouldRunDuplicateDetection: (status: string) => status === 'NEW' || status === 'CHANGED',
  loadBankCandidates: jest.fn(),
}));

jest.mock('@/banks/hnb/hnb-scraper', () => ({
  HNBScraper: jest.fn(),
}));

// scrape.ts imports every bank scraper. DFCC's fetcher does not typecheck on
// main (bank-rules branch). Mock it so this suite does not load that file.
jest.mock('@/banks/dfcc/dfcc-scraper', () => ({
  DFCCScraper: jest.fn(),
}));

import { HNBScraper } from '@/banks/hnb/hnb-scraper';
import {
  completeScrapeRun,
  createScrapeRun,
  upsertOffer,
} from '@/infrastructure/db/offer-repository';
import {
  detectAndRecordDuplicates,
  loadBankCandidates,
} from '@/infrastructure/db/duplicate-repository';
import { scrapeBank } from '@/cli/scrape';

const mockCreateRun = createScrapeRun as jest.Mock;
const mockComplete = completeScrapeRun as jest.Mock;
const mockUpsert = upsertOffer as jest.Mock;
const mockDetect = detectAndRecordDuplicates as jest.Mock;
const mockLoad = loadBankCandidates as jest.Mock;

function makeOffer(): Offer {
  return {
    uniqueId: 'hnb_001',
    source: 'hnb',
    sourceId: '001',
    sourceUrl: null,
    title: '20% off Keells Super',
    category: 'Dining',
    categoryId: 1,
    cardType: '',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Keells Super', location: null, addresses: [], phone: [], email: [], website: null, logo: null },
    offer: {
      description: '',
      discountPercentage: 20,
      applicableCards: [],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: [], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      periodType: PeriodType.OFFER,
      recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null,
      timeWindow: null,
      exclusionDays: null,
      blackoutPeriods: null,
      exclusionNotes: null,
      rawPeriodText: '',
    }],
    contentHash: 'a'.repeat(64),
  };
}

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-candidates-'));

afterAll(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('scrapeBank duplicate candidate preload', () => {
  const preloaded = [{ id: 'older-offer', bank: 'hnb', raw_offer: makeOffer(), content_hash: 'abc' }];

  beforeEach(() => {
    jest.clearAllMocks();
    (HNBScraper as unknown as jest.Mock).mockImplementation(() => ({
      scrape: async () => [makeOffer()],
    }));
    mockCreateRun.mockResolvedValue('run-1');
    mockUpsert.mockResolvedValue({
      id: 'offer-db-1',
      isNew: true,
      isChanged: false,
      isUnchanged: false,
      status: 'NEW',
      staged: false,
    });
    mockComplete.mockResolvedValue({ status: 'completed', anomalyWarning: null });
    mockLoad.mockResolvedValue(preloaded);
    mockDetect.mockResolvedValue({ flagged: false, scoredCount: 1 });
  });

  it('passes one preloaded same-bank candidate list into duplicate detection', async () => {
    await scrapeBank('hnb', {
      bank: 'hnb',
      cache: false,
      skipDetails: true,
      validate: false,
      llm: false,
      output: outputDir,
      concurrency: 1,
      dryRun: false,
    });

    const policy = getDuplicatePolicyConfig();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledWith('hnb', policy.candidateSearchLimit, policy.candidateMaxStaleDays);
    expect(mockDetect).toHaveBeenCalledTimes(1);
    expect(mockDetect.mock.calls[0][0]).toBe('offer-db-1');
    expect(mockDetect.mock.calls[0][2]).toBe('hnb');
    expect(mockDetect.mock.calls[0][4]).toBe(preloaded);
  });
});
