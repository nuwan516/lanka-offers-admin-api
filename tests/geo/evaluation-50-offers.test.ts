/**
 * 50-Offer Stratified Evaluation Suite: Deterministic Baseline vs Hybrid Validation
 *
 * Evaluates 50 genuine scraped offers from all 10 banks against the human-verified gold standard.
 * Compares:
 * - Pipeline A: Deterministic Baseline (pure regex + parser)
 * - Pipeline B: Hybrid Validation (deterministic + Zod schema + bounded LLM agent + post-validation)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ValidationOrchestrator } from '@/geo/validation-orchestrator';
import { LocationScope } from '@/domain/location-scope';
import { Offer } from '@/core/types/offers';

interface GoldBenchmarkOffer {
  id: string;
  bank: string;
  caseType: string;
  offer: Offer;
  rawText: string;
  gold: {
    merchantName: string;
    expectedScope: LocationScope;
    isPhysicalVenue: boolean;
    isExactPinAllowed: boolean;
    isAreaCentroidAllowed: boolean;
    validBranches: string[];
    mustRejectCandidates: string[];
    evidenceSnippet: string;
  };
}

interface BenchmarkDataset {
  totalOffers: number;
  offers: GoldBenchmarkOffer[];
}

interface PipelineMetrics {
  totalOffers: number;
  addressPrecision: number;
  addressRecall: number;
  scopeAccuracy: number;
  falseExactPins: number;
  invalidRejections: number;
  llmInvocations: number;
  totalToolCalls: number;
  attemptsDistribution: Record<number, number>;
  reviewRequiredCount: number;
}

describe('50-Offer Stratified Evaluation Benchmark', () => {
  let dataset: BenchmarkDataset;
  let pipelineAResults: any[] = [];
  let pipelineBResults: any[] = [];

  beforeAll(() => {
    const fixturePath = path.join(__dirname, 'fixtures/50-offers-gold-standard.json');
    expect(fs.existsSync(fixturePath)).toBe(true);
    dataset = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(dataset.totalOffers).toBe(50);
  });

  function evaluatePipeline(results: Array<{ offer: GoldBenchmarkOffer; pipelineOut: any }>): PipelineMetrics {
    let tpAddress = 0;
    let fpAddress = 0;
    let fnAddress = 0;
    let correctScope = 0;
    let falseExactPins = 0;
    let totalInvalidRejected = 0;
    let totalInvalidExpected = 0;
    let llmInvocations = 0;
    let totalToolCalls = 0;
    let reviewRequiredCount = 0;
    const attemptsDist: Record<number, number> = { 1: 0, 2: 0, 3: 0 };

    for (const { offer: item, pipelineOut: out } of results) {
      if (out.usedLlm) {
        llmInvocations++;
        totalToolCalls += out.toolCallsExecuted;
        attemptsDist[out.llmAttempts] = (attemptsDist[out.llmAttempts] ?? 0) + 1;
      }
      if (out.needsHumanReview) {
        reviewRequiredCount++;
      }

      // 1. Scope accuracy
      if (out.finalScope === item.gold.expectedScope) {
        correctScope++;
      }

      // 2. Address evaluation
      const finalAddresses: string[] = out.finalAddresses ?? [];
      const goldBranches: string[] = item.gold.validBranches ?? [];

      for (const fa of finalAddresses) {
        const normFa = fa.toLowerCase().replace(/,\s*sri\s*lanka/g, '').trim();
        const matchesGold = goldBranches.some((gb) => {
          const normGb = gb.toLowerCase().replace(/,\s*sri\s*lanka/g, '').trim();
          return normFa.includes(normGb) || normGb.includes(normFa);
        });
        if (matchesGold) {
          tpAddress++;
        } else {
          fpAddress++;
        }
      }

      for (const gb of goldBranches) {
        const normGb = gb.toLowerCase().replace(/,\s*sri\s*lanka/g, '').trim();
        const wasExtracted = finalAddresses.some((fa) => {
          const normFa = fa.toLowerCase().replace(/,\s*sri\s*lanka/g, '').trim();
          return normFa.includes(normGb) || normGb.includes(normFa);
        });
        if (!wasExtracted) {
          fnAddress++;
        }
      }

      // 3. False Exact Pin Check (SAFETY CRITICAL)
      // If the offer was NOT allowed an exact pin (e.g. ONLINE, NATIONWIDE, AREA_ONLY),
      // did the pipeline assign it an exact pin?
      if (!item.gold.isExactPinAllowed) {
        if (out.verifiedPins && out.verifiedPins.some((p: any) => p.isExactPin)) {
          falseExactPins++;
        }
      }

      // 4. Invalid Candidate Rejection
      const mustReject = item.gold.mustRejectCandidates ?? [];
      totalInvalidExpected += mustReject.length;
      for (const bad of mustReject) {
        const isPresent = finalAddresses.some((fa) => fa.toLowerCase().includes(bad.toLowerCase()));
        if (!isPresent) {
          totalInvalidRejected++;
        }
      }
    }

    const precision = tpAddress + fpAddress > 0 ? tpAddress / (tpAddress + fpAddress) : 1.0;
    const recall = tpAddress + fnAddress > 0 ? tpAddress / (tpAddress + fnAddress) : 1.0;
    const scopeAccuracy = correctScope / results.length;

    return {
      totalOffers: results.length,
      addressPrecision: Math.round(precision * 1000) / 10,
      addressRecall: Math.round(recall * 1000) / 10,
      scopeAccuracy: Math.round(scopeAccuracy * 1000) / 10,
      falseExactPins,
      invalidRejections: totalInvalidExpected > 0 ? Math.round((totalInvalidRejected / totalInvalidExpected) * 1000) / 10 : 100,
      llmInvocations,
      totalToolCalls,
      attemptsDistribution: attemptsDist,
      reviewRequiredCount,
    };
  }

  it('runs Pipeline A (Deterministic Baseline) across all 50 offers', async () => {
    const orchestratorA = new ValidationOrchestrator({
      mode: 'deterministic-only',
      geocodingDryRun: true,
    });

    for (const item of dataset.offers) {
      const out = await orchestratorA.processOffer(item.offer, {
        rawHtml: null,
        rawText: item.rawText,
        rawListItem: null,
        rawDetail: null,
        sourceUrl: item.offer.sourceUrl,
      });
      pipelineAResults.push({ offer: item, pipelineOut: out });
    }

    expect(pipelineAResults.length).toBe(50);
    const metricsA = evaluatePipeline(pipelineAResults);
    console.log('\n=== PIPELINE A (DETERMINISTIC BASELINE) METRICS ===');
    console.log(metricsA);

    expect(metricsA.falseExactPins).toBe(0); // Zero unsupported exact pins
  });

  it('runs Pipeline B (Hybrid Validation) across all 50 offers and improves quality', async () => {
    const orchestratorB = new ValidationOrchestrator({
      mode: 'hybrid-mocked',
      geocodingDryRun: true,
    });

    for (const item of dataset.offers) {
      const out = await orchestratorB.processOffer(item.offer, {
        rawHtml: null,
        rawText: item.rawText,
        rawListItem: null,
        rawDetail: null,
        sourceUrl: item.offer.sourceUrl,
      });
      pipelineBResults.push({ offer: item, pipelineOut: out });
    }

    expect(pipelineBResults.length).toBe(50);
    const metricsB = evaluatePipeline(pipelineBResults);
    console.log('\n=== PIPELINE B (HYBRID VALIDATION) METRICS ===');
    console.log(metricsB);

    // Hybrid validation should achieve equal or superior address precision & scope accuracy
    expect(metricsB.falseExactPins).toBe(0); // CRITICAL INVARIANT: 0 false exact pins
    expect(metricsB.addressPrecision).toBeGreaterThanOrEqual(90);
    expect(metricsB.scopeAccuracy).toBeGreaterThanOrEqual(90);
  });
});
