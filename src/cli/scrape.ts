#!/usr/bin/env ts-node
/**
 * Scrape CLI
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/scrape.ts --bank=hnb
 *   npx ts-node -r tsconfig-paths/register src/cli/scrape.ts --bank=sampath --skip-details
 *   npx ts-node -r tsconfig-paths/register src/cli/scrape.ts --bank=all
 *   npx ts-node -r tsconfig-paths/register src/cli/scrape.ts --bank=hnb --no-validate
 *
 * Options:
 *   --bank=<name>       Bank to scrape: hnb | sampath | boc | peoples | ndb | seylan | dfcc | pabc | nsb | combank | all
 *   --cache             Enable HTTP response cache (default: false)
 *   --skip-details      Skip detail page fetching for Sampath (faster)
 *   --no-validate       Skip rule-based validation
 *   --llm               Run LLM-based semantic validation (OpenAI/Gemini/DeepSeek)
 *   --output=<dir>      Output directory (default: ./output)
 *   --concurrency=<n>   Parallel detail requests (default: 5)
 *   --max-categories=<n> Smoke-test only the first N categories
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { HttpClient } from '@/infrastructure/http/http-client';
import { FileCache } from '@/infrastructure/cache/file-cache';
import { Logger } from '@/infrastructure/logger/logger';
import { HNBScraper } from '@/banks/hnb/hnb-scraper';
import { SampathScraper } from '@/banks/sampath/sampath-scraper';
import { BOCScraper } from '@/banks/boc/boc-scraper';
import { PeoplesScraper } from '@/banks/peoples/peoples-scraper';
import { NDBScraper } from '@/banks/ndb/ndb-scraper';
import { SeylanScraper } from '@/banks/seylan/seylan-scraper';
import { DFCCScraper } from '@/banks/dfcc/dfcc-scraper';
import { PABCScraper } from '@/banks/pabc/pabc-scraper';
import { NSBScraper } from '@/banks/nsb/nsb-scraper';
import { ComBankScraper } from '@/banks/combank/combank-scraper';
import { LlmValidator } from '@/parsing/validators/llm-validator';
import { ValidationPipeline, ValidationPipelineReport } from '@/parsing/validators/validation-pipeline';
import { buildReusableLlmValidation } from '@/parsing/validators/llm-reuse';
import { Offer } from '@/core/types/offers';
import type { LlmValidationResult } from '@/core/types/validation';
import { BaseScraper, ScraperConfig } from '@/banks/base-scraper';
import { BankName, getBankConfig, listBanksByCapability } from '@/config/banks';
import { dedupeOffers, computeOfferContentHash } from '@/parsing/normalization/offer-normalizer';
import { BrowserClient } from '@/infrastructure/browser/browser-client';
import {
  createScrapeRun, completeScrapeRun, failScrapeRun, upsertOffer,
  saveValidationReport as saveValidationReportDb, getLlmFingerprints,
} from '@/infrastructure/db/offer-repository';
import { closePool } from '@/infrastructure/db/db-client';
import { preloadBankRules } from '@/banks/bank-rules-loader';
import { getCostControlConfig, formatSafePolicySummary } from '@/config/cost-control';
import { decideOfferQuality } from '@/domain/offer-quality-decision';
import type { OfferLifecycleStatus } from '@/domain/offer-lifecycle';
import { detectAndRecordDuplicates, flagOfferAsDuplicate, shouldRunDuplicateDetection } from '@/infrastructure/db/duplicate-repository';

// ─── CLI arg parsing ────────────────────────────────────────────────────────────

interface CliOptions {
  bank: BankName | 'all';
  cache: boolean;
  skipDetails: boolean;
  validate: boolean;
  llm: boolean;
  output: string;
  concurrency: number;
  maxCategories?: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    bank: 'hnb',
    cache: false,
    skipDetails: false,
    validate: true,
    llm: false,
    output: './output',
    concurrency: 5,
  };

  for (const arg of args) {
    if (arg.startsWith('--bank=')) opts.bank = arg.split('=')[1] as BankName | 'all';
    else if (arg === '--cache') opts.cache = true;
    else if (arg === '--skip-details') opts.skipDetails = true;
    else if (arg === '--no-validate') opts.validate = false;
    else if (arg === '--llm') opts.llm = true;
    else if (arg.startsWith('--output=')) opts.output = arg.split('=')[1];
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--max-categories=')) opts.maxCategories = parseInt(arg.split('=')[1], 10);
  }

  if (opts.bank !== 'all') {
    getBankConfig(opts.bank);
  }

  return opts;
}

// ─── Scraper factory ────────────────────────────────────────────────────────────

function createScraper(
  bankName: BankName,
  config: ScraperConfig & { skipDetails?: boolean },
): BaseScraper {
  switch (bankName) {
    case 'hnb': return new HNBScraper(config);
    case 'sampath': return new SampathScraper({ ...config, skipDetails: config.skipDetails });
    case 'boc': return new BOCScraper(config);
    case 'peoples': return new PeoplesScraper(config);
    case 'ndb': return new NDBScraper(config);
    case 'seylan': return new SeylanScraper(config);
    case 'dfcc': return new DFCCScraper(config);
    case 'pabc': return new PABCScraper(config);
    case 'nsb': return new NSBScraper(config);
    case 'combank': return new ComBankScraper(config);
    default: throw new Error(`Unknown bank: ${bankName}`);
  }
}

// ─── Output ─────────────────────────────────────────────────────────────────────

function saveOutput(bankName: string, offers: Offer[], outputDir: string): string {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${bankName}_all.json`);
  const output = {
    metadata: {
      bank: bankName,
      scrapedAt: new Date().toISOString(),
      totalOffers: offers.length,
    },
    offers,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  return outPath;
}

function saveValidationReport(bankName: string, reports: ValidationPipelineReport[], outputDir: string): string {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${bankName}_validation.json`);
  const output = {
    metadata: {
      bank: bankName,
      validatedAt: new Date().toISOString(),
      totalOffers: reports.length,
      passed: reports.filter((report) => report.passed).length,
      failed: reports.filter((report) => !report.passed).length,
      llmCompared: reports.filter((report) => report.llmValidation?.rawCompared).length,
    },
    reports,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  return outPath;
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function scrapeBank(bankName: BankName, opts: CliOptions): Promise<void> {
  const logger = new Logger(bankName);
  const bankConfig = getBankConfig(bankName);

  if (!bankConfig.capabilities.scrape) {
    logger.warn(
      'CLI',
      `${bankConfig.displayName} scraper is registered from base repo metadata but not implemented in TypeScript yet.`,
      {
        sourceType: bankConfig.sourceType,
        activeBaseScript: bankConfig.activeBaseScript,
        categories: bankConfig.categories.length,
      },
    );
    return;
  }

  if (bankConfig.sourceType === 'headless-browser' && !BrowserClient.isAvailable()) {
    throw new Error(`${bankConfig.displayName} requires a browser runtime. Run: npm run browser:install`);
  }

  const cache = opts.cache
    ? new FileCache(`./cache_${bankName}`, 24 * 60 * 60 * 1000)
    : undefined;

  const http = new HttpClient({
    timeout: 15_000,
    retries: 3,
    retryDelay: 1_000,
    cache,
  });

  const config: ScraperConfig & { skipDetails?: boolean } = {
    http,
    logger,
    concurrency: opts.concurrency,
    categoryConcurrency: 1,
    maxCategories: opts.maxCategories,
    skipDetails: opts.skipDetails,
  };

  const scraper = createScraper(bankName, config);

  logger.info('CLI', `Starting scraper for ${bankName.toUpperCase()}`);

  // Create DB record for this run
  const runId = await createScrapeRun(bankName, opts.cache ? 'cached' : 'full', 'cli').catch(() => null);

  // Load DB parser rules into module cache so parsers can use them synchronously
  await preloadBankRules(bankName).catch(() => null);

  const scrapeTimer = logger.timer('Scraper', `${bankName} scrape`);
  let offers: Offer[];
  try {
    offers = await scraper.scrape();
    scrapeTimer.done({ offers: offers.length });
  } catch (err) {
    scrapeTimer.fail(err);
    if (runId) await failScrapeRun(runId, err instanceof Error ? err.message : String(err)).catch(() => null);
    throw err;
  }

  const deduped = dedupeOffers(offers);
  if (deduped.duplicatesRemoved > 0) {
    logger.warn('Normalize', `Removed ${deduped.duplicatesRemoved} duplicate offers before validation/export`, {
      duplicateIds: deduped.duplicateIds.slice(0, 10),
    });
    offers = deduped.offers;
  }

  // Canonical business-content hash, computed centrally so every bank
  // parser's ad-hoc hash gets normalized to the same shared definition
  // before it's used for DB change-detection or LLM fingerprinting.
  for (const offer of offers) {
    offer.contentHash = computeOfferContentHash(offer);
  }

  const costConfig = getCostControlConfig();
  const reportsById = new Map<string, ValidationPipelineReport>();

  if (opts.validate && offers.length > 0) {
    const llmEnabled = opts.llm && costConfig.llm.validationEnabled;
    if (opts.llm && !costConfig.llm.validationEnabled) {
      logger.warn('LLM', 'LLM validation skipped: LLM_VALIDATION_ENABLED=false (kill switch).');
    }
    const llmValidator = llmEnabled ? new LlmValidator() : undefined;
    if (llmEnabled && !llmValidator?.isAvailable) {
      logger.warn('LLM', `LLM validation skipped: no API key found for primary provider "${costConfig.llm.primaryProvider}".`);
    }

    // Zero-cost control: batch-load existing LLM fingerprints for this bank
    // so unchanged offers reuse their prior validation instead of re-calling
    // the LLM. See getReusableLlmValidation() below.
    const fingerprints: Awaited<ReturnType<typeof getLlmFingerprints>> = llmValidator?.isAvailable
      ? await getLlmFingerprints(bankName).catch(() => new Map())
      : new Map();

    const getReusableLlmValidation = (offer: Offer): LlmValidationResult | null =>
      llmValidator?.providerName
        ? buildReusableLlmValidation(fingerprints.get(offer.uniqueId), offer, {
            promptVersion: costConfig.llm.promptVersion,
            validatorVersion: costConfig.llm.validatorVersion,
            provider: llmValidator.providerName,
          })
        : null;

    const pipeline = new ValidationPipeline({
      llmValidator,
      forceLlm: llmEnabled,
      sampleRate: llmEnabled ? 100 : 0,
      minimumLlmScore: 70,
      getReusableLlmValidation,
    });

    logger.info('Validator', `Running validation pipeline${llmEnabled ? ' with LLM full-offer comparison' : ''}`);
    const reports = await pipeline.validateBatch(offers);
    for (const report of reports) reportsById.set(report.offerId, report);
    const offersById = new Map(offers.map((offer) => [offer.uniqueId, offer]));
    const failedReports = reports.filter((report) => !report.passed);
    const reportsWithWarnings = reports.filter((report) => report.ruleValidation.warnings.length > 0);
    const llmReports = reports.filter((report) => report.llmValidation);
    const llmReusedReports = llmReports.filter((report) => report.llmReused);

    for (const report of failedReports.slice(0, 10)) {
      for (const e of report.ruleValidation.errors) {
        logger.error('Validator', `[${report.offerId}] ${e.field}: ${e.message}`);
      }
      if (report.llmValidation && !report.llmValidation.isValidOffer) {
        logger.error('LLM', `[${report.offerId}] Rejected: ${report.llmValidation.reasoning}`);
      }
      if (report.llmValidation && report.llmValidation.extractionScore < 70) {
        logger.warn('LLM', `[${report.offerId}] Low score ${report.llmValidation.extractionScore}/100: ${report.llmValidation.reasoning}`);
      }
    }

    for (const report of reportsWithWarnings.slice(0, 10)) {
      for (const w of report.ruleValidation.warnings) {
        logger.warn('Validator', `[${report.offerId}] ${w.field}: ${w.message}`);
      }
    }

    for (const report of llmReports.slice(0, 10)) {
      const res = report.llmValidation!;
      logger.info('LLM', `[${report.offerId}] Score ${res.extractionScore}/100 | confidence ${res.confidence} | issues ${res.issues.length}`);
      const offer = offersById.get(report.offerId);
      if (offer && res.inferredCategory && res.inferredCategory !== offer.category) {
        logger.debug('LLM', `[${report.offerId}] Inferred category: ${offer.category} -> ${res.inferredCategory}`);
      }
    }

    // Fail-open LLM calls are "unvalidated", not "passed" — surface them so a
    // clean-looking run can't hide a broken validation stage.
    const llmUnvalidated = llmReports.filter((r) => r.llmValidation!.issues.includes('LLM_VALIDATION_FAILED'));
    if (llmUnvalidated.length > 0) {
      logger.warn('LLM', `${llmUnvalidated.length}/${llmReports.length} offers UNVALIDATED (LLM call failed after retries) — passed only by fail-open policy`);
    }

    const reportPath = saveValidationReport(bankName, reports, opts.output);
    logger.success(
      'Validator',
      `Validation complete. Passed ${reports.length - failedReports.length}/${reports.length}; ` +
      `LLM validated ${llmReports.length - llmUnvalidated.length - llmReusedReports.length}, ` +
      `reused ${llmReusedReports.length}, unvalidated ${llmUnvalidated.length}. Report → ${reportPath}`,
    );
  }

  // Persist offers to Neon Postgres
  if (runId) {
    if (offers.length > 0) {
      logger.info('DB', `Persisting ${offers.length} offers to Neon…`);
      let dbNew = 0, dbChanged = 0, dbUnchanged = 0, dbErrors = 0, validationWrites = 0, duplicatesFlagged = 0;
      for (const offer of offers) {
        try {
          const report = reportsById.get(offer.uniqueId);
          const quality = decideOfferQuality({
            ruleValid: report?.ruleValidation.valid ?? true,
            ruleErrorCount: report?.ruleValidation.errors.length ?? 0,
            ruleWarningCount: report?.ruleValidation.warnings.length ?? 0,
            llmScore: report?.llmValidation?.extractionScore ?? null,
            llmValid: report?.llmValidation?.isValidOffer ?? null,
            llmStatus: report?.llmValidation?.issues.includes('BUDGET_BLOCKED') ? 'skipped_budget'
              : report?.llmValidation?.issues.includes('LLM_VALIDATION_FAILED') ? 'review_required'
              : report?.llmValidation ? 'validated' : null,
          });
          const lifecycleStatus: OfferLifecycleStatus =
            quality === 'AUTO_APPROVE' ? 'APPROVED' :
            quality === 'REJECT' ? 'REJECTED' : 'REVIEW_REQUIRED';

          const result = await upsertOffer(offer, runId, { lifecycleStatus });
          if (result.isNew) dbNew++;
          else if (result.isChanged) dbChanged++;
          else dbUnchanged++;

          if (report) {
            // Zero-cost control: skip the validation_reports write (and the
            // offers UPDATE it triggers) when nothing new was actually
            // computed this run — i.e. content didn't change AND the LLM
            // result (if any) was reused rather than freshly called.
            const freshLlmCall = Boolean(report.llmValidation) && !report.llmReused;
            const shouldPersistValidation = result.status !== 'UNCHANGED' || freshLlmCall;
            if (shouldPersistValidation) {
              const llmStatus = !report.llmValidation
                ? null
                : report.llmValidation.issues.includes('BUDGET_BLOCKED')
                  ? 'skipped_budget'
                  : report.llmValidation.issues.includes('LLM_VALIDATION_FAILED')
                    ? 'review_required'
                    : report.llmReused ? 'reused' : 'validated';
              await saveValidationReportDb(result.id, offer.uniqueId, runId, report, {
                contentHash: offer.contentHash,
                promptVersion: costConfig.llm.promptVersion,
                validatorVersion: costConfig.llm.validatorVersion,
                status: llmStatus ?? 'not_run',
              }, result.staged);
              validationWrites++;
            }
          }

          // Duplicate detection: deterministic, DB-only, no LLM/geo calls.
          // Only worth running when something actually changed this scrape —
          // an UNCHANGED offer can't have created a new duplicate.
          if (shouldRunDuplicateDetection(result.status)) {
            try {
              const dup = await detectAndRecordDuplicates(result.id, offer, bankName);
              if (dup.flagged) {
                await flagOfferAsDuplicate(result.id, result.staged, 'scrape');
                duplicatesFlagged++;
              }
            } catch (e) {
              logger.warn('Duplicate', `Detection failed for ${offer.uniqueId}: ${e instanceof Error ? e.message : e}`);
            }
          }
        } catch (e) {
          dbErrors++;
          logger.warn('DB', `Failed to upsert offer ${offer.uniqueId}: ${e instanceof Error ? e.message : e}`);
        }
      }
      logger.info('DB', `Validation state written for ${validationWrites}/${offers.length} offers (rest reused unchanged state).`);
      if (duplicatesFlagged > 0) {
        logger.warn('Duplicate', `${duplicatesFlagged} offer(s) flagged as possible duplicates → REVIEW_REQUIRED`);
      }
      const runOutcome = await completeScrapeRun(runId, {
        found: offers.length, newCount: dbNew, changed: dbChanged, unchanged: dbUnchanged, errors: dbErrors,
      }).catch(() => null);
      if (runOutcome?.anomalyWarning) {
        logger.warn('Quality', `Run anomaly detected: ${runOutcome.anomalyWarning}`);
      }
      logger.success('DB', `Persisted: ${dbNew} new, ${dbChanged} changed, ${dbUnchanged} unchanged`);
    } else {
      logger.warn('Scraper', `0 offers extracted for ${bankName.toUpperCase()}`);
      const runOutcome = await completeScrapeRun(runId, {
        found: 0, newCount: 0, changed: 0, unchanged: 0, errors: 0,
      }).catch(() => null);
      if (runOutcome?.anomalyWarning) {
        logger.warn('Quality', `Run anomaly detected: ${runOutcome.anomalyWarning}`);
      }
    }
  }

  const outPath = saveOutput(bankName, offers, opts.output);
  logger.success('Output', `Saved ${offers.length} offers → ${outPath}`);
  logger.summary({
    bank: bankName,
    offers: offers.length,
    validation: opts.validate,
    llmValidation: opts.llm,
    output: outPath,
  });
}

async function main(): Promise<void> {
  const logger = new Logger('CLI');
  logger.info('App', 'Starting Lanka Offers Scraper — TypeScript Framework');
  console.log(formatSafePolicySummary());

  const opts = parseArgs();

  const banks: BankName[] = opts.bank === 'all'
    ? listBanksByCapability('scrape')
    : [opts.bank as BankName];

  logger.info(
    'Config',
    `Banks: ${banks.join(', ')} | Cache: ${opts.cache} | Validate: ${opts.validate} | LLM: ${opts.llm} | ` +
    `Output: ${opts.output}${opts.maxCategories ? ` | Max categories: ${opts.maxCategories}` : ''}`,
  );

  const start = Date.now();

  let failures = 0;

  for (const bankName of banks) {
    const bankConfig = getBankConfig(bankName);
    if (opts.bank === 'all' && bankConfig.sourceType === 'headless-browser' && !BrowserClient.isAvailable()) {
      logger.warn('Config', `Skipping ${bankConfig.displayName}: browser runtime is not available.`);
      continue;
    }

    try {
      await scrapeBank(bankName, opts);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('App', `Error scraping ${bankName}: ${msg}`);
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  if (failures > 0) {
    logger.error('App', `Scraping completed with ${failures} failed bank(s) in ${duration}s`);
    process.exitCode = 1;
    return;
  }

  logger.success('App', `Scraping completed in ${duration}s`);
  await closePool().catch(() => null);
}

main().catch((err) => {
  console.error('\n  ❌ Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
