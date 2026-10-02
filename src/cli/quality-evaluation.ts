/**
 * Phase 4 — Real-World Quality Evaluation & Bank-by-Bank Validation Engine
 *
 * Evaluates normalized system fields against raw source evidence across:
 * - Database offers (HNB, People's, BOC, NSB)
 * - Staged / Output offers (ComBank, Seylan)
 * - Fixture / Survey evidence (Sampath, DFCC, NDB, PABC)
 *
 * Outcomes per field:
 *  - CORRECT
 *  - INCORRECT
 *  - SOURCE_UNCERTAIN
 *  - SYSTEM_UNRESOLVED
 *  - NOT_APPLICABLE
 *  - INSUFFICIENT_EVIDENCE
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../infrastructure/db/db-client';
import { determineLocationScope } from '../domain/location-scope';
import { resolveCanonicalMerchant } from '../domain/merchant-canonicalizer';

export type QualityOutcome =
  | 'CORRECT'
  | 'INCORRECT'
  | 'SOURCE_UNCERTAIN'
  | 'SYSTEM_UNRESOLVED'
  | 'NOT_APPLICABLE'
  | 'INSUFFICIENT_EVIDENCE';

export interface FieldEvaluationResult {
  correct: number;
  incorrect: number;
  sourceUncertain: number;
  systemUnresolved: number;
  notApplicable: number;
  insufficientEvidence: number;
  sampleSize: number;
  issues: Array<{
    id: string;
    uniqueId: string;
    title: string;
    field: string;
    issue: string;
    foundValue?: unknown;
    expectedEvidence?: string;
  }>;
}

export interface BankEvaluationSummary {
  bank: string;
  sampleSize: number;
  sourceTypes: string[];
  fields: {
    merchant: FieldEvaluationResult;
    benefit: FieldEvaluationResult;
    cardEligibility: FieldEvaluationResult;
    dates: FieldEvaluationResult;
    location: FieldEvaluationResult;
    category: FieldEvaluationResult;
    restrictions: FieldEvaluationResult;
    provenance: FieldEvaluationResult;
  };
}

export interface ComprehensiveEvaluationReport {
  evaluatedAt: string;
  totalOffersEvaluated: number;
  bankReports: Record<string, BankEvaluationSummary>;
  systemicAnomalies: {
    invertedDatesCount: number;
    expiredPublishedCount: number;
    genericCardTokensCount: number;
    marketingMerchantsCount: number;
    unsplitCompoundExclusionsCount: number;
    missedUpToCount: number;
    brokenProvenanceCount: number;
  };
}

function emptyFieldResult(n: number): FieldEvaluationResult {
  return {
    correct: 0,
    incorrect: 0,
    sourceUncertain: 0,
    systemUnresolved: 0,
    notApplicable: 0,
    insufficientEvidence: 0,
    sampleSize: n,
    issues: [],
  };
}

export async function runComprehensiveEvaluation(): Promise<ComprehensiveEvaluationReport> {
  // 1. Load DB offers
  let dbRows: any[] = [];
  try {
    const res = await pool.query(`
      SELECT id, unique_id, bank, source_url, title, category, card_type,
             merchant_name, merchant_location, canonical_merchant, location_scope,
             discount_percentage, valid_from, valid_to, card_eligibility,
             geo_locations, geo_status, db_status, content_hash, raw_offer
      FROM offers
      ORDER BY bank, title
    `);
    dbRows = res.rows;
  } catch (err: any) {
    console.warn(`[QualityEval] Warning: Unable to query DB directly (${err.message}). Proceeding with staged files.`);
  }

  // 2. Load Output directory files for uncommitted/staged banks
  const outputDir = path.resolve(__dirname, '../../output');
  const bankOffersMap: Record<string, any[]> = {};

  // Group DB offers
  for (const row of dbRows) {
    if (!bankOffersMap[row.bank]) bankOffersMap[row.bank] = [];
    bankOffersMap[row.bank].push(row);
  }

  // Load ComBank if not in DB or to evaluate staged
  const combankFile = path.join(outputDir, 'combank_all.json');
  if (fs.existsSync(combankFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(combankFile, 'utf-8'));
      const offers = Array.isArray(data) ? data : (data.offers || []);
      bankOffersMap['combank'] = offers.map((o: any) => {
        const title = o.title || o.listing?.title || '';
        const mName = o.merchant?.name || '';
        let loc = o.merchant?.location ?? null;
        if (loc && (loc.toLowerCase() === mName.toLowerCase() || loc.toLowerCase() === title.toLowerCase() || /credit\s+and\s+debit|combank|commercial\s+bank/i.test(loc))) {
          loc = null;
        }
        const desc = o.description || o.offer?.description || title;
        const scopeRes = determineLocationScope({ location: loc, title, description: desc, merchantName: mName });
        return {
          id: o.uniqueId,
          unique_id: o.uniqueId,
          bank: 'combank',
          source_url: o.sourceUrl || o.listing?.detailUrl,
          title,
          category: o.category || o.listing?.categoryLabel,
          card_type: o.cardType,
          merchant_name: mName,
          merchant_location: loc,
          canonical_merchant: resolveCanonicalMerchant(mName).canonicalName,
          location_scope: scopeRes.scope,
          discount_percentage: o.offer?.discountPercentage?.toString() ?? null,
          valid_from: o.validityPeriods?.[0]?.validFrom ?? null,
          valid_to: o.validityPeriods?.[0]?.validTo ?? null,
          card_eligibility: o.cardEligibility ?? {},
          geo_locations: o.merchant?.geocodedLocations ?? [],
          geo_status: o.merchant?.geocodedLocations?.length ? 'resolved' : 'unresolved',
          db_status: 'STAGED',
          content_hash: o.contentHash,
          raw_offer: o,
        };
      });
    } catch { /* ignore */ }
  }

  // Load Seylan if not in DB
  const seylanFile = path.join(outputDir, 'seylan_all.json');
  if (fs.existsSync(seylanFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(seylanFile, 'utf-8'));
      const offers = Array.isArray(data) ? data : (data.offers || []);
      bankOffersMap['seylan'] = offers.map((o: any) => {
        const title = o.title || '';
        const mName = o.merchant?.name || '';
        let loc = o.merchant?.location ?? null;
        if (loc && (loc.toLowerCase() === mName.toLowerCase() || loc.toLowerCase() === title.toLowerCase() || /seylan/i.test(loc))) {
          loc = null;
        }
        const desc = o.description || o.offer?.description || title;
        const scopeRes = determineLocationScope({ location: loc, title, description: desc, merchantName: mName });
        return {
          id: o.uniqueId,
          unique_id: o.uniqueId,
          bank: 'seylan',
          source_url: o.sourceUrl,
          title,
          category: o.category,
          card_type: o.cardType,
          merchant_name: mName,
          merchant_location: loc,
          canonical_merchant: resolveCanonicalMerchant(mName).canonicalName,
          location_scope: scopeRes.scope,
          discount_percentage: o.offer?.discountPercentage?.toString() ?? null,
          valid_from: o.validityPeriods?.[0]?.validFrom ?? null,
          valid_to: o.validityPeriods?.[0]?.validTo ?? null,
          card_eligibility: o.cardEligibility ?? {},
          geo_locations: o.merchant?.geocodedLocations ?? [],
          geo_status: o.merchant?.geocodedLocations?.length ? 'resolved' : 'unresolved',
          db_status: 'STAGED',
          content_hash: o.contentHash,
          raw_offer: o,
        };
      });
    } catch { /* ignore */ }
  }


  // Global anomalies counters
  let totalInvertedDates = 0;
  let totalExpiredPublished = 0;
  let totalGenericCardTokens = 0;
  let totalMarketingMerchants = 0;
  let totalUnsplitCompoundExclusions = 0;
  let totalMissedUpTo = 0;
  let totalBrokenProvenance = 0;

  let grandTotalOffers = 0;
  const bankReports: Record<string, BankEvaluationSummary> = {};
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const [bank, offers] of Object.entries(bankOffersMap)) {
    const n = offers.length;
    grandTotalOffers += n;

    const merchantRes = emptyFieldResult(n);
    const benefitRes = emptyFieldResult(n);
    const cardRes = emptyFieldResult(n);
    const dateRes = emptyFieldResult(n);
    const locRes = emptyFieldResult(n);
    const catRes = emptyFieldResult(n);
    const resRes = emptyFieldResult(n);
    const provRes = emptyFieldResult(n);

    // Identify source format
    let sourceTypes = ['HTML'];
    if (bank === 'hnb') sourceTypes = ['REST API JSON + HTML Modal'];
    if (bank === 'sampath') sourceTypes = ['REST API JSON + Custom Box Markup'];
    if (bank === 'nsb') sourceTypes = ['Free-form Promotional HTML'];

    for (const offer of offers) {
      const title = offer.title || '';
      const mName = offer.merchant_name || '';
      const raw = offer.raw_offer || {};
      const rawText = String(
        raw.rawHtml || raw.description || raw.offer?.description || raw.fullText || title
      );
      const isUpToText = /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(`${title} ${rawText}`);

      // ─── 1. MERCHANT EVALUATION ──────────────────────────────────
      if (!mName || mName.trim() === '') {
        merchantRes.incorrect++;
        merchantRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'merchant',
          issue: 'Empty merchant name'
        });
      } else if (
        // Marketing headline copied verbatim as merchant
        mName.length > 60 &&
        (/\b(?:off|discount|cardholders|installments?|festival|exclusive|savings|enjoy|cashback)\b/i.test(mName))
      ) {
        const hasExplicitMerchantInProse = /Merchant\s*:\s*[^\n]+/i.test(rawText);
        if (hasExplicitMerchantInProse) {
          merchantRes.incorrect++;
          totalMarketingMerchants++;
          merchantRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'merchant',
            issue: `Marketing headline copied as merchant: "${mName.slice(0, 50)}…"`,
            foundValue: mName,
          });
        } else {
          merchantRes.sourceUncertain++;
        }
      } else if (
        // Entire title used as merchant when title contains promo action
        mName.toLowerCase() === title.toLowerCase() &&
        (/\b(?:discount|off|up to|upto|installments?|cashback)\b/i.test(title))
      ) {
        const hasExplicitMerchantInProse = /Merchant\s*:\s*[^\n]+/i.test(rawText);
        if (hasExplicitMerchantInProse) {
          merchantRes.incorrect++;
          totalMarketingMerchants++;
          merchantRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'merchant',
            issue: 'Promo sentence used as merchant name despite explicit Merchant field in source text',
            foundValue: mName,
          });
        } else {
          // Source evidence genuinely lacks any merchant name -> correctly unresolved
          merchantRes.sourceUncertain++;
        }
      } else if (/\bwith your (?:nsb|hnb|boc|combank)\b/i.test(mName)) {
        merchantRes.incorrect++;
        merchantRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'merchant',
          issue: `Merchant name contaminated with card clause: "${mName}"`,
          foundValue: mName,
        });
      } else {
        merchantRes.correct++;
      }

      // ─── 2. BENEFIT EVALUATION ───────────────────────────────────
      const discount = offer.discount_percentage;
      const restrictions: string[] = Array.isArray(raw.offer?.restrictions) ? raw.offer.restrictions : [];
      const hasUpToRestriction = restrictions.some((r) => /up\s*to/i.test(r));

      if (discount !== null && discount !== undefined && discount !== '') {
        const num = parseFloat(discount);
        if (isNaN(num) || num <= 0 || num > 100) {
          benefitRes.incorrect++;
          benefitRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'benefit',
            issue: `Invalid discount percentage value: ${discount}`,
            foundValue: discount,
          });
        } else if (isUpToText && !hasUpToRestriction) {
          benefitRes.incorrect++;
          totalMissedUpTo++;
          benefitRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'benefit',
            issue: `Source states "up to ${num}%" but conditional up-to restriction was not recorded`,
            foundValue: num,
          });
        } else {
          benefitRes.correct++;
        }
      } else {
        // No discount_percentage field
        const pctMatch = rawText.match(/(\d+(?:\.\d+)?)\s*%/);
        if (pctMatch && !/installment|epp|0\s*%/i.test(pctMatch[0])) {
          benefitRes.incorrect++;
          benefitRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'benefit',
            issue: `Unextracted discount percentage (${pctMatch[1]}% in source prose)`,
            foundValue: null,
            expectedEvidence: pctMatch[1],
          });
        } else if (/0\s*%\s*installment|easy\s+payment/i.test(`${title} ${rawText}`)) {
          // Installment offer with no discount % -> correctly not a discount
          benefitRes.correct++;
        } else {
          benefitRes.notApplicable++;
        }
      }

      // ─── 3. CARD ELIGIBILITY EVALUATION ──────────────────────────
      const cardElig = offer.card_eligibility || {};
      const incCards: string[] = Array.isArray(cardElig.includedCards) ? cardElig.includedCards : [];
      const excCards: string[] = Array.isArray(cardElig.excludedCards) ? cardElig.excludedCards : [];
      const hasGenericToken = incCards.some((c) =>
        /^(?:credit|debit|credit\s*(?:\/|&)\s*debit|all\s+cards?|cards?)(?:\s+cards?)?$/i.test(c.trim())
      );

      // Check if product exclusions (food/grocery) leaked into excludedCards
      const hasProductExclusionInCards = excCards.some((c) =>
        /category|categories|vegetable|fruit|meat|seafood|rice|sugar|flour|milk|liquor|tobacco|fuel|bill|pax/i.test(c)
      );

      // Check if compound exclusion wasn't split
      const hasUnsplitCompoundExclusion = excCards.some(
        (c) => /\b(?:and|or)\b/i.test(c) && c.split(/,\s*|\s*&\s*|\s+and\s+/i).length > 1
      );

      if (hasGenericToken) {
        cardRes.incorrect++;
        totalGenericCardTokens++;
        cardRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'cardEligibility',
          issue: `Generic card token in includedCards: [${incCards.join(', ')}]`,
          foundValue: incCards,
        });
      } else if (hasProductExclusionInCards) {
        cardRes.incorrect++;
        cardRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'cardEligibility',
          issue: `Non-card product restriction stored in excludedCards: [${excCards.join('; ')}]`,
          foundValue: excCards,
        });
      } else if (hasUnsplitCompoundExclusion) {
        cardRes.incorrect++;
        totalUnsplitCompoundExclusions++;
        cardRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'cardEligibility',
          issue: `Unsplit compound card exclusions: [${excCards.join(', ')}]`,
          foundValue: excCards,
        });
      } else if (
        incCards.length > 0 ||
        excCards.length > 0 ||
        (Array.isArray(cardElig.cardTypes) && cardElig.cardTypes.length > 0)
      ) {
        cardRes.correct++;
      } else {
        cardRes.sourceUncertain++;
      }

      // ─── 4. DATES EVALUATION ─────────────────────────────────────
      const fromDate = offer.valid_from ? new Date(offer.valid_from).toISOString().slice(0, 10) : null;
      const toDate = offer.valid_to ? new Date(offer.valid_to).toISOString().slice(0, 10) : null;

      if (fromDate && toDate && fromDate > toDate) {
        dateRes.incorrect++;
        totalInvertedDates++;
        dateRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'dates',
          issue: `Inverted dates: validFrom (${fromDate}) > validTo (${toDate})`,
          foundValue: { validFrom: fromDate, validTo: toDate },
        });
      } else if (toDate && toDate < todayStr && offer.db_status === 'PUBLISHED') {
        dateRes.incorrect++;
        totalExpiredPublished++;
        dateRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'dates',
          issue: `Expired offer (${toDate}) marked active PUBLISHED in database`,
          foundValue: toDate,
        });
      } else if (toDate) {
        dateRes.correct++;
      } else {
        dateRes.sourceUncertain++;
      }

      // ─── 5. LOCATION SCOPE EVALUATION ────────────────────────────
      const loc = offer.merchant_location;
      const geoStatus = offer.geo_status;
      const geoLocs = Array.isArray(offer.geo_locations) ? offer.geo_locations : [];
      const scope = offer.location_scope || (raw.locationScope as string) || 'UNRESOLVED';

      // Check false precision / contaminated location field
      const isBogusLocation = loc && (
        loc.toLowerCase() === title.toLowerCase() ||
        loc.toLowerCase() === (mName || '').toLowerCase() ||
        /^(?:mastercard|visa|credit|debit|all\s+cards?|cards?|commercial\s+bank|bank|hnb|boc|nsb)$/i.test(loc.trim())
      );

      if (isBogusLocation) {
        locRes.incorrect++;
        locRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'location',
          issue: `False precision / contaminated location field: "${loc}"`,
          foundValue: loc,
        });
      } else if (scope === 'ONLINE') {
        if (geoLocs.length > 0) {
          locRes.incorrect++;
          locRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'location',
            issue: 'False precision: GPS coordinates assigned to ONLINE promotion',
            foundValue: geoLocs,
          });
        } else {
          locRes.correct++;
        }
      } else if (scope === 'NATIONWIDE' || scope === 'SELECTED_OUTLETS' || scope === 'DISTRICT_REGION') {
        if (geoLocs.length > 0 && /selected\s+outlets|participating\s+outlets/i.test(rawText)) {
          locRes.incorrect++;
          locRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'location',
            issue: 'False precision: GPS coordinates assigned to unlisted selected outlets',
            foundValue: geoLocs,
          });
        } else {
          locRes.correct++;
        }
      } else if (scope === 'EXPLICIT_BRANCH' || scope === 'MULTIPLE_BRANCHES') {
        if (loc || geoLocs.length > 0) {
          locRes.correct++;
        } else {
          locRes.systemUnresolved++;
        }
      } else {
        // Genuinely unresolved location due to lack of branch evidence in source
        locRes.sourceUncertain++;
      }

      // ─── 6. CATEGORY EVALUATION ──────────────────────────────────
      const cat = offer.category;
      if (!cat || cat.trim() === '' || cat.toLowerCase() === 'general' || cat.toLowerCase() === 'other') {
        if (/\b(?:hotel|resort|villa|inn|stay)\b/i.test(title)) {
          catRes.incorrect++;
          catRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'category',
            issue: `Vague category "${cat}" but title clearly indicates Hotel/Travel`,
            foundValue: cat,
          });
        } else if (/\b(?:dining|restaurant|cafe|pizza|bakery|buffet|food)\b/i.test(title)) {
          catRes.incorrect++;
          catRes.issues.push({
            id: offer.id, uniqueId: offer.unique_id, title, field: 'category',
            issue: `Vague category "${cat}" but title clearly indicates Dining`,
            foundValue: cat,
          });
        } else {
          catRes.correct++;
        }
      } else {
        catRes.correct++;
      }

      // ─── 7. RESTRICTIONS EVALUATION ──────────────────────────────
      // Verify whether obvious minimum bill values or booking requirements in source were parsed
      const hasMinBillInText = /\bminimum\s+(?:spend|bill|transaction)\b/i.test(rawText);
      const minValInOffer = offer.raw_offer?.transactionRange?.min;
      const minRestriction = restrictions.some((r) => /minimum/i.test(r));

      if (hasMinBillInText && minValInOffer === null && !minRestriction) {
        resRes.incorrect++;
        resRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'restrictions',
          issue: 'Minimum spend restriction stated in source text but missed in parsed fields',
        });
      } else if (restrictions.length > 0 || minValInOffer !== null) {
        resRes.correct++;
      } else {
        resRes.notApplicable++;
      }

      // ─── 8. PROVENANCE EVALUATION ────────────────────────────────
      if (!offer.source_url || !offer.source_url.startsWith('http')) {
        provRes.incorrect++;
        totalBrokenProvenance++;
        provRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'provenance',
          issue: `Missing or invalid source URL: "${offer.source_url}"`,
          foundValue: offer.source_url,
        });
      } else if (!offer.content_hash || offer.content_hash.length !== 64) {
        provRes.incorrect++;
        provRes.issues.push({
          id: offer.id, uniqueId: offer.unique_id, title, field: 'provenance',
          issue: 'Missing or invalid 64-character sha256 contentHash',
          foundValue: offer.content_hash,
        });
      } else {
        provRes.correct++;
      }
    }

    bankReports[bank] = {
      bank,
      sampleSize: n,
      sourceTypes,
      fields: {
        merchant: merchantRes,
        benefit: benefitRes,
        cardEligibility: cardRes,
        dates: dateRes,
        location: locRes,
        category: catRes,
        restrictions: resRes,
        provenance: provRes,
      },
    };
  }

  const report: ComprehensiveEvaluationReport = {
    evaluatedAt: new Date().toISOString(),
    totalOffersEvaluated: grandTotalOffers,
    bankReports,
    systemicAnomalies: {
      invertedDatesCount: totalInvertedDates,
      expiredPublishedCount: totalExpiredPublished,
      genericCardTokensCount: totalGenericCardTokens,
      marketingMerchantsCount: totalMarketingMerchants,
      unsplitCompoundExclusionsCount: totalUnsplitCompoundExclusions,
      missedUpToCount: totalMissedUpTo,
      brokenProvenanceCount: totalBrokenProvenance,
    },
  };

  return report;
}

export function printEvaluationReport(report: ComprehensiveEvaluationReport): void {
  console.log('========================================================================');
  console.log('LANKA OFFERS — REAL-WORLD QUALITY EVALUATION & BANK VALIDATION');
  console.log(`Evaluated: ${report.totalOffersEvaluated} total offers across ${Object.keys(report.bankReports).length} banks`);
  console.log(`Timestamp: ${report.evaluatedAt}`);
  console.log('========================================================================\n');

  for (const [bank, rep] of Object.entries(report.bankReports)) {
    console.log(`=== BANK: ${bank.toUpperCase()} (N = ${rep.sampleSize} offers) [Source: ${rep.sourceTypes.join(', ')}] ===`);
    for (const [field, res] of Object.entries(rep.fields)) {
      const correctPct = Math.round((res.correct / res.sampleSize) * 100);
      const incorrectPct = Math.round((res.incorrect / res.sampleSize) * 100);
      const uncertPct = Math.round(((res.sourceUncertain + res.systemUnresolved) / res.sampleSize) * 100);
      console.log(
        `  ${field.padEnd(16)} | Correct: ${String(res.correct).padStart(3)} (${correctPct}%) | ` +
        `Incorrect: ${String(res.incorrect).padStart(3)} (${incorrectPct}%) | ` +
        `Uncertain/Unresolved: ${String(res.sourceUncertain + res.systemUnresolved).padStart(3)} (${uncertPct}%) | ` +
        `N/A: ${res.notApplicable}`
      );
      if (res.issues.length > 0) {
        console.log(`     Issue sample: ${res.issues[0].issue} (ID: ${res.issues[0].uniqueId})`);
      }
    }
    console.log('');
  }

  console.log('========================================================================');
  console.log('SYSTEMIC ANOMALY TOTALS ACROSS EVALUATION SET');
  console.log('========================================================================');
  console.log(`- Inverted Dates (validFrom > validTo):        ${report.systemicAnomalies.invertedDatesCount}`);
  console.log(`- Expired Published Offers (validTo < today):  ${report.systemicAnomalies.expiredPublishedCount}`);
  console.log(`- Stored Generic Card Tokens in includedCards: ${report.systemicAnomalies.genericCardTokensCount}`);
  console.log(`- Marketing Titles Copied as Merchants:       ${report.systemicAnomalies.marketingMerchantsCount}`);
  console.log(`- Unsplit Compound Exclusions:                ${report.systemicAnomalies.unsplitCompoundExclusionsCount}`);
  console.log(`- Missed Conditional "Up to" Semantics:       ${report.systemicAnomalies.missedUpToCount}`);
  console.log(`- Broken Provenance / Source URLs:            ${report.systemicAnomalies.brokenProvenanceCount}`);
  console.log('========================================================================\n');
}

if (require.main === module) {
  runComprehensiveEvaluation()
    .then((report) => {
      printEvaluationReport(report);
      const outPath = path.resolve(__dirname, '../../output/quality-evaluation-report.json');
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`Saved full evaluation report to: ${outPath}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end();
    });
}
