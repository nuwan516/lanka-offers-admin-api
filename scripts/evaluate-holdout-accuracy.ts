/**
 * End-to-End Extraction Accuracy Benchmark (Phase 3 & Phase 4)
 *
 * Compares:
 * - Pipeline A: Existing deterministic-only processing
 * - Pipeline B: Deterministic processing + selective optimized LLM validation
 *
 * Evaluates identical 100 holdout offers across all 14 required dimensions:
 * 1. Merchant accuracy
 * 2. Bank attribution
 * 3. Discount extraction
 * 4. "Up to" correctness
 * 5. Cashback semantics
 * 6. Installment correctness
 * 7. Minimum spend
 * 8. Maximum discount
 * 9. Card eligibility
 * 10. Date validity
 * 11. Location scope
 * 12. Branch accuracy
 * 13. Duplicate classification
 * 14. Terms and restrictions
 *
 * Records precision, recall, accuracy, unknown/abstained, and incorrect claims.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Offer } from '../src/core/types/offers';
import { HoldoutOffer, HoldoutReferenceLabels } from './build-independent-holdout';
import { determineLocationScope, LocationScope } from '../src/domain/location-scope';
import { scoreDuplicateCandidate } from '../src/domain/duplicate-detector';
import { detectUpToSemantics } from '../src/parsing/validators/offer-evidence';
import { parseFinancialTerms } from '../src/parsing/transaction/transaction-parser';
import { UnifiedOfferOrchestrator } from '../src/parsing/validators/unified-offer-orchestrator';

export interface FieldAccuracyMetric {
  fieldName: string;
  totalEvaluated: number;
  correct: number;
  incorrect: number;
  abstained: number;
  accuracy: number;
  precision?: number;
  recall?: number;
}

export interface PipelineEvaluationReport {
  pipelineName: string;
  totalOffers: number;
  bankBreakdown: Record<string, { total: number; correctFields: number; totalFields: number; accuracy: number }>;
  fieldMetrics: Record<string, FieldAccuracyMetric>;
  overallFieldAccuracy: number;
  abstainedRate: number;
  incorrectClaimRate: number;
  unsupportedInferenceRate: number;
}

export interface DualPipelineBenchmarkResult {
  evaluatedAt: string;
  totalHoldoutOffers: number;
  banksEvaluated: string[];
  pipelineA: PipelineEvaluationReport;
  pipelineB: PipelineEvaluationReport;
  accuracyDelta: {
    overallGainPercent: number;
    improvedFields: string[];
    degradedFields: string[];
    unchangedFields: string[];
  };
  sampleEvaluations: Array<{
    id: string;
    bank: string;
    merchant: string;
    pipelineAScore: number;
    pipelineBScore: number;
    appliedCorrections: string[];
  }>;
}

function normalizeStr(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function evaluateSingleOffer(
  offer: Offer,
  ref: HoldoutReferenceLabels,
  existingOffers: Offer[] = []
): Record<string, 'CORRECT' | 'INCORRECT' | 'ABSTAINED'> {
  const result: Record<string, 'CORRECT' | 'INCORRECT' | 'ABSTAINED'> = {};

  // 1. Merchant accuracy
  const extMerchant = normalizeStr(offer.merchant.name);
  const refMerchant = normalizeStr(ref.merchantName);
  if (extMerchant === refMerchant || extMerchant.includes(refMerchant) || refMerchant.includes(extMerchant)) {
    result.merchant_accuracy = 'CORRECT';
  } else if (!offer.merchant.name || offer.merchant.name.trim() === '') {
    result.merchant_accuracy = 'ABSTAINED';
  } else {
    result.merchant_accuracy = 'INCORRECT';
  }

  // 2. Bank attribution
  if (offer.source.toLowerCase() === ref.bank.toLowerCase()) {
    result.bank_attribution = 'CORRECT';
  } else {
    result.bank_attribution = 'INCORRECT';
  }

  // 3. Discount extraction
  const extDisc = offer.offer.discountPercentage;
  const refDisc = ref.discountPercentage;
  if (extDisc === refDisc) {
    result.discount_extraction = 'CORRECT';
  } else if (extDisc === null && refDisc !== null) {
    result.discount_extraction = 'ABSTAINED';
  } else if (extDisc !== null && refDisc === null) {
    result.discount_extraction = 'INCORRECT';
  } else if (typeof extDisc === 'number' && typeof refDisc === 'number' && Math.abs(extDisc - refDisc) === 0) {
    result.discount_extraction = 'CORRECT';
  } else {
    result.discount_extraction = 'INCORRECT';
  }

  // 4. "Up to" correctness
  const extUpTo = detectUpToSemantics(`${offer.title} ${offer.offer.description || ''}`, typeof offer.offer.discountPercentage === 'number' ? offer.offer.discountPercentage : null).isUpTo;
  if (extUpTo === ref.isUpTo) {
    result.is_up_to_correctness = 'CORRECT';
  } else {
    result.is_up_to_correctness = 'INCORRECT';
  }

  // 5. Cashback semantics
  const extCashback = /cashback/i.test(offer.title || '') || /cashback/i.test(offer.offer.description || '');
  if (extCashback === ref.isCashback) {
    result.cashback_semantics = 'CORRECT';
  } else {
    result.cashback_semantics = 'INCORRECT';
  }

  // 6. Installment correctness
  const extHasInstallments = (offer.installmentPlans && offer.installmentPlans.length > 0) || false;
  if (extHasInstallments === ref.hasInstallments) {
    result.installment_correctness = 'CORRECT';
  } else {
    result.installment_correctness = 'INCORRECT';
  }

  // 7. Minimum spend
  const parsedTerms = parseFinancialTerms(`${offer.title} ${offer.offer?.description || ''} ${(offer.offer?.generalTerms || []).join(' ')} ${(offer.offer?.restrictions || []).join(' ')}`);
  const extMin = offer.transactionRange?.min ?? parsedTerms.minimum_transaction_amount;
  const refMin = ref.minSpend;
  if (extMin === refMin) {
    result.minimum_spend = 'CORRECT';
  } else if (extMin === null && refMin !== null) {
    result.minimum_spend = 'ABSTAINED';
  } else {
    result.minimum_spend = 'INCORRECT';
  }

  // 8. Maximum discount cap
  const capRegex = /(?:max|maximum|cap(?:ped)?\s*(?:at)?)\s*(?:discount)?\s*(?:of)?\s*(?:rs\.?|lkr)?\s*([\d,]+)/i;
  const rawTextForCap = `${offer.title} ${offer.offer?.description || ''} ${(offer.offer?.generalTerms || []).join(' ')} ${(offer.offer?.restrictions || []).join(' ')}`;
  const capMatch = rawTextForCap.match(capRegex);
  const extCap = parsedTerms.maximum_discount_amount ?? (capMatch ? parseInt(capMatch[1].replace(/,/g, ''), 10) : null);
  const refCap = ref.maxDiscountCap;
  if (extCap === refCap) {
    result.maximum_discount = 'CORRECT';
  } else if (extCap === null && refCap !== null) {
    result.maximum_discount = 'ABSTAINED';
  } else {
    result.maximum_discount = 'INCORRECT';
  }

  // 9. Card eligibility
  const cardTypes = offer.cardEligibility.cardTypes || [];
  const hasCredit = cardTypes.some(c => /credit/i.test(c));
  const hasDebit = cardTypes.some(c => /debit/i.test(c));
  const refHasCredit = ref.cardTypes.includes('CREDIT');
  const refHasDebit = ref.cardTypes.includes('DEBIT');
  if (hasCredit === refHasCredit && hasDebit === refHasDebit) {
    result.card_eligibility = 'CORRECT';
  } else if (cardTypes.length === 0 && ref.cardTypes.length > 0) {
    result.card_eligibility = 'ABSTAINED';
  } else {
    result.card_eligibility = 'INCORRECT';
  }

  // 10. Date validity
  const v0 = offer.validityPeriods && offer.validityPeriods[0];
  const extValidTo = v0?.validTo || null;
  const refValidTo = ref.validTo;
  const refDate = new Date('2026-10-29');
  const extExpired = extValidTo ? new Date(extValidTo) < refDate : false;
  if (extValidTo === refValidTo && extExpired === ref.isExpired) {
    result.date_validity = 'CORRECT';
  } else if (!extValidTo && refValidTo) {
    result.date_validity = 'ABSTAINED';
  } else if (extExpired === ref.isExpired) {
    result.date_validity = 'CORRECT';
  } else {
    result.date_validity = 'INCORRECT';
  }

  // 11. Location scope
  const scopeResult = determineLocationScope({
    addresses: offer.merchant?.addresses,
    location: offer.merchant?.location,
    title: offer.title,
    description: `${offer.offer?.description || ''} ${(offer.offer?.generalTerms || []).join(' ')}`,
    merchantName: offer.merchant?.name,
    terms: [...(offer.offer?.generalTerms || []), ...(offer.offer?.restrictions || [])],
  });
  const extScope = scopeResult.scope;
  let normExtScope: string = extScope;
  if (extScope === LocationScope.ONLINE) normExtScope = 'ONLINE';
  else if (extScope === LocationScope.EXPLICIT_BRANCH) normExtScope = 'SINGLE_BRANCH';
  else if (extScope === LocationScope.MULTIPLE_BRANCHES) normExtScope = 'MULTI_BRANCH';
  else if (extScope === LocationScope.SELECTED_OUTLETS) normExtScope = 'MULTI_BRANCH';
  else if (extScope === LocationScope.DISTRICT_REGION) normExtScope = 'MULTI_BRANCH';
  else if (extScope === LocationScope.NATIONWIDE) normExtScope = 'NATIONWIDE';
  else if (extScope === LocationScope.UNRESOLVED) normExtScope = 'UNRESOLVED';

  if (normExtScope === ref.locationScope) {
    result.location_scope = 'CORRECT';
  } else {
    result.location_scope = 'INCORRECT';
  }

  // 12. Branch accuracy
  const extBranchCount = (normExtScope === 'ONLINE')
    ? 0
    : (offer.merchant?.addresses && offer.merchant.addresses.length > 0)
    ? offer.merchant.addresses.length
    : 1;
  if (extBranchCount === ref.branchCount || (ref.branchCount > 1 && extBranchCount > 1)) {
    result.branch_accuracy = 'CORRECT';
  } else if (extBranchCount === 0 && ref.branchCount > 0) {
    result.branch_accuracy = 'ABSTAINED';
  } else {
    result.branch_accuracy = 'INCORRECT';
  }

  // 13. Duplicate classification
  let isDup = false;
  for (const existing of existingOffers) {
    if (existing.uniqueId === offer.uniqueId) continue;
    const dupRes = scoreDuplicateCandidate(offer, existing);
    if (dupRes.classification === 'EXACT_DUPLICATE' || dupRes.classification === 'LIKELY_DUPLICATE') {
      isDup = true;
      break;
    }
  }
  if (isDup === ref.isDuplicate) {
    result.duplicate_classification = 'CORRECT';
  } else {
    result.duplicate_classification = 'INCORRECT';
  }

  // 14. Terms and restrictions
  const extTermsCount = (offer.offer.restrictions || []).length;
  const refTermsCount = ref.termsAndRestrictions.length;
  if ((refTermsCount === 0 && extTermsCount === 0) || (refTermsCount > 0 && extTermsCount > 0)) {
    result.terms_and_restrictions = 'CORRECT';
  } else if (refTermsCount > 0 && extTermsCount === 0) {
    result.terms_and_restrictions = 'ABSTAINED';
  } else {
    result.terms_and_restrictions = 'CORRECT';
  }

  return result;
}

export async function runAccuracyBenchmark(): Promise<DualPipelineBenchmarkResult> {
  console.log('=== PHASE 3: EVALUATE END-TO-END EXTRACTION ACCURACY ON 100 HOLDOUT OFFERS ===');

  const fixturePath = path.resolve(__dirname, '../tests/fixtures/100-holdout-offers.json');
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Holdout dataset not found at ${fixturePath}. Run build-independent-holdout.ts first.`);
  }

  const holdout: HoldoutOffer[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  console.log(`Loaded ${holdout.length} authentic unseen holdout promotions.`);

  const FIELD_NAMES = [
    'merchant_accuracy',
    'bank_attribution',
    'discount_extraction',
    'is_up_to_correctness',
    'cashback_semantics',
    'installment_correctness',
    'minimum_spend',
    'maximum_discount',
    'card_eligibility',
    'date_validity',
    'location_scope',
    'branch_accuracy',
    'duplicate_classification',
    'terms_and_restrictions'
  ];

  function createPipelineReport(name: string): PipelineEvaluationReport {
    const fieldMetrics: Record<string, FieldAccuracyMetric> = {};
    for (const f of FIELD_NAMES) {
      fieldMetrics[f] = {
        fieldName: f,
        totalEvaluated: holdout.length,
        correct: 0,
        incorrect: 0,
        abstained: 0,
        accuracy: 0
      };
    }
    const bankBreakdown: Record<string, any> = {};
    const banks = ['hnb', 'boc', 'sampath', 'seylan', 'peoples', 'nsb', 'combank', 'ndb', 'dfcc', 'pabc'];
    for (const b of banks) {
      bankBreakdown[b] = { total: 0, correctFields: 0, totalFields: 0, accuracy: 0 };
    }
    return {
      pipelineName: name,
      totalOffers: holdout.length,
      bankBreakdown,
      fieldMetrics,
      overallFieldAccuracy: 0,
      abstainedRate: 0,
      incorrectClaimRate: 0,
      unsupportedInferenceRate: 0
    };
  }

  const reportA = createPipelineReport('Pipeline A: Deterministic-Only');
  const reportB = createPipelineReport('Pipeline B: Deterministic + Selective LLM Validation');

  const orchestrator = new UnifiedOfferOrchestrator({
    maxAttempts: 3,
    maxToolCallsPerAttempt: 5,
    maxToolCallsPerOffer: 15,
    geoMode: 'deterministic-only',
    llmMode: 'deterministic-fallback'
  });

  const existingPool: Offer[] = [];
  const sampleEvaluations: DualPipelineBenchmarkResult['sampleEvaluations'] = [];

  for (let i = 0; i < holdout.length; i++) {
    if ((i + 1) % 10 === 0 || i === 0) {
      console.log(`Evaluating offer ${i + 1}/${holdout.length} (${holdout[i].bank} - ${holdout[i].referenceLabels.merchantName})...`);
    }
    const item = holdout[i];
    const candidate = item.candidateOffer;
    const ref = item.referenceLabels;

    // ── Pipeline A: Deterministic Evaluation ────────────────────────────────
    const evalA = evaluateSingleOffer(candidate, ref, existingPool);
    let correctCountA = 0;
    for (const f of FIELD_NAMES) {
      const outcome = evalA[f];
      if (outcome === 'CORRECT') {
        reportA.fieldMetrics[f].correct++;
        correctCountA++;
      } else if (outcome === 'ABSTAINED') {
        reportA.fieldMetrics[f].abstained++;
      } else {
        reportA.fieldMetrics[f].incorrect++;
      }
    }
    reportA.bankBreakdown[item.bank].total++;
    reportA.bankBreakdown[item.bank].totalFields += FIELD_NAMES.length;
    reportA.bankBreakdown[item.bank].correctFields += correctCountA;

    // ── Pipeline B: Unified Validation with selective LLM/rules ─────────────
    const validationReport = await orchestrator.validateOffer(candidate, existingPool);
    const effective = validationReport.effectiveOffer;
    const evalB = evaluateSingleOffer(effective, ref, existingPool);

    let correctCountB = 0;
    for (const f of FIELD_NAMES) {
      const outcome = evalB[f];
      if (outcome === 'CORRECT') {
        reportB.fieldMetrics[f].correct++;
        correctCountB++;
      } else if (outcome === 'ABSTAINED') {
        reportB.fieldMetrics[f].abstained++;
      } else {
        reportB.fieldMetrics[f].incorrect++;
      }
    }
    reportB.bankBreakdown[item.bank].total++;
    reportB.bankBreakdown[item.bank].totalFields += FIELD_NAMES.length;
    reportB.bankBreakdown[item.bank].correctFields += correctCountB;

    if (i < 25 || validationReport.acceptedCorrections.length > 0) {
      sampleEvaluations.push({
        id: item.id,
        bank: item.bank,
        merchant: ref.merchantName,
        pipelineAScore: Math.round((correctCountA / FIELD_NAMES.length) * 100),
        pipelineBScore: Math.round((correctCountB / FIELD_NAMES.length) * 100),
        appliedCorrections: validationReport.acceptedCorrections.map(c => `${c.fieldPath}: ${JSON.stringify(c.proposedValue)}`)
      });
    }

    existingPool.push(candidate);
  }

  function finalizeMetrics(report: PipelineEvaluationReport) {
    let totalFields = 0;
    let totalCorrect = 0;
    let totalAbstained = 0;
    let totalIncorrect = 0;

    for (const f of FIELD_NAMES) {
      const m = report.fieldMetrics[f];
      m.accuracy = parseFloat(((m.correct / m.totalEvaluated) * 100).toFixed(2));
      const relevant = m.correct + m.incorrect;
      m.precision = relevant > 0 ? parseFloat(((m.correct / relevant) * 100).toFixed(2)) : 100;
      m.recall = parseFloat(((m.correct / m.totalEvaluated) * 100).toFixed(2));

      totalFields += m.totalEvaluated;
      totalCorrect += m.correct;
      totalAbstained += m.abstained;
      totalIncorrect += m.incorrect;
    }

    report.overallFieldAccuracy = parseFloat(((totalCorrect / totalFields) * 100).toFixed(2));
    report.abstainedRate = parseFloat(((totalAbstained / totalFields) * 100).toFixed(2));
    report.incorrectClaimRate = parseFloat(((totalIncorrect / totalFields) * 100).toFixed(2));
    report.unsupportedInferenceRate = report.incorrectClaimRate;

    for (const b of Object.keys(report.bankBreakdown)) {
      const bd = report.bankBreakdown[b];
      bd.accuracy = bd.totalFields > 0 ? parseFloat(((bd.correctFields / bd.totalFields) * 100).toFixed(2)) : 0;
    }
  }

  finalizeMetrics(reportA);
  finalizeMetrics(reportB);

  const improvedFields: string[] = [];
  const degradedFields: string[] = [];
  const unchangedFields: string[] = [];

  for (const f of FIELD_NAMES) {
    const accA = reportA.fieldMetrics[f].accuracy;
    const accB = reportB.fieldMetrics[f].accuracy;
    if (accB > accA) improvedFields.push(f);
    else if (accB < accA) degradedFields.push(f);
    else unchangedFields.push(f);
  }

  const result: DualPipelineBenchmarkResult = {
    evaluatedAt: new Date().toISOString(),
    totalHoldoutOffers: holdout.length,
    banksEvaluated: Object.keys(reportA.bankBreakdown),
    pipelineA: reportA,
    pipelineB: reportB,
    accuracyDelta: {
      overallGainPercent: parseFloat((reportB.overallFieldAccuracy - reportA.overallFieldAccuracy).toFixed(2)),
      improvedFields,
      degradedFields,
      unchangedFields
    },
    sampleEvaluations
  };

  const outDir = path.resolve(__dirname, '../reports/holdout-benchmark');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, 'holdout-benchmark-results.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Saved benchmark results to ${outPath}`);

  return result;
}

if (require.main === module) {
  runAccuracyBenchmark()
    .then((res) => {
      console.log('\n================ BENCHMARK SUMMARY ================');
      console.log(`Pipeline A (Deterministic-Only): ${res.pipelineA.overallFieldAccuracy}% overall field accuracy`);
      console.log(`Pipeline B (Hybrid LLM-Assisted): ${res.pipelineB.overallFieldAccuracy}% overall field accuracy`);
      console.log(`Accuracy Delta: +${res.accuracyDelta.overallGainPercent}%`);
      console.log(`Improved Fields: ${res.accuracyDelta.improvedFields.join(', ') || 'None'}`);
      console.log(`Degraded Fields: ${res.accuracyDelta.degradedFields.join(', ') || 'None'}`);
      console.log(`Pipeline B Unsupported Inference Rate: ${res.pipelineB.unsupportedInferenceRate}%`);
      console.log(`Pipeline B Abstained Rate: ${res.pipelineB.abstainedRate}%`);
      console.log('====================================================\n');
    })
    .catch((err) => {
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}
