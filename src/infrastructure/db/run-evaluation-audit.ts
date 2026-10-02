import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from './db-client';

export interface FieldEvaluationResult {
  correct: number;
  incorrect: number;
  sourceUncertain: number;
  systemUnresolved: number;
  notApplicable: number;
  sampleSize: number;
  issues: Array<{ id: string; uniqueId: string; title: string; issue: string; rawSnippet?: string }>;
}

export interface BankEvaluationReport {
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
    provenance: FieldEvaluationResult;
  };
}

import { Pool } from 'pg';

async function main() {
  console.log('Running Real-World Quality Evaluation across all stored bank offers…\n');

  const connStr = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  const auditPool = new Pool({ connectionString: connStr, connectionTimeoutMillis: 20_000 });

  const allOffers: any[] = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const chunk = await auditPool.query(`
      SELECT id, unique_id, bank, source_url, title, category, card_type,
             merchant_name, merchant_location, discount_percentage, valid_from,
             valid_to, card_eligibility, geo_locations, geo_status, db_status,
             content_hash, raw_offer
      FROM offers
      ORDER BY bank, created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    if (chunk.rows.length === 0) break;
    allOffers.push(...chunk.rows);
    offset += chunk.rows.length;
    console.log(`Fetched ${allOffers.length} offers so far…`);
  }

  console.log(`Loaded ${allOffers.length} total offers from database.\n`);

  const banks = [...new Set(allOffers.map((o) => o.bank))];
  const bankReports: Record<string, BankEvaluationReport> = {};

  // Track global anomalies
  const invertedDateOffers: any[] = [];
  const expiredPublishedOffers: any[] = [];
  const marketingTitleAsMerchantOffers: any[] = [];
  const genericTokensInIncludedCards: any[] = [];
  const missingBenefitOffers: any[] = [];
  const brokenProvenanceOffers: any[] = [];

  for (const bank of banks) {
    const bankOffers = allOffers.filter((o) => o.bank === bank);
    const n = bankOffers.length;

    const merchantRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const benefitRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const cardRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const dateRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const locRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const catRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };
    const provRes: FieldEvaluationResult = { correct: 0, incorrect: 0, sourceUncertain: 0, systemUnresolved: 0, notApplicable: 0, sampleSize: n, issues: [] };

    for (const offer of bankOffers) {
      const raw = offer.raw_offer ?? {};
      const title = offer.title ?? '';
      const mName = offer.merchant_name ?? '';
      const rawHtml = String(offer.raw_offer?.rawHtml ?? offer.raw_offer?.raw_html ?? offer.raw_offer?.content ?? '');

      // ─── 1. Merchant Evaluation ─────────────────────────────
      // Check if merchant is empty
      if (!mName || mName.trim() === '') {
        merchantRes.incorrect++;
        merchantRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: 'Empty merchant name' });
      } else if (mName.length > 70 && (/\b(?:off|discount|cardholders|installments?|festival|exclusive|savings)\b/i.test(mName))) {
        // Marketing headline copied verbatim as merchant
        merchantRes.incorrect++;
        const iss = { id: offer.id, uniqueId: offer.unique_id, title, issue: `Marketing headline copied as merchant (${mName.slice(0, 50)}…)` };
        merchantRes.issues.push(iss);
        marketingTitleAsMerchantOffers.push({ bank, uniqueId: offer.unique_id, merchantName: mName, title });
      } else if (mName.toLowerCase() === title.toLowerCase() && (/\b(?:discount|off|up to|installments?)\b/i.test(title))) {
        // Title itself was a promotional sentence and got used as merchant
        merchantRes.incorrect++;
        merchantRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: 'Promo headline used as merchant without entity extraction' });
      } else {
        merchantRes.correct++;
      }

      // ─── 2. Benefit Evaluation ──────────────────────────────
      const discount = offer.discount_percentage;
      const isUpToText = /\b(?:up\s*to|upto)\s+\d+%/i.test(`${title} ${rawHtml}`);
      const restrictions: string[] = Array.isArray(offer.raw_offer?.offer?.restrictions) ? offer.raw_offer.offer.restrictions : [];
      const hasUpToRestriction = restrictions.some((r) => /up\s*to/i.test(r));

      if (discount !== null && discount !== undefined && discount !== '') {
        const num = parseFloat(discount);
        if (isNaN(num) || num <= 0 || num > 100) {
          benefitRes.incorrect++;
          benefitRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Invalid discount percentage: ${discount}` });
        } else if (isUpToText && !hasUpToRestriction) {
          // Source clearly said "up to 20%" but restriction was missed
          benefitRes.incorrect++;
          benefitRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Up-to discount (${num}%) missing conditional restriction note` });
        } else {
          benefitRes.correct++;
        }
      } else {
        // Check if source text mentions a % discount that parser missed
        const pctMatch = `${title} ${rawHtml}`.match(/(\d+(?:\.\d+)?)\s*%/);
        if (pctMatch && !/installment|epp|0\s*%/i.test(pctMatch[0])) {
          benefitRes.incorrect++;
          benefitRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Unextracted discount percentage (${pctMatch[1]}% in source text)` });
          missingBenefitOffers.push({ bank, uniqueId: offer.unique_id, title, rawDiscount: pctMatch[1] });
        } else if (/0\s*%\s*installment|easy\s+payment/i.test(`${title} ${rawHtml}`)) {
          // 0% installment offer where discount_percentage is null -> Correct (not a discount)
          benefitRes.correct++;
        } else {
          // No discount in source
          benefitRes.notApplicable++;
        }
      }

      // ─── 3. Card Eligibility Evaluation ────────────────────
      const cardElig = offer.card_eligibility ?? {};
      const incCards: string[] = Array.isArray(cardElig.includedCards) ? cardElig.includedCards : [];
      const excCards: string[] = Array.isArray(cardElig.excludedCards) ? cardElig.excludedCards : [];
      const hasGenericToken = incCards.some((c) => /^(?:credit|debit|credit\s*(?:\/|&)\s*debit|all\s+cards?|cards?)(?:\s+cards?)?$/i.test(c.trim()));

      if (hasGenericToken) {
        cardRes.incorrect++;
        cardRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Generic card token in includedCards: [${incCards.join(', ')}]` });
        genericTokensInIncludedCards.push({ bank, uniqueId: offer.unique_id, incCards });
      } else if (excCards.some((c) => /\b(?:and|or)\b/i.test(c) && c.split(/,\s*|\s+and\s+/i).length > 1)) {
        cardRes.incorrect++;
        cardRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Unsplit compound excluded cards: [${excCards.join(', ')}]` });
      } else if (incCards.length > 0 || excCards.length > 0 || (Array.isArray(cardElig.cardTypes) && cardElig.cardTypes.length > 0)) {
        cardRes.correct++;
      } else {
        // Source had no specific card eligibility mentioned
        cardRes.sourceUncertain++;
      }

      // ─── 4. Dates Evaluation ────────────────────────────────
      const fromDate = offer.valid_from ? new Date(offer.valid_from).toISOString().slice(0, 10) : null;
      const toDate = offer.valid_to ? new Date(offer.valid_to).toISOString().slice(0, 10) : null;
      const today = new Date().toISOString().slice(0, 10);

      if (fromDate && toDate && fromDate > toDate) {
        dateRes.incorrect++;
        dateRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Inverted dates: validFrom (${fromDate}) > validTo (${toDate})` });
        invertedDateOffers.push({ bank, uniqueId: offer.unique_id, title, fromDate, toDate });
      } else if (toDate && toDate < today && offer.db_status === 'PUBLISHED') {
        dateRes.incorrect++;
        dateRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Expired offer (${toDate}) published as active PUBLISHED` });
        expiredPublishedOffers.push({ bank, uniqueId: offer.unique_id, title, toDate, status: offer.db_status });
      } else if (toDate) {
        dateRes.correct++;
      } else {
        // No expiry in source (e.g. NSB)
        dateRes.sourceUncertain++;
      }

      // ─── 5. Location Scope Evaluation ───────────────────────
      const loc = offer.merchant_location;
      const geoStatus = offer.geo_status;
      const geoLocs = Array.isArray(offer.geo_locations) ? offer.geo_locations : [];

      if (loc && /selected\s+outlets|selected\s+branches|participating\s+outlets/i.test(loc)) {
        // Source explicitly says "selected outlets"
        if (geoLocs.length > 0) {
          // False precision: assigned exact coordinates to "selected outlets" without branch specification
          locRes.incorrect++;
          locRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `False precision: GPS coordinates assigned to vague "${loc}"` });
        } else {
          // Correctly left unresolved without false precision
          locRes.systemUnresolved++;
        }
      } else if (loc && loc.trim().length > 0) {
        if (geoStatus === 'resolved' || geoLocs.length > 0) {
          locRes.correct++;
        } else {
          locRes.systemUnresolved++;
        }
      } else {
        // Location not specified in source
        locRes.sourceUncertain++;
      }

      // ─── 6. Category Evaluation ─────────────────────────────
      const cat = offer.category;
      if (!cat || cat.trim() === '' || cat.toLowerCase() === 'general' || cat.toLowerCase() === 'other') {
        // Check if title clearly mentions dining, hotel, supermarket
        if (/\b(?:hotel|resort|villa|inn)\b/i.test(title)) {
          catRes.incorrect++;
          catRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Categorized as "${cat}" but title indicates Hotel/Travel` });
        } else if (/\b(?:dining|restaurant|cafe|pizza|bakery|buffet|food)\b/i.test(title)) {
          catRes.incorrect++;
          catRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Categorized as "${cat}" but title indicates Dining` });
        } else {
          catRes.correct++;
        }
      } else {
        catRes.correct++;
      }

      // ─── 7. Provenance Evaluation ───────────────────────────
      if (!offer.source_url || !offer.source_url.startsWith('http')) {
        provRes.incorrect++;
        provRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: `Invalid or missing source URL: ${offer.source_url}` });
        brokenProvenanceOffers.push({ bank, uniqueId: offer.unique_id, sourceUrl: offer.source_url });
      } else if (!offer.raw_offer || Object.keys(offer.raw_offer).length === 0) {
        provRes.incorrect++;
        provRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: 'Missing raw_offer payload' });
      } else if (!offer.content_hash || offer.content_hash.length !== 64) {
        provRes.incorrect++;
        provRes.issues.push({ id: offer.id, uniqueId: offer.unique_id, title, issue: 'Missing or invalid 64-char contentHash' });
      } else {
        provRes.correct++;
      }
    }

    // Determine source types for this bank
    const sourceTypes = bank === 'hnb' || bank === 'sampath' ? ['REST API JSON'] : ['HTML'];

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
        provenance: provRes,
      },
    };
  }

  // Summary printout
  console.log('========================================================================');
  console.log('REAL-WORLD FIELD EVALUATION BY BANK (Evidence Grounded)');
  console.log('========================================================================\n');

  for (const [bank, rep] of Object.entries(bankReports)) {
    console.log(`=== BANK: ${bank.toUpperCase()} (N = ${rep.sampleSize} offers) [Source: ${rep.sourceTypes.join(', ')}] ===`);
    for (const [fName, fRes] of Object.entries(rep.fields)) {
      const correctPct = Math.round((fRes.correct / fRes.sampleSize) * 100);
      const incorrectPct = Math.round((fRes.incorrect / fRes.sampleSize) * 100);
      const uncertainPct = Math.round(((fRes.sourceUncertain + fRes.systemUnresolved) / fRes.sampleSize) * 100);
      console.log(
        `  ${fName.padEnd(16)} | Correct: ${String(fRes.correct).padStart(3)} (${correctPct}%) | ` +
        `Incorrect: ${String(fRes.incorrect).padStart(3)} (${incorrectPct}%) | ` +
        `Uncertain/Unresolved: ${String(fRes.sourceUncertain + fRes.systemUnresolved).padStart(3)} (${uncertainPct}%) | ` +
        `N/A: ${fRes.notApplicable}`
      );
      if (fRes.issues.length > 0) {
        console.log(`     Sample issue: ${fRes.issues[0].issue} (ID: ${fRes.issues[0].uniqueId})`);
      }
    }
    console.log('');
  }

  console.log('========================================================================');
  console.log('SYSTEMIC ANOMALY TOTALS ACROSS ENTIRE REPOSITORY');
  console.log('========================================================================');
  console.log(`- Inverted Dates (validFrom > validTo): ${invertedDateOffers.length}`);
  console.log(`- Expired Active Offers (validTo < today & PUBLISHED): ${expiredPublishedOffers.length}`);
  console.log(`- Stored Generic Card Tokens in includedCards: ${genericTokensInIncludedCards.length}`);
  console.log(`- Marketing Titles Copied as Merchants: ${marketingTitleAsMerchantOffers.length}`);
  console.log(`- Broken Provenance / Source URLs: ${brokenProvenanceOffers.length}`);

  // Save detailed evaluation report to disk
  const reportPath = path.resolve(__dirname, 'evaluation-report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        totalOffers: allOffers.length,
        evaluatedAt: new Date().toISOString(),
        bankReports,
        anomalies: {
          invertedDates: invertedDateOffers,
          expiredPublished: expiredPublishedOffers,
          genericTokens: genericTokensInIncludedCards,
          marketingMerchants: marketingTitleAsMerchantOffers,
          brokenProvenance: brokenProvenanceOffers,
        },
      },
      null,
      2
    )
  );
  console.log(`\nDetailed evaluation artifact saved to ${reportPath}`);

  await auditPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
