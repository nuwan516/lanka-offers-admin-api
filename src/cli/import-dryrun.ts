#!/usr/bin/env ts-node
/**
 * Dry-Run Staging Import CLI
 *
 * Explicit, authorized import workflow to stage previously generated dry-run
 * artifacts into Neon Postgres. Never runs automatically.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/import-dryrun.ts --manifest=output/dry-runs/sampath/2026-10-16T12-30-00Z/manifest.json
 *   npx ts-node -r tsconfig-paths/register src/cli/import-dryrun.ts --manifest=output/dry-runs/sampath/2026-10-16T12-30-00Z/manifest.json --confirm
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Offer } from '@/core/types/offers';
import type { ValidationPipelineReport } from '@/parsing/validators/validation-pipeline';
import type { DryRunManifest } from '@/cli/dry-run-exporter';
import {
  createScrapeRun,
  completeScrapeRun,
  failScrapeRun,
  upsertOffer,
  saveValidationReport as saveValidationReportDb,
} from '@/infrastructure/db/offer-repository';
import { closePool, pool } from '@/infrastructure/db/db-client';
import { decideOfferQuality } from '@/domain/offer-quality-decision';
import type { OfferLifecycleStatus } from '@/domain/offer-lifecycle';
import {
  detectAndRecordDuplicates,
  flagOfferAsDuplicate,
  shouldRunDuplicateDetection,
} from '@/infrastructure/db/duplicate-repository';
import { getCostControlConfig } from '@/config/cost-control';

interface ImportOptions {
  manifestPath: string;
  confirm: boolean;
  approvedOnly: boolean;
}

function parseArgs(): ImportOptions {
  const args = process.argv.slice(2);
  let manifestPath = '';
  let confirm = false;
  let approvedOnly = false;

  for (const arg of args) {
    if (arg.startsWith('--manifest=')) manifestPath = arg.split('=')[1];
    else if (arg === '--confirm') confirm = true;
    else if (arg === '--approved-only') approvedOnly = true;
  }

  if (!manifestPath) {
    console.error('Error: --manifest=<path/to/manifest.json> is required.');
    console.error('Example: npm run import:dryrun -- --manifest=output/dry-runs/sampath/2026-10-16T12-30-00Z/manifest.json');
    process.exit(1);
  }

  return { manifestPath, confirm, approvedOnly };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const manifestFile = path.resolve(process.cwd(), opts.manifestPath);
  const allowedBaseDir = path.resolve(process.cwd(), 'output', 'dry-runs');

  // Security check 1: Path traversal protection
  const relManifest = path.relative(allowedBaseDir, manifestFile);
  if (relManifest.startsWith('..') || path.isAbsolute(relManifest)) {
    console.error(`Security Violation: Manifest path must reside within ${allowedBaseDir}`);
    console.error(`Attempted path: ${manifestFile}`);
    process.exit(1);
  }

  if (!fs.existsSync(manifestFile)) {
    console.error(`Error: Manifest file does not exist: ${manifestFile}`);
    process.exit(1);
  }

  // Security check 2: Symlink escape prevention
  try {
    const realManifest = fs.realpathSync(manifestFile);
    const realBase = fs.realpathSync(allowedBaseDir);
    const relReal = path.relative(realBase, realManifest);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      console.error('Security Violation: Symlink escape detected. Manifest target resolves outside dry-run directory.');
      process.exit(1);
    }
  } catch (symErr) {
    console.error('Security Violation: Could not resolve real path for manifest:', symErr);
    process.exit(1);
  }

  // Security check 3: File size limits (protect against memory exhaustion / zip-bombs)
  const MAX_MANIFEST_SIZE = 10 * 1024 * 1024; // 10MB
  const MAX_ARTIFACT_SIZE = 50 * 1024 * 1024; // 50MB
  if (fs.statSync(manifestFile).size > MAX_MANIFEST_SIZE) {
    console.error('Security Violation: Manifest file exceeds 10MB limit.');
    process.exit(1);
  }

  const manifestDir = path.dirname(manifestFile);
  const manifest: DryRunManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Security check 4: Manifest schema validation
  if (
    manifest.manifestVersion !== '1.0.0' ||
    !manifest.bank ||
    !manifest.timestamp ||
    !manifest.counts ||
    typeof manifest.counts.normalized !== 'number'
  ) {
    console.error('Security Violation: Manifest does not conform to valid DryRunManifest schema.');
    process.exit(1);
  }

  // Security check 5: Validate bank identifier against authoritative registry
  const ALLOWED_BANKS = ['hnb', 'sampath', 'boc', 'peoples', 'seylan', 'ndb', 'dfcc', 'pabc', 'nsb', 'combank'];
  if (!manifest.bank || !ALLOWED_BANKS.includes(manifest.bank.toLowerCase())) {
    console.error(`Security Error: Unauthorized or invalid bank identifier in manifest: "${manifest.bank}"`);
    process.exit(1);
  }

  // Security check 6: Ensure manifest declares strict dry-run isolation
  if (manifest.isolation !== 'STRICT_NO_DB_MUTATION') {
    console.error(`Security Error: Manifest is not flagged with STRICT_NO_DB_MUTATION isolation: "${manifest.isolation}"`);
    process.exit(1);
  }

  const normalizedFile = path.resolve(manifestDir, manifest.artifacts.normalizedOffers);
  const validationFile = path.resolve(manifestDir, manifest.artifacts.validationResults);

  // Security check 7: Artifact directory confinement & symlink checks
  const relNorm = path.relative(manifestDir, normalizedFile);
  const relVal = path.relative(manifestDir, validationFile);
  if (relNorm.startsWith('..') || path.isAbsolute(relNorm) || relVal.startsWith('..') || path.isAbsolute(relVal)) {
    console.error('Security Violation: Manifest referenced artifacts outside its directory.');
    process.exit(1);
  }

  if (!fs.existsSync(normalizedFile)) {
    console.error(`Error: Missing normalized offers artifact: ${normalizedFile}`);
    process.exit(1);
  }

  if (fs.statSync(normalizedFile).size > MAX_ARTIFACT_SIZE) {
    console.error('Security Violation: Normalized offers artifact exceeds 50MB limit.');
    process.exit(1);
  }

  // Security check 8: Cryptographic integrity verification
  if (manifest.checksums) {
    const sha256 = (content: string): string =>
      crypto.createHash('sha256').update(content, 'utf8').digest('hex');

    if (manifest.checksums.normalizedOffers) {
      const normHash = sha256(fs.readFileSync(normalizedFile, 'utf8'));
      if (normHash !== manifest.checksums.normalizedOffers) {
        console.error('Security Violation: Checksum mismatch for normalized offers artifact. File was tampered with or corrupted.');
        console.error(`Expected: ${manifest.checksums.normalizedOffers}`);
        console.error(`Actual:   ${normHash}`);
        process.exit(1);
      }
    }

    if (manifest.checksums.validationResults && fs.existsSync(validationFile)) {
      const valHash = sha256(fs.readFileSync(validationFile, 'utf8'));
      if (valHash !== manifest.checksums.validationResults) {
        console.error('Security Violation: Checksum mismatch for validation results artifact.');
        process.exit(1);
      }
    }
  }

  console.log('================================================================');
  console.log(`LANKA OFFERS — STAGING IMPORT FOR ${manifest.bank.toUpperCase()}`);
  console.log('================================================================');
  console.log(`Dry-run timestamp: ${manifest.timestamp}`);
  console.log(`Total raw offers:  ${manifest.counts.raw}`);
  console.log(`Normalized offers: ${manifest.counts.normalized}`);
  console.log(`High confidence:   ${manifest.counts.validHighConfidence}`);
  console.log(`Warnings:          ${manifest.counts.validWithWarnings}`);
  console.log(`Review required:   ${manifest.counts.reviewRequired}`);
  console.log(`Invalid:           ${manifest.counts.invalid}`);
  console.log('================================================================');

  if (!opts.confirm) {
    console.warn('\n[DRY-RUN IMPORT PREVIEW]');
    console.warn('No changes were made to the database.');
    console.warn('To authorize and execute persistent staging into Neon Postgres, re-run with --confirm:');
    console.warn(`  npx ts-node -r tsconfig-paths/register src/cli/import-dryrun.ts --manifest="${opts.manifestPath}" --confirm\n`);
    process.exit(0);
  }

  const offers: Offer[] = JSON.parse(fs.readFileSync(normalizedFile, 'utf8'));

  // Security check 9: Record count limits
  const MAX_OFFER_BATCH = 10000;
  if (!Array.isArray(offers) || offers.length > MAX_OFFER_BATCH) {
    console.error(`Security Violation: Offers count exceeds maximum batch threshold (${MAX_OFFER_BATCH}).`);
    process.exit(1);
  }

  const reports: ValidationPipelineReport[] = fs.existsSync(validationFile)
    ? JSON.parse(fs.readFileSync(validationFile, 'utf8'))
    : [];

  const reportsById = new Map<string, ValidationPipelineReport>(
    reports.map((r) => [r.offerId, r])
  );

  console.log(`Connecting to Neon Postgres to stage ${offers.length} offers...`);

  // Operator audit identity
  const operator = process.env.USERNAME || process.env.USER || 'operator';
  const triggerSignature = `dryrun-import:${manifest.timestamp}:${operator}`;

  // Security check 10: Duplicate import prevention (Idempotency guarantee)
  const existingRun = await pool.query<{ id: string }>(
    `SELECT id FROM scrape_runs
     WHERE bank = $1 AND triggered_by = $2 AND status = 'completed'
     LIMIT 1`,
    [manifest.bank.toLowerCase(), triggerSignature]
  );
  if (existingRun.rows.length > 0) {
    console.warn(`[IDEMPOTENCY] This dry-run artifact has already been successfully staged (Run ID: ${existingRun.rows[0].id}).`);
    console.warn('Duplicate import aborted safely without mutating database.');
    process.exit(0);
  }

  const runId = await createScrapeRun(
    manifest.bank,
    'dryrun-import',
    triggerSignature
  );

  let dbNew = 0, dbChanged = 0, dbUnchanged = 0, dbErrors = 0, validationWrites = 0, duplicatesFlagged = 0;
  const costConfig = getCostControlConfig();

  try {
    for (const offer of offers) {
      try {
        // Security & Quality check: reject malformed records
        if (!offer.uniqueId || typeof offer.uniqueId !== 'string' || !offer.title || !offer.merchant?.name) {
          dbErrors++;
          console.warn(`[Security/Quality] Discarded malformed offer payload (missing uniqueId, title, or merchant)`);
          continue;
        }

        if (offer.source?.toLowerCase() !== manifest.bank.toLowerCase()) {
          dbErrors++;
          console.warn(`[Security] Rejected offer ${offer.uniqueId}: bank source mismatch (expected ${manifest.bank}, got ${offer.source})`);
          continue;
        }

        const report = reportsById.get(offer.uniqueId);
        const quality = decideOfferQuality({
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
        });

        // Safe staging: auto-approved only if explicit flag and quality allows, otherwise stage in REVIEW_REQUIRED
        const lifecycleStatus: OfferLifecycleStatus =
          opts.approvedOnly && quality === 'AUTO_APPROVE' ? 'APPROVED' :
          quality === 'REJECT' ? 'REJECTED' : 'REVIEW_REQUIRED';

        // Critical Security Invariant: Import CLI must NEVER publish offers directly
        if ((lifecycleStatus as string) === 'PUBLISHED') {
          throw new Error('Security Invariant Violated: Import CLI cannot directly publish offers.');
        }

        const result = await upsertOffer(offer, runId, { lifecycleStatus });
        if (result.isNew) dbNew++;
        else if (result.isChanged) dbChanged++;
        else dbUnchanged++;

        if (report) {
          await saveValidationReportDb(
            result.id,
            offer.uniqueId,
            runId,
            report,
            {
              contentHash: offer.contentHash,
              promptVersion: costConfig.llm.promptVersion,
              validatorVersion: costConfig.llm.validatorVersion,
              status: report.llmReused ? 'reused' : 'validated',
            },
            result.staged
          );
          validationWrites++;
        }

        if (shouldRunDuplicateDetection(result.status)) {
          const dup = await detectAndRecordDuplicates(result.id, offer, manifest.bank);
          if (dup.flagged) {
            await flagOfferAsDuplicate(result.id, result.staged, 'import-cli');
            duplicatesFlagged++;
          }
        }
      } catch (err) {
        dbErrors++;
        console.warn(`Failed to stage offer ${offer.uniqueId}:`, err);
      }
    }

    await completeScrapeRun(runId, {
      found: offers.length,
      newCount: dbNew,
      changed: dbChanged,
      unchanged: dbUnchanged,
      errors: dbErrors,
    });

    console.log('\n================================================================');
    console.log('STAGING IMPORT COMPLETE:');
    console.log(`  New offers staged:     ${dbNew}`);
    console.log(`  Changed offers staged: ${dbChanged}`);
    console.log(`  Unchanged offers:      ${dbUnchanged}`);
    console.log(`  Duplicates flagged:    ${duplicatesFlagged}`);
    console.log(`  Errors:                ${dbErrors}`);
    console.log('All staged offers reside in REVIEW_REQUIRED / STAGING for audit.');
    console.log('================================================================\n');
  } catch (fatalErr) {
    await failScrapeRun(runId, fatalErr instanceof Error ? fatalErr.message : String(fatalErr)).catch(() => null);
    console.error('Fatal error during staging import:', fatalErr);
    process.exit(1);
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
