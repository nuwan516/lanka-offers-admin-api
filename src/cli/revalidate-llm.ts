#!/usr/bin/env ts-node
/**
 * Re-run LLM validation for report entries that previously failed open with
 * LLM_VALIDATION_FAILED (transient network faults), patching the existing
 * validation report in place.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/revalidate-llm.ts --bank=hnb
 *   npx ts-node -r tsconfig-paths/register src/cli/revalidate-llm.ts --bank=all
 *   npx ts-node -r tsconfig-paths/register src/cli/revalidate-llm.ts --bank=hnb,boc
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { LlmValidator } from '@/parsing/validators/llm-validator';
import { ValidationPipeline } from '@/parsing/validators/validation-pipeline';
import { Offer } from '@/core/types/offers';
import { resolveBankArgFromArgv } from '@/cli/bank-arg';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function revalidateBank(
  bank: string,
  outputDir: string,
  pipeline: ValidationPipeline
): Promise<{ bank: string; fixed: number; stillFailed: number; skipped: boolean }> {
  const allPath = path.join(outputDir, `${bank}_all.json`);
  const reportPath = path.join(outputDir, `${bank}_validation.json`);

  if (!fs.existsSync(allPath) || !fs.existsSync(reportPath)) {
    console.log(`${bank}: skipped (missing ${path.basename(allPath)} or ${path.basename(reportPath)})`);
    return { bank, fixed: 0, stillFailed: 0, skipped: true };
  }

  const all = JSON.parse(fs.readFileSync(allPath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const offersById = new Map<string, Offer>(all.offers.map((o: Offer) => [o.uniqueId, o]));

  const targets = report.reports.filter(
    (r: { llmValidation?: { issues?: string[] } }) =>
      r.llmValidation?.issues?.includes('LLM_VALIDATION_FAILED'),
  );
  console.log(`${bank}: ${targets.length} offers to revalidate`);

  let fixed = 0;
  let stillFailed = 0;
  for (const rep of targets) {
    const offer = offersById.get(rep.offerId);
    if (!offer) {
      console.log(`  missing offer ${rep.offerId} — skipped`);
      continue;
    }
    const fresh = await pipeline.validateOffer(offer);
    if (fresh.llmValidation && !fresh.llmValidation.issues.includes('LLM_VALIDATION_FAILED')) {
      Object.assign(rep, fresh);
      fixed++;
      console.log(`  ${rep.offerId}: score ${fresh.llmValidation.extractionScore}, passed=${fresh.passed}`);
    } else {
      stillFailed++;
      console.log(`  ${rep.offerId}: STILL FAILING`);
    }
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`${bank}: done — ${fixed} revalidated, ${stillFailed} still failing → ${reportPath}`);
  return { bank, fixed, stillFailed, skipped: false };
}

async function main() {
  const banks = resolveBankArgFromArgv(process.argv.slice(2), {
    capability: 'llmValidation',
    fallback: 'hnb',
  });
  const outputDir = arg('output', './output');

  const pipeline = new ValidationPipeline({
    llmValidator: new LlmValidator({ timeoutMs: 30_000 }),
    forceLlm: true,
    minimumLlmScore: 70,
  });

  console.log(`LLM revalidate banks: ${banks.join(', ')}`);
  let fixed = 0;
  let stillFailed = 0;
  let skipped = 0;

  for (const bank of banks) {
    const summary = await revalidateBank(bank, outputDir, pipeline);
    if (summary.skipped) skipped++;
    fixed += summary.fixed;
    stillFailed += summary.stillFailed;
  }

  console.log(
    `all done: ${fixed} revalidated, ${stillFailed} still failing, ${skipped} bank(s) skipped`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
