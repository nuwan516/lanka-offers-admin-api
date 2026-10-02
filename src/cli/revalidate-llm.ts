#!/usr/bin/env ts-node
/**
 * Re-run LLM validation for report entries that previously failed open with
 * LLM_VALIDATION_FAILED (transient network faults), patching the existing
 * validation report in place.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/revalidate-llm.ts --bank=hnb
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { LlmValidator } from '@/parsing/validators/llm-validator';
import { ValidationPipeline } from '@/parsing/validators/validation-pipeline';
import { Offer } from '@/core/types/offers';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function main() {
  const bank = arg('bank', 'hnb');
  const outputDir = arg('output', './output');
  const allPath = path.join(outputDir, `${bank}_all.json`);
  const reportPath = path.join(outputDir, `${bank}_validation.json`);

  const all = JSON.parse(fs.readFileSync(allPath, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const offersById = new Map<string, Offer>(all.offers.map((o: Offer) => [o.uniqueId, o]));

  const pipeline = new ValidationPipeline({
    llmValidator: new LlmValidator({ timeoutMs: 30_000 }),
    forceLlm: true,
    minimumLlmScore: 70,
  });

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
  console.log(`done: ${fixed} revalidated, ${stillFailed} still failing → ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
