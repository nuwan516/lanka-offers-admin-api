import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Offer } from '@/core/types/offers';
import type { ValidationPipelineReport } from '@/parsing/validators/validation-pipeline';
import {
  classifyDetailedOfferQuality,
  ExtendedQualityCategory,
  QualityDecision,
} from '@/domain/offer-quality-decision';

export interface DryRunErrorEntry {
  phase: 'scrape' | 'normalize' | 'validate' | 'system';
  uniqueId?: string;
  field?: string;
  message: string;
}

export interface DryRunManifest {
  manifestVersion: '1.0.0';
  bank: string;
  timestamp: string;
  durationMs: number;
  options: Record<string, unknown>;
  counts: {
    raw: number;
    normalized: number;
    duplicatesRemoved: number;
    validHighConfidence: number;
    validWithWarnings: number;
    reviewRequired: number;
    invalid: number;
    duplicateCandidate: number;
    sourceIncomplete: number;
  };
  artifacts: {
    manifest: string;
    rawOffers: string;
    normalizedOffers: string;
    validationResults: string;
    qualityReport: string;
    errors: string;
  };
  checksums?: {
    rawOffers: string;
    normalizedOffers: string;
    validationResults: string;
    qualityReport: string;
    errors: string;
  };
  isolation: 'STRICT_NO_DB_MUTATION';
}

export interface DryRunQualitySummary {
  bank: string;
  timestamp: string;
  categories: Record<
    ExtendedQualityCategory,
    { count: number; percentage: number; sampleIds: string[] }
  >;
  decisions: Record<QualityDecision, number>;
  offers: Array<{
    uniqueId: string;
    title: string;
    merchant: string;
    decision: QualityDecision;
    category: ExtendedQualityCategory;
    reasons: string[];
  }>;
}

export interface DryRunExportInput {
  bank: string;
  rawOffers: Offer[];
  normalizedOffers: Offer[];
  duplicatesRemoved: number;
  validationReports: ValidationPipelineReport[];
  errors?: DryRunErrorEntry[];
  durationMs: number;
  options?: Record<string, unknown>;
  baseOutputDir?: string;
}

export function exportDryRunArtifacts(input: DryRunExportInput): {
  exportDir: string;
  manifestPath: string;
  manifest: DryRunManifest;
} {
  const timestamp = new Date().toISOString();
  // Safe folder name for Windows & POSIX: e.g. 2026-10-16T12-30-00Z
  const folderTimestamp = timestamp.replace(/:/g, '-').replace(/\..+/, 'Z');
  const baseDir = input.baseOutputDir || path.resolve(process.cwd(), 'output');
  const exportDir = path.join(baseDir, 'dry-runs', input.bank.toLowerCase(), folderTimestamp);

  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const reportsById = new Map<string, ValidationPipelineReport>(
    input.validationReports.map((r) => [r.offerId, r])
  );

  const categoryMap: Record<ExtendedQualityCategory, string[]> = {
    VALID_HIGH_CONFIDENCE: [],
    VALID_WITH_WARNINGS: [],
    REVIEW_REQUIRED: [],
    INVALID: [],
    DUPLICATE_CANDIDATE: [],
    SOURCE_INCOMPLETE: [],
  };

  const decisionMap: Record<QualityDecision, number> = {
    AUTO_APPROVE: 0,
    REVIEW_REQUIRED: 0,
    REJECT: 0,
  };

  const offerAssessments: DryRunQualitySummary['offers'] = [];

  for (const offer of input.normalizedOffers) {
    const report = reportsById.get(offer.uniqueId);

    const isSourceIncomplete =
      !offer.title ||
      offer.title.trim().length === 0 ||
      !offer.merchant?.name ||
      offer.merchant.name.trim().length === 0 ||
      !offer.validityPeriods ||
      offer.validityPeriods.length === 0;

    const assessment = classifyDetailedOfferQuality({
      ruleValid: report?.ruleValidation.valid ?? true,
      ruleErrorCount: report?.ruleValidation.errors.length ?? 0,
      ruleWarningCount: report?.ruleValidation.warnings.length ?? 0,
      llmScore: report?.llmValidation?.extractionScore ?? null,
      llmValid: report?.llmValidation?.isValidOffer ?? null,
      llmStatus: report?.llmValidation?.issues.includes('BUDGET_BLOCKED')
        ? 'skipped_budget'
        : report?.llmValidation?.issues.includes('LLM_VALIDATION_FAILED')
        ? 'review_required'
        : report?.llmValidation
        ? 'validated'
        : null,
      isSourceIncomplete,
    });

    categoryMap[assessment.category].push(offer.uniqueId);
    decisionMap[assessment.decision]++;

    offerAssessments.push({
      uniqueId: offer.uniqueId,
      title: offer.title,
      merchant: offer.merchant?.name || 'Unknown',
      decision: assessment.decision,
      category: assessment.category,
      reasons: assessment.reasons,
    });
  }

  const total = input.normalizedOffers.length || 1;
  const qualityCategories = Object.keys(categoryMap) as ExtendedQualityCategory[];
  const categoriesSummary: DryRunQualitySummary['categories'] = {} as any;

  for (const cat of qualityCategories) {
    const ids = categoryMap[cat];
    categoriesSummary[cat] = {
      count: ids.length,
      percentage: Math.round((ids.length / total) * 100),
      sampleIds: ids.slice(0, 10),
    };
  }

  const qualityReport: DryRunQualitySummary = {
    bank: input.bank,
    timestamp,
    categories: categoriesSummary,
    decisions: decisionMap,
    offers: offerAssessments,
  };

  // Helper to hash and write JSON
  const sha256 = (content: string): string =>
    crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  // 1. raw-offers.json
  const rawOffersPath = path.join(exportDir, 'raw-offers.json');
  const rawOffersContent = JSON.stringify(input.rawOffers, null, 2);
  fs.writeFileSync(rawOffersPath, rawOffersContent);

  // 2. normalized-offers.json
  const normalizedOffersPath = path.join(exportDir, 'normalized-offers.json');
  const normalizedOffersContent = JSON.stringify(input.normalizedOffers, null, 2);
  fs.writeFileSync(normalizedOffersPath, normalizedOffersContent);

  // 3. validation-results.json
  const validationResultsPath = path.join(exportDir, 'validation-results.json');
  const validationResultsContent = JSON.stringify(input.validationReports, null, 2);
  fs.writeFileSync(validationResultsPath, validationResultsContent);

  // 4. quality-report.json
  const qualityReportPath = path.join(exportDir, 'quality-report.json');
  const qualityReportContent = JSON.stringify(qualityReport, null, 2);
  fs.writeFileSync(qualityReportPath, qualityReportContent);

  // 5. errors.json
  const errorsPath = path.join(exportDir, 'errors.json');
  const collectedErrors: DryRunErrorEntry[] = [...(input.errors || [])];
  for (const report of input.validationReports) {
    for (const err of report.ruleValidation.errors) {
      collectedErrors.push({
        phase: 'validate',
        uniqueId: report.offerId,
        field: err.field,
        message: err.message,
      });
    }
  }
  const errorsContent = JSON.stringify(collectedErrors, null, 2);
  fs.writeFileSync(errorsPath, errorsContent);

  // 6. manifest.json
  const manifestPath = path.join(exportDir, 'manifest.json');
  const manifest: DryRunManifest = {
    manifestVersion: '1.0.0',
    bank: input.bank,
    timestamp,
    durationMs: input.durationMs,
    options: input.options || {},
    counts: {
      raw: input.rawOffers.length,
      normalized: input.normalizedOffers.length,
      duplicatesRemoved: input.duplicatesRemoved,
      validHighConfidence: categoryMap.VALID_HIGH_CONFIDENCE.length,
      validWithWarnings: categoryMap.VALID_WITH_WARNINGS.length,
      reviewRequired: categoryMap.REVIEW_REQUIRED.length,
      invalid: categoryMap.INVALID.length,
      duplicateCandidate: categoryMap.DUPLICATE_CANDIDATE.length,
      sourceIncomplete: categoryMap.SOURCE_INCOMPLETE.length,
    },
    artifacts: {
      manifest: 'manifest.json',
      rawOffers: 'raw-offers.json',
      normalizedOffers: 'normalized-offers.json',
      validationResults: 'validation-results.json',
      qualityReport: 'quality-report.json',
      errors: 'errors.json',
    },
    checksums: {
      rawOffers: sha256(rawOffersContent),
      normalizedOffers: sha256(normalizedOffersContent),
      validationResults: sha256(validationResultsContent),
      qualityReport: sha256(qualityReportContent),
      errors: sha256(errorsContent),
    },
    isolation: 'STRICT_NO_DB_MUTATION',
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { exportDir, manifestPath, manifest };
}
