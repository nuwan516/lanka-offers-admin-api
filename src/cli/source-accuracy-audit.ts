import * as fs from 'fs';
import * as path from 'path';
import type { Offer } from '@/core/types/offers';
import { parseFinancialTerms } from '@/parsing/transaction/transaction-parser';

export interface OfferAccuracyEvaluation {
  uniqueId: string;
  bank: string;
  merchantName: string;
  merchantStatus: 'CORRECT' | 'SUSPICIOUS_SENTENCE' | 'PLACEHOLDER' | 'REVIEW';
  title: string;
  discountPercentage: number | string | null;
  discountQualifier: string | null;
  minTransaction: number | null;
  maxTransaction: number | null;
  maxDiscountCap: number | null;
  validFrom: string | null;
  validTo: string | null;
  dateInverted: boolean;
  cards: string[];
  locationCount: number;
  confidence: 'HIGH' | 'MEDIUM' | 'REVIEW_REQUIRED';
  issues: string[];
}

export interface BankAccuracyReport {
  bank: string;
  totalOffers: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  reviewRequiredCount: number;
  issuesSummary: Record<string, number>;
  evaluations: OfferAccuracyEvaluation[];
}

export function evaluateOfferAccuracy(offer: Offer): OfferAccuracyEvaluation {
  const issues: string[] = [];
  const rawText = [
    offer.rawHtml || '',
    offer.offer?.description || '',
    ...(offer.offer?.generalTerms || []),
  ].join('\n');

  // 1. Merchant Evaluation
  let merchantStatus: OfferAccuracyEvaluation['merchantStatus'] = 'CORRECT';
  const mName = offer.merchant?.name || '';
  if (!mName || mName.trim().length === 0) {
    merchantStatus = 'PLACEHOLDER';
    issues.push('Missing merchant name');
  } else if (/^Save\s+\d+%.*with/i.test(mName) || mName.length > 55 || /\b(?:with\s+ComBank|using\s+ComBank|with\s+your\s+card)\b/i.test(mName)) {
    merchantStatus = 'SUSPICIOUS_SENTENCE';
    issues.push(`Merchant name appears to contain marketing sentence: "${mName}"`);
  } else if (/^(?:hotel|restaurant|online|destination|selected)/i.test(mName.trim())) {
    merchantStatus = 'PLACEHOLDER';
    issues.push(`Generic placeholder merchant name: "${mName}"`);
  }

  // 2. Financial & Range Accuracy
  const financial = parseFinancialTerms(rawText);
  if (offer.transactionRange?.max !== null && financial.maximum_discount_amount !== null) {
    if (offer.transactionRange.max === financial.maximum_discount_amount && financial.maximum_transaction_amount !== financial.maximum_discount_amount) {
      issues.push(`CRITICAL DEFECT: Maximum discount amount (${financial.maximum_discount_amount}) was confused with maximum transaction limit`);
    }
  }

  // 3. Discount & Qualifier
  if (/up\s+to\s+\d+%/i.test(rawText) && !offer.offer?.restrictions?.some(r => /up to/i.test(r))) {
    issues.push('Promotion text contains "up to" discount qualifier but restrictions do not reflect it');
  }

  // 4. Validity Period
  let dateInverted = false;
  if (offer.validityPeriods && offer.validityPeriods.length > 0) {
    for (const vp of offer.validityPeriods) {
      if (vp.validFrom && vp.validTo && vp.validFrom > vp.validTo) {
        dateInverted = true;
        issues.push(`Inverted validity dates: from (${vp.validFrom}) > to (${vp.validTo})`);
      }
    }
  }

  // 5. Location Evidence
  const locationCount = (offer.merchant?.addresses?.length ?? 0) + (offer.merchant?.location ? 1 : 0);

  // Confidence classification
  let confidence: 'HIGH' | 'MEDIUM' | 'REVIEW_REQUIRED' = 'HIGH';
  if (merchantStatus === 'SUSPICIOUS_SENTENCE' || merchantStatus === 'PLACEHOLDER' || dateInverted || issues.some(i => i.includes('CRITICAL DEFECT'))) {
    confidence = 'REVIEW_REQUIRED';
  } else if (issues.length > 0) {
    confidence = 'MEDIUM';
  }

  return {
    uniqueId: offer.uniqueId,
    bank: offer.source,
    merchantName: mName,
    merchantStatus,
    title: offer.title,
    discountPercentage: offer.offer?.discountPercentage ?? null,
    discountQualifier: financial.discount_qualifier,
    minTransaction: offer.transactionRange?.min ?? null,
    maxTransaction: offer.transactionRange?.max ?? null,
    maxDiscountCap: financial.maximum_discount_amount,
    validFrom: offer.validityPeriods?.[0]?.validFrom ?? null,
    validTo: offer.validityPeriods?.[0]?.validTo ?? null,
    dateInverted,
    cards: offer.cardEligibility?.cardTypes ?? offer.offer?.applicableCards ?? [],
    locationCount,
    confidence,
    issues,
  };
}

export function auditBankDataset(bank: string, offers: Offer[]): BankAccuracyReport {
  const evaluations = offers.map(evaluateOfferAccuracy);
  const issuesSummary: Record<string, number> = {};

  let highConfidenceCount = 0;
  let mediumConfidenceCount = 0;
  let reviewRequiredCount = 0;

  for (const ev of evaluations) {
    if (ev.confidence === 'HIGH') highConfidenceCount++;
    else if (ev.confidence === 'MEDIUM') mediumConfidenceCount++;
    else reviewRequiredCount++;

    for (const issue of ev.issues) {
      const key = issue.split(':')[0];
      issuesSummary[key] = (issuesSummary[key] ?? 0) + 1;
    }
  }

  return {
    bank,
    totalOffers: offers.length,
    highConfidenceCount,
    mediumConfidenceCount,
    reviewRequiredCount,
    issuesSummary,
    evaluations,
  };
}

export function runFullAccuracyAudit(): void {
  const combankPath = path.resolve(process.cwd(), 'output/dry-runs/combank/2026-10-16T08-35-52Z/normalized-offers.json');
  const seylanPath = path.resolve(process.cwd(), 'output/dry-runs/seylan/2026-10-16T09-01-51Z/normalized-offers.json');

  console.log('========================================================================');
  console.log('LANKA OFFERS — REPRODUCIBLE SOURCE-TO-NORMALIZED DATA ACCURACY AUDIT');
  console.log('========================================================================\n');

  if (fs.existsSync(combankPath)) {
    const combankOffers: Offer[] = JSON.parse(fs.readFileSync(combankPath, 'utf8'));
    const combankReport = auditBankDataset('combank', combankOffers);
    printReport(combankReport);
  }

  if (fs.existsSync(seylanPath)) {
    const seylanOffers: Offer[] = JSON.parse(fs.readFileSync(seylanPath, 'utf8'));
    const seylanReport = auditBankDataset('seylan', seylanOffers);
    printReport(seylanReport);
  }
}

function printReport(rep: BankAccuracyReport): void {
  console.log(`BANK: ${rep.bank.toUpperCase()}`);
  console.log(`Total Extracted Offers: ${rep.totalOffers}`);
  console.log(`  - High Confidence:    ${rep.highConfidenceCount} (${Math.round((rep.highConfidenceCount / rep.totalOffers) * 100)}%)`);
  console.log(`  - Medium Confidence:  ${rep.mediumConfidenceCount} (${Math.round((rep.mediumConfidenceCount / rep.totalOffers) * 100)}%)`);
  console.log(`  - Review Required:    ${rep.reviewRequiredCount} (${Math.round((rep.reviewRequiredCount / rep.totalOffers) * 100)}%)`);
  console.log('Issues Summary:');
  for (const [k, count] of Object.entries(rep.issuesSummary)) {
    console.log(`    * ${k}: ${count}`);
  }
  const reviewSamples = rep.evaluations.filter(e => e.confidence === 'REVIEW_REQUIRED').slice(0, 5);
  if (reviewSamples.length > 0) {
    console.log('\nRepresentative Review Samples:');
    for (const s of reviewSamples) {
      console.log(`  [${s.uniqueId}] Merchant: "${s.merchantName}" | Issues: ${s.issues.join('; ')}`);
    }
  }
  console.log('------------------------------------------------------------------------\n');
}

if (require.main === module) {
  runFullAccuracyAudit();
}
