import * as fs from 'fs';
import * as path from 'path';
import { exportDryRunArtifacts } from '@/cli/dry-run-exporter';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';
import type { ValidationPipelineReport } from '@/parsing/validators/validation-pipeline';

function makeMockOffer(id = '001', title = '20% Off Dining at Cafe'): Offer {
  return {
    uniqueId: `sampath_${id}`,
    source: 'sampath',
    sourceId: id,
    sourceUrl: 'https://deals.sampathbank.lk/deals/001',
    title,
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
      description: 'Enjoy 20% off with Sampath Platinum cards',
      discountPercentage: 20,
      applicableCards: ['Sampath Platinum Credit Card'],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: ['Sampath Platinum'],
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

describe('Dry-Run Architecture & Isolation Tests (Phase 4)', () => {
  const tmpOutputDir = path.join(__dirname, '..', '..', 'tmp-dry-run-test');

  afterEach(() => {
    try {
      if (fs.existsSync(tmpOutputDir)) {
        fs.rmSync(tmpOutputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } catch {
      // Ignored for transient Windows locks
    }
  });

  it('exports complete isolated directory structure with all 6 required artifacts', () => {
    const rawOffers = [makeMockOffer('001'), makeMockOffer('002')];
    const normalizedOffers = [makeMockOffer('001'), makeMockOffer('002')];
    const mockReports: ValidationPipelineReport[] = [
      {
        offerId: 'sampath_001',
        passed: true,
        shouldUseLlm: true,
        llmReason: 'sampled',
        ruleValidation: {
          valid: true,
          errors: [],
          warnings: [],
        },
        llmValidation: {
          isValidOffer: true,
          extractionScore: 95,
          confidence: 0.95,
          issues: [],
          rawCompared: true,
        } as any,
        llmReused: false,
      },
      {
        offerId: 'sampath_002',
        passed: true,
        shouldUseLlm: true,
        llmReason: 'sampled',
        ruleValidation: {
          valid: true,
          errors: [],
          warnings: [{ field: 'category', message: 'Inferred category', severity: 'warning' }],
        },
        llmValidation: {
          isValidOffer: true,
          extractionScore: 90,
          confidence: 0.9,
          issues: [],
          rawCompared: true,
        } as any,
        llmReused: false,
      },
    ];

    const result = exportDryRunArtifacts({
      bank: 'sampath',
      rawOffers,
      normalizedOffers,
      duplicatesRemoved: 0,
      validationReports: mockReports,
      durationMs: 1500,
      options: { maxCategories: 2, dryRun: true },
      baseOutputDir: tmpOutputDir,
    });

    expect(fs.existsSync(result.exportDir)).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);

    // Verify all 6 artifacts exist
    const manifest = result.manifest;
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.manifest))).toBe(true);
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.rawOffers))).toBe(true);
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.normalizedOffers))).toBe(true);
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.validationResults))).toBe(true);
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.qualityReport))).toBe(true);
    expect(fs.existsSync(path.join(result.exportDir, manifest.artifacts.errors))).toBe(true);

    // Verify manifest contents and isolation guarantee
    expect(manifest.bank).toBe('sampath');
    expect(manifest.isolation).toBe('STRICT_NO_DB_MUTATION');
    expect(manifest.counts.raw).toBe(2);
    expect(manifest.counts.normalized).toBe(2);
    expect(manifest.counts.validHighConfidence).toBe(1);
    expect(manifest.counts.validWithWarnings).toBe(1);

    // Verify quality-report.json structure
    const qualityReport = JSON.parse(
      fs.readFileSync(path.join(result.exportDir, 'quality-report.json'), 'utf8')
    );
    expect(qualityReport.bank).toBe('sampath');
    expect(qualityReport.categories.VALID_HIGH_CONFIDENCE.count).toBe(1);
    expect(qualityReport.categories.VALID_WITH_WARNINGS.count).toBe(1);
    expect(qualityReport.offers.length).toBe(2);
  });

  it('guarantees that dry-run artifacts reside outside database staging queues', () => {
    const rawOffers = [makeMockOffer('001')];
    const result = exportDryRunArtifacts({
      bank: 'combank',
      rawOffers,
      normalizedOffers: rawOffers,
      duplicatesRemoved: 0,
      validationReports: [],
      durationMs: 500,
      baseOutputDir: tmpOutputDir,
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    // Manifest must specify isolation
    expect(manifest.isolation).toBe('STRICT_NO_DB_MUTATION');
    // Artifact path must be in dry-runs directory
    expect(result.exportDir).toContain(path.join('dry-runs', 'combank'));
  });

  it('confirms dry-run manifest strictly declares STRICT_NO_DB_MUTATION', () => {
    const result = exportDryRunArtifacts({
      bank: 'seylan',
      rawOffers: [makeMockOffer('001')],
      normalizedOffers: [makeMockOffer('001')],
      duplicatesRemoved: 0,
      validationReports: [],
      durationMs: 300,
      baseOutputDir: tmpOutputDir,
    });

    const manifestContent = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    expect(manifestContent.isolation).toBe('STRICT_NO_DB_MUTATION');
    expect(manifestContent.counts.raw).toBe(1);
    expect(manifestContent.counts.normalized).toBe(1);
  });
});

