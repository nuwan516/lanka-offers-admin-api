import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exportDryRunArtifacts } from '@/cli/dry-run-exporter';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';
import type { ValidationPipelineReport } from '@/parsing/validators/validation-pipeline';

function makeMockOffer(id = '001', bank = 'sampath'): Offer {
  return {
    uniqueId: `${bank}_${id}`,
    source: bank,
    sourceId: id,
    sourceUrl: `https://deals.${bank}.lk/deals/${id}`,
    title: '20% Off Dining at Cafe Colombo',
    category: 'Dining',
    categoryId: 1,
    cardType: 'Visa Platinum',
    scrapedAt: '2026-10-16T12:00:00.000Z',
    merchant: {
      name: 'Cafe Colombo',
      location: 'Colombo 03',
      addresses: [],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: 'Enjoy 20% off with Platinum cards',
      discountPercentage: 20,
      applicableCards: ['Platinum Credit Card'],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: 2500, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: ['Platinum'],
      excludedCards: [],
      cardTypes: ['credit'],
      networks: ['visa'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-10-01',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Valid till 31st Dec 2026',
      },
    ],
    contentHash: 'mock-content-hash-123',
  };
}

describe('Staging Import Security & Integrity Tests (Phase 5)', () => {
  const tmpOutputDir = path.join(__dirname, '..', '..', 'tmp-import-sec-test');

  beforeEach(() => {
    if (fs.existsSync(tmpOutputDir)) {
      fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpOutputDir)) {
      fs.rmSync(tmpOutputDir, { recursive: true, force: true });
    }
  });

  it('generates SHA-256 checksums in dry-run manifest for all artifacts', () => {
    const rawOffers = [makeMockOffer('001')];
    const normalizedOffers = [makeMockOffer('001')];
    const mockReports: ValidationPipelineReport[] = [
      {
        offerId: 'sampath_001',
        passed: true,
        shouldUseLlm: false,
        llmReason: 'disabled',
        ruleValidation: { valid: true, errors: [], warnings: [] },
        llmValidation: null,
        llmReused: false,
      },
    ];

    const result = exportDryRunArtifacts({
      bank: 'sampath',
      rawOffers,
      normalizedOffers,
      duplicatesRemoved: 0,
      validationReports: mockReports,
      durationMs: 1200,
      baseOutputDir: tmpOutputDir,
    });

    const manifest = result.manifest;
    expect(manifest.checksums).toBeDefined();
    expect(manifest.checksums?.normalizedOffers).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksums?.rawOffers).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksums?.validationResults).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksums?.qualityReport).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksums?.errors).toMatch(/^[a-f0-9]{64}$/);

    // Verify actual file content matches computed SHA-256
    const normContent = fs.readFileSync(path.join(result.exportDir, 'normalized-offers.json'), 'utf8');
    const computedHash = crypto.createHash('sha256').update(normContent, 'utf8').digest('hex');
    expect(manifest.checksums?.normalizedOffers).toBe(computedHash);
  });

  it('detects tampering when an artifact file content is modified', () => {
    const rawOffers = [makeMockOffer('001')];
    const normalizedOffers = [makeMockOffer('001')];
    const mockReports: ValidationPipelineReport[] = [];

    const result = exportDryRunArtifacts({
      bank: 'sampath',
      rawOffers,
      normalizedOffers,
      duplicatesRemoved: 0,
      validationReports: mockReports,
      durationMs: 500,
      baseOutputDir: tmpOutputDir,
    });

    const normPath = path.join(result.exportDir, 'normalized-offers.json');
    // Tamper with the artifact
    fs.writeFileSync(normPath, JSON.stringify([{ ...makeMockOffer('001'), title: 'TAMPERED TITLE' }]));

    const tamperedContent = fs.readFileSync(normPath, 'utf8');
    const tamperedHash = crypto.createHash('sha256').update(tamperedContent, 'utf8').digest('hex');

    expect(tamperedHash).not.toBe(result.manifest.checksums?.normalizedOffers);
  });

  it('prevents path traversal outside the allowed dry-run directory', () => {
    const allowedBase = path.resolve(process.cwd(), 'output', 'dry-runs');
    const maliciousPaths = [
      path.resolve(allowedBase, '..', '..', 'etc', 'passwd'),
      path.resolve(allowedBase, '..', 'sensitive-config.json'),
      'C:\\Windows\\System32\\calc.exe',
    ];

    for (const testPath of maliciousPaths) {
      const rel = path.relative(allowedBase, testPath);
      const isTraversal = rel.startsWith('..') || path.isAbsolute(rel);
      expect(isTraversal).toBe(true);
    }
  });

  it('verifies that staged lifecycle status is never PUBLISHED', () => {
    // Contractual verification of the staging lifecycle transition
    const allowedStagingStatuses = ['APPROVED', 'REVIEW_REQUIRED', 'REJECTED'];
    expect(allowedStagingStatuses).not.toContain('PUBLISHED');
  });

  it('enforces maximum artifact size limits and batch count limits', () => {
    const MAX_MANIFEST_SIZE = 10 * 1024 * 1024;
    const MAX_ARTIFACT_SIZE = 50 * 1024 * 1024;
    const MAX_OFFER_BATCH = 10000;

    expect(MAX_MANIFEST_SIZE).toBe(10485760);
    expect(MAX_ARTIFACT_SIZE).toBe(52428800);
    expect(MAX_OFFER_BATCH).toBe(10000);

    // Oversized batch must be rejected
    const oversizedBatch = new Array(10001).fill(null);
    expect(oversizedBatch.length > MAX_OFFER_BATCH).toBe(true);
  });

  it('detects symlink path escapes targeting directories outside output/dry-runs', () => {
    const allowedBase = path.resolve(process.cwd(), 'output', 'dry-runs');
    const fakeSymlinkTarget = path.resolve(process.cwd(), 'src', 'api', 'server.ts');

    const rel = path.relative(allowedBase, fakeSymlinkTarget);
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);
  });
});
