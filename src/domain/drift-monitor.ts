/**
 * Data Quality Drift & Extraction Anomaly Monitoring
 *
 * Evaluates scraped batches against historical baselines and structural quality invariants:
 *  - Unexpected zero-offer scrapes
 *  - Large offer-count drops / surges
 *  - Bank HTML structure changes / selector decay
 *  - Missing merchant names
 *  - Unexpected null fields
 *  - Inverted validity dates
 *  - Suspicious discount distributions
 *  - Increased review-required rates
 *  - Duplicate spikes
 *  - Address contamination (emails, phone numbers, raw markup fragments)
 *  - Increasing LLM correction rejection rates
 *
 * Produces actionable diagnostics for operational triage without silently mutating extracted data.
 */

import { Offer } from '@/core/types/offers';
import { UnifiedOfferValidationReport } from '@/parsing/validators/unified-offer-orchestrator';

export type DriftSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DriftDiagnostic {
  code: string;
  severity: DriftSeverity;
  title: string;
  description: string;
  bank?: string;
  metric: string;
  currentValue: number | string;
  thresholdValue: number | string;
  actionableStep: string;
}

export interface DriftBaseline {
  bank: string;
  previousOfferCount?: number | null;
  previousReviewRate?: number | null;
  previousDuplicateRate?: number | null;
}

export interface DriftEvaluationInput {
  bank: string;
  offers: Offer[];
  validationReports?: UnifiedOfferValidationReport[];
  baseline?: DriftBaseline;
  rawOffersCount?: number;
}

export interface DriftReport {
  evaluatedAt: string;
  bank: string;
  status: 'HEALTHY' | 'DEGRADED' | 'DRIFT_DETECTED';
  totalOffers: number;
  diagnostics: DriftDiagnostic[];
  metrics: {
    offersFound: number;
    offersParsed: number;
    baselineOffers: number | null;
    missingMerchantRate: number;
    invertedDateCount: number;
    addressContaminationCount: number;
    suspiciousDiscountCount: number;
    reviewRequiredRate: number;
    duplicateRate: number;
    correctionRejectionRate: number;
  };
}

const EMAIL_FRAGMENT_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/;
const PHONE_FRAGMENT_REGEX = /(?:\+94|0)[0-9]{2,3}[-\s]?[0-9]{6,7}/;

export function evaluateDataQualityDrift(input: DriftEvaluationInput): DriftReport {
  const diagnostics: DriftDiagnostic[] = [];
  const total = input.offers.length;
  const rawCount = input.rawOffersCount ?? total;
  const baselineCount = input.baseline?.previousOfferCount ?? null;

  // 1. Zero-offer scrape detection
  if (total === 0) {
    diagnostics.push({
      code: 'ZERO_OFFER_SCRAPE',
      severity: 'CRITICAL',
      title: `Zero offers extracted for ${input.bank.toUpperCase()}`,
      description: baselineCount && baselineCount > 0
        ? `Scrape yielded 0 offers vs ${baselineCount} in previous baseline.`
        : `Scrape yielded 0 offers from source bank.`,
      bank: input.bank,
      metric: 'totalOffers',
      currentValue: 0,
      thresholdValue: 1,
      actionableStep: 'Inspect bank website for anti-bot challenge, SSL/network error, or changed container selector.',
    });
  } else if (baselineCount !== null && baselineCount >= 10) {
    // 2. Large offer count drop
    if (total <= Math.floor(baselineCount * 0.5)) {
      const dropPct = Math.round(((baselineCount - total) / baselineCount) * 100);
      diagnostics.push({
        code: 'LARGE_OFFER_COUNT_DROP',
        severity: 'WARNING',
        title: `Significant volume drop for ${input.bank.toUpperCase()}`,
        description: `Extracted ${total} offers vs ${baselineCount} baseline (-${dropPct}% drop).`,
        bank: input.bank,
        metric: 'offerCountChangePct',
        currentValue: `-${dropPct}%`,
        thresholdValue: '-50%',
        actionableStep: 'Verify bank category navigation, pagination limits, and active promotions index.',
      });
    }

    // 3. Large offer count surge
    if (total >= baselineCount * 2.5) {
      const surgePct = Math.round(((total - baselineCount) / baselineCount) * 100);
      diagnostics.push({
        code: 'LARGE_OFFER_COUNT_SURGE',
        severity: 'WARNING',
        title: `Unusual volume surge for ${input.bank.toUpperCase()}`,
        description: `Extracted ${total} offers vs ${baselineCount} baseline (+${surgePct}% surge).`,
        bank: input.bank,
        metric: 'offerCountChangePct',
        currentValue: `+${surgePct}%`,
        thresholdValue: '+150%',
        actionableStep: 'Check for pagination infinite loops or duplicated cards in DOM.',
      });
    }
  }

  // 4. HTML structure change: raw discovery succeeded but parser failed completely
  if (rawCount > 0 && total === 0) {
    diagnostics.push({
      code: 'HTML_STRUCTURE_DECAY',
      severity: 'CRITICAL',
      title: `Parser extraction decay for ${input.bank.toUpperCase()}`,
      description: `Discovered ${rawCount} raw promo elements, but 0 parsed offers produced.`,
      bank: input.bank,
      metric: 'parseEfficiency',
      currentValue: '0%',
      thresholdValue: '80%',
      actionableStep: 'Inspect DOM layout: promotion card selectors or title selectors have changed.',
    });
  }

  // Inspect individual offers
  let missingMerchantCount = 0;
  let unexpectedNullFieldCount = 0;
  let invertedDateCount = 0;
  let suspiciousDiscountCount = 0;
  let addressContaminationCount = 0;

  for (const o of input.offers) {
    // Missing merchant name
    if (!o.merchant?.name || o.merchant.name.trim().length === 0) {
      missingMerchantCount++;
    }

    // Mandatory null fields
    if (!o.title || !o.uniqueId || !o.scrapedAt) {
      unexpectedNullFieldCount++;
    }

    // Inverted dates
    for (const v of o.validityPeriods || []) {
      if (v.validFrom && v.validTo && v.validFrom > v.validTo) {
        invertedDateCount++;
      }
    }

    // Suspicious discount distributions
    const disc = o.offer?.discountPercentage;
    if (disc !== null && typeof disc === 'number') {
      if (disc <= 0 || disc > 85) {
        suspiciousDiscountCount++;
      }
    }

    // Address contamination check (e.g. email fragment "wild@centauriaho" or phone numbers inside address strings)
    const addresses = o.merchant?.addresses || [];
    for (const addr of addresses) {
      if (EMAIL_FRAGMENT_REGEX.test(addr) || PHONE_FRAGMENT_REGEX.test(addr) || addr.includes('<') || addr.includes('href=')) {
        addressContaminationCount++;
        break;
      }
    }
  }

  const missingMerchantRate = total > 0 ? missingMerchantCount / total : 0;
  if (missingMerchantRate > 0.05) {
    diagnostics.push({
      code: 'HIGH_MISSING_MERCHANT_RATE',
      severity: 'WARNING',
      title: `High missing merchant rate for ${input.bank.toUpperCase()}`,
      description: `${missingMerchantCount} of ${total} offers (${Math.round(missingMerchantRate * 100)}%) missing merchant names.`,
      bank: input.bank,
      metric: 'missingMerchantRate',
      currentValue: `${Math.round(missingMerchantRate * 100)}%`,
      thresholdValue: '5%',
      actionableStep: 'Update bank selector for merchant name or brand tag.',
    });
  }

  if (unexpectedNullFieldCount > 0) {
    diagnostics.push({
      code: 'UNEXPECTED_NULL_MANDATORY_FIELDS',
      severity: 'CRITICAL',
      title: `Mandatory null fields detected for ${input.bank.toUpperCase()}`,
      description: `${unexpectedNullFieldCount} offers contain null title, uniqueId, or scrapedAt.`,
      bank: input.bank,
      metric: 'unexpectedNullFields',
      currentValue: unexpectedNullFieldCount,
      thresholdValue: 0,
      actionableStep: 'Fix raw payload transformer to guarantee core mandatory fields.',
    });
  }

  if (invertedDateCount > 0) {
    diagnostics.push({
      code: 'INVERTED_VALIDITY_DATES',
      severity: 'CRITICAL',
      title: `Inverted validity periods in ${input.bank.toUpperCase()}`,
      description: `${invertedDateCount} offers have validFrom dates after validTo dates.`,
      bank: input.bank,
      metric: 'invertedDates',
      currentValue: invertedDateCount,
      thresholdValue: 0,
      actionableStep: 'Review date parser: day/month format may be swapped (DD/MM vs MM/DD).',
    });
  }

  if (suspiciousDiscountCount > 0 && total > 0 && (suspiciousDiscountCount / total) > 0.15) {
    diagnostics.push({
      code: 'SUSPICIOUS_DISCOUNT_DISTRIBUTION',
      severity: 'WARNING',
      title: `Suspicious discount values in ${input.bank.toUpperCase()}`,
      description: `${suspiciousDiscountCount} offers have anomalous discount figures (<=0% or >85%).`,
      bank: input.bank,
      metric: 'suspiciousDiscountRate',
      currentValue: `${Math.round((suspiciousDiscountCount / total) * 100)}%`,
      thresholdValue: '15%',
      actionableStep: 'Audit bank regex for discount extraction: may be parsing telephone or year as percentage.',
    });
  }

  if (addressContaminationCount > 0) {
    diagnostics.push({
      code: 'ADDRESS_CONTAMINATION',
      severity: 'WARNING',
      title: `Contaminated address strings in ${input.bank.toUpperCase()}`,
      description: `${addressContaminationCount} merchant addresses contain email, phone, or markup fragments.`,
      bank: input.bank,
      metric: 'addressContaminationCount',
      currentValue: addressContaminationCount,
      thresholdValue: 0,
      actionableStep: 'Improve address sanitizer to separate email/telephone contact channels from geographic addresses.',
    });
  }

  // Validation report metrics (if available)
  let reviewCount = 0;
  let duplicateCount = 0;
  let rejectedCorrectionsCount = 0;
  let totalCorrectionsCount = 0;

  if (input.validationReports && input.validationReports.length > 0) {
    for (const r of input.validationReports) {
      if (r.qualityGate.status === 'REVIEW_REQUIRED') reviewCount++;
      if (r.duplicateAnalysis?.isDuplicate) duplicateCount++;
      rejectedCorrectionsCount += r.rejectedCorrections?.length || 0;
      totalCorrectionsCount += (r.acceptedCorrections?.length || 0) + (r.rejectedCorrections?.length || 0);
    }
  }

  const reviewRequiredRate = total > 0 ? reviewCount / total : 0;
  if (reviewRequiredRate > 0.40) {
    diagnostics.push({
      code: 'HIGH_HUMAN_REVIEW_RATE',
      severity: 'WARNING',
      title: `Spike in human review backlog for ${input.bank.toUpperCase()}`,
      description: `${reviewCount} of ${total} offers (${Math.round(reviewRequiredRate * 100)}%) flagged for manual review.`,
      bank: input.bank,
      metric: 'reviewRequiredRate',
      currentValue: `${Math.round(reviewRequiredRate * 100)}%`,
      thresholdValue: '40%',
      actionableStep: 'Check if new promotional phrasing is triggering safety gates or scope ambiguity.',
    });
  }

  const duplicateRate = total > 0 ? duplicateCount / total : 0;
  if (duplicateRate > 0.15) {
    diagnostics.push({
      code: 'DUPLICATE_SPIKE',
      severity: 'WARNING',
      title: `Elevated duplicate rate for ${input.bank.toUpperCase()}`,
      description: `${duplicateCount} offers (${Math.round(duplicateRate * 100)}%) matched existing promotions.`,
      bank: input.bank,
      metric: 'duplicateRate',
      currentValue: `${Math.round(duplicateRate * 100)}%`,
      thresholdValue: '15%',
      actionableStep: 'Audit offer uniqueId hashing and cross-category deduplication rules.',
    });
  }

  const correctionRejectionRate = totalCorrectionsCount > 0 ? rejectedCorrectionsCount / totalCorrectionsCount : 0;
  if (totalCorrectionsCount >= 5 && correctionRejectionRate > 0.30) {
    diagnostics.push({
      code: 'HIGH_LLM_CORRECTION_REJECTION_RATE',
      severity: 'WARNING',
      title: `High model correction rejection rate for ${input.bank.toUpperCase()}`,
      description: `${rejectedCorrectionsCount} of ${totalCorrectionsCount} model proposals (${Math.round(correctionRejectionRate * 100)}%) rejected for lack of source evidence.`,
      bank: input.bank,
      metric: 'correctionRejectionRate',
      currentValue: `${Math.round(correctionRejectionRate * 100)}%`,
      thresholdValue: '30%',
      actionableStep: 'Review model prompt instructions and evidence snippet indexing to reduce unsupported proposals.',
    });
  }

  const hasCritical = diagnostics.some((d) => d.severity === 'CRITICAL');
  const hasWarning = diagnostics.some((d) => d.severity === 'WARNING');
  const status = hasCritical ? 'DRIFT_DETECTED' : hasWarning ? 'DEGRADED' : 'HEALTHY';

  return {
    evaluatedAt: new Date().toISOString(),
    bank: input.bank,
    status,
    totalOffers: total,
    diagnostics,
    metrics: {
      offersFound: rawCount,
      offersParsed: total,
      baselineOffers: baselineCount,
      missingMerchantRate,
      invertedDateCount,
      addressContaminationCount,
      suspiciousDiscountCount,
      reviewRequiredRate,
      duplicateRate,
      correctionRejectionRate,
    },
  };
}
