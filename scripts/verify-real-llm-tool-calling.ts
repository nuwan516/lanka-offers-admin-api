import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { runLlmToolCallingSession } from '../src/llm/llm-tool-session';
import { OfferToolExecutor } from '../src/llm/tools/offer-tool-executor';
import { buildOfferEvidenceSnippets } from '../src/parsing/validators/offer-evidence';
import { OfferCorrectionValidator } from '../src/parsing/validators/offer-correction-validator';
import { FullOfferValidationProposalSchema } from '../src/llm/schemas/offer-validation.schema';
import { Offer } from '../src/core/types/offers';

async function runLiveExperiment() {
  console.log('=== PHASE 4: BOUNDED REAL-MODEL LLM TOOL-CALLING EXPERIMENT ===');
  
  const fixturePath = path.resolve(__dirname, '../tests/geo/fixtures/50-offers-gold-standard.json');
  const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  // Select an ambiguous real scraped offer:
  // Item 3: hnb-3 (Centauria Wild Udawalawa) - real multi-branch hotel with complex terms
  const targetItem = fixtureData.offers[2]; // Centauria Wild Udawalawa
  const candidateOffer: Offer = targetItem.offer;
  const evidence = buildOfferEvidenceSnippets(candidateOffer);

  console.log(`Target Offer: [${targetItem.id}] "${candidateOffer.title}" (${targetItem.bank})`);
  console.log(`Merchant: "${candidateOffer.merchant?.name}"`);
  console.log(`Evidence snippets count: ${evidence.length}`);

  const executor = new OfferToolExecutor(candidateOffer, [], {
    maxToolCallsPerAttempt: 5,
    maxToolCallsPerOffer: 15,
  });

  const startTime = Date.now();
  console.log('\nInvoking Live Multi-Turn Tool Calling with DeepSeek…');
  
  const sessionResult = await runLlmToolCallingSession(
    candidateOffer,
    evidence,
    executor,
    1, // attempt 1
    [],
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      timeoutMs: 30000,
    }
  );

  const durationMs = Date.now() - startTime;
  console.log(`\nSession completed in ${durationMs}ms`);
  console.log(`Model: ${sessionResult.model} (${sessionResult.provider})`);
  console.log(`IsRealModelCall: ${sessionResult.isRealModelCall}`);
  console.log(`Billable Requests: ${sessionResult.billableRequests}`);
  console.log(`Tool Calls Executed: ${sessionResult.toolCallsExecuted}`);
  console.log(`Input Tokens: ${sessionResult.inputTokens}, Output Tokens: ${sessionResult.outputTokens}`);
  console.log(`Estimated Cost: $${sessionResult.estimatedCostUsd.toFixed(6)}`);

  console.log('\nTool Execution History:');
  const history = executor.getExecutionHistory();
  history.forEach((h, idx) => {
    console.log(`  [${idx + 1}] Tool: ${h.toolName} (${h.durationMs}ms)`);
    console.log(`      Args: ${JSON.stringify(h.arguments)}`);
    console.log(`      Output: ${JSON.stringify(h.output).slice(0, 150)}...`);
  });

  let zodSuccess = false;
  let acceptedCorrections: any[] = [];
  let rejectedCorrections: any[] = [];

  if (sessionResult.proposal) {
    console.log('\nProposal Received:');
    console.log(`  Status: ${sessionResult.proposal.qualityGate?.status}`);
    console.log(`  Score: ${sessionResult.proposal.qualityGate?.overallScore}`);
    console.log(`  Reasons: ${(sessionResult.proposal.qualityGate?.reasons || []).join('; ')}`);
    console.log(`  Corrections Proposed: ${sessionResult.proposal.corrections?.length || 0}`);

    const zodCheck = FullOfferValidationProposalSchema.safeParse(sessionResult.proposal);
    zodSuccess = zodCheck.success;
    console.log(`  Zod Schema Validation: ${zodSuccess ? 'PASSED' : 'FAILED'}`);

    if (zodCheck.success) {
      const patchValidator = new OfferCorrectionValidator();
      const filterRes = patchValidator.filterProposals(
        zodCheck.data.corrections,
        candidateOffer,
        evidence,
        null
      );
      acceptedCorrections = filterRes.accepted;
      rejectedCorrections = filterRes.rejected;

      console.log(`  Accepted Corrections: ${acceptedCorrections.length}`);
      console.log(`  Rejected Corrections: ${rejectedCorrections.length}`);
      rejectedCorrections.forEach((r) => {
        console.log(`    - Rejected ${r.proposal.fieldPath}: ${r.reason}`);
      });
    }
  } else {
    console.log('\nNo structured proposal returned. Error / Raw output:', sessionResult.error || sessionResult.rawResponseText);
  }

  const telemetryArtifact = {
    timestamp: new Date().toISOString(),
    offerId: candidateOffer.uniqueId,
    bank: targetItem.bank,
    merchantName: candidateOffer.merchant?.name,
    title: candidateOffer.title,
    provider: sessionResult.provider,
    model: sessionResult.model,
    isRealModelCall: sessionResult.isRealModelCall,
    billableRequests: sessionResult.billableRequests,
    toolCallsExecuted: sessionResult.toolCallsExecuted,
    inputTokens: sessionResult.inputTokens,
    outputTokens: sessionResult.outputTokens,
    totalTokens: sessionResult.totalTokensUsed,
    wallClockTimeMs: sessionResult.wallClockTimeMs || durationMs,
    estimatedCostUsd: sessionResult.estimatedCostUsd,
    zodValidationPassed: zodSuccess,
    proposalStatus: sessionResult.proposal?.qualityGate?.status ?? null,
    proposalScore: sessionResult.proposal?.qualityGate?.overallScore ?? null,
    reasons: sessionResult.proposal?.qualityGate?.reasons ?? [],
    correctionsProposed: sessionResult.proposal?.corrections?.length ?? 0,
    correctionsAccepted: acceptedCorrections.length,
    correctionsRejected: rejectedCorrections.length,
    acceptedDetails: acceptedCorrections,
    rejectedDetails: rejectedCorrections,
    toolExecutionHistory: history.map(h => ({
      tool: h.toolName,
      arguments: h.arguments,
      durationMs: h.durationMs,
      error: h.error,
    })),
  };

  const outDir = path.resolve(__dirname, '../../reports/pipeline-acceptance');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'provider-telemetry.json'),
    JSON.stringify(telemetryArtifact, null, 2),
    'utf8'
  );

  console.log(`\nTelemetry exported successfully to ${path.join(outDir, 'provider-telemetry.json')}`);
}

runLiveExperiment().catch(console.error);
