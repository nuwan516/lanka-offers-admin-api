#!/usr/bin/env ts-node
/**
 * Renormalizes all offers in Postgres using updated parsers, period engine,
 * merchant extractors, card cleaners, and validator.
 *
 * Resolves:
 * - Inverted dates (valid_from > valid_to)
 * - Generic card tokens in includedCards
 * - Leaked non-card exclusions
 * - NSB marketing titles stored as merchants
 * - Expired offers lifecycle status (transitions valid_to < CURRENT_DATE to EXPIRED)
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/infrastructure/db/renormalize-offers.ts
 */

import 'dotenv/config';
import { pool, closePool } from './db-client';
import { parsePeriod } from '@/parsing/period/period-engine';
import { PeriodType, Offer } from '@/core/types/offers';
import { OfferValidator } from '@/parsing/validators/offer-validator';
import { extractMerchantName as extractNSBMerchant } from '@/banks/nsb/nsb-parser';
import { parseHNBDetail } from '@/banks/hnb/hnb-parser';
import { resolveCanonicalMerchant } from '@/domain/merchant-canonicalizer';
import { determineLocationScope } from '@/domain/location-scope';
import { reconcileExpiredOffers } from './offer-workflow-repository';

export interface RenormalizeResult {
  total: number;
  updated: number;
  invertedFixed: number;
  genericCardsCleaned: number;
  merchantImproved: number;
  hnbRecovered: number;
  hnbAmbiguousPreserved: number;
  locationsCleaned: number;
  canonicalAssigned: number;
  scopeAssigned: number;
  expiredReconciled: number;
}

export async function renormalizeAllOffers(): Promise<RenormalizeResult> {
  const rows = await pool.query<{
    id: string;
    unique_id: string;
    bank: string;
    title: string;
    merchant_name: string | null;
    merchant_location: string | null;
    valid_from: string | null;
    valid_to: string | null;
    card_eligibility: any;
    raw_offer: any;
    manual_override: any;
    db_status: string;
    canonical_merchant: string | null;
    location_scope: string | null;
  }>(`SELECT id, unique_id, bank, title, merchant_name, merchant_location, valid_from::text, valid_to::text, card_eligibility, raw_offer, manual_override, db_status, canonical_merchant, location_scope FROM offers`);

  console.log(`[Renormalize] Found ${rows.rows.length} offers in database.`);

  const validator = new OfferValidator();
  let updatedCount = 0;
  let invertedFixed = 0;
  let genericCardsCleaned = 0;
  let merchantImproved = 0;
  let hnbRecovered = 0;
  let hnbAmbiguousPreserved = 0;
  let locationsCleaned = 0;
  let canonicalAssigned = 0;
  let scopeAssigned = 0;

  for (const row of rows.rows) {
    const raw = row.raw_offer || {};
    const manual = row.manual_override || {};
    const b = (row.bank || '').toLowerCase();
    let hasChanges = false;

    // 1. Period reconciliation
    let newValidFrom = row.valid_from;
    let newValidTo = row.valid_to;
    const textForPeriod = raw.rawHtml || raw.offer?.description || row.title || '';
    if (textForPeriod) {
      const parsedPeriods = parsePeriod(textForPeriod, { defaultPeriodType: PeriodType.OFFER });
      if (parsedPeriods.length > 0) {
        const pf = parsedPeriods[0].validFrom ?? null;
        const pt = parsedPeriods[0].validTo ?? null;
        if (pf !== newValidFrom || pt !== newValidTo) {
          newValidFrom = pf;
          newValidTo = pt;
          hasChanges = true;
        }
      }
    }

    // Fix inverted dates
    if (newValidFrom && newValidTo && newValidFrom > newValidTo) {
      newValidFrom = null; // Un-fabricate inverted start date
      hasChanges = true;
      invertedFixed++;
    } else if (row.valid_from && row.valid_to && row.valid_from > row.valid_to) {
      invertedFixed++;
    }

    // 2. Card eligibility cleaning
    const incBefore: string[] = row.card_eligibility?.includedCards ?? raw.cardEligibility?.includedCards ?? [];
    const incAfter = incBefore.filter(
      (c: string) => !/^(?:credit|debit|credit\s*(?:\/|&)\s*debit|all\s+cards?|cards?)(?:\s+cards?)?$/i.test(c)
    );
    if (incBefore.length !== incAfter.length) {
      genericCardsCleaned++;
      hasChanges = true;
    }

    const excBefore: string[] = row.card_eligibility?.excludedCards ?? raw.cardEligibility?.excludedCards ?? [];
    const excAfter = excBefore.filter((c: string) => {
      if (/category|categories|packed|packeted|vegetable|produce|rice|sugar|flour|milk|liquor|tobacco|fuel|bill|service|tax|voucher/i.test(c)) {
        return false;
      }
      return !/^(?:and|or|cards?)$/i.test(c);
    });
    if (excBefore.length !== excAfter.length) {
      hasChanges = true;
    }

    const cleanedCardEligibility = {
      ...(row.card_eligibility || {}),
      includedCards: incAfter,
      excludedCards: excAfter,
    };

    // 3. Merchant normalization & recovery (respect manual override)
    let newMerchant = row.merchant_name;
    if (!manual.merchant_name) {
      if (b === 'nsb') {
        const desc = raw.offer?.description || '';
        const extracted = extractNSBMerchant(row.title, desc);
        if (extracted && extracted !== newMerchant) {
          newMerchant = extracted;
          merchantImproved++;
          hasChanges = true;
        }
      } else if (b === 'hnb') {
        const idMatch = row.unique_id.replace(/^hnb_/, '');
        try {
          const hnbParsed = parseHNBDetail(idMatch, { ...raw, content: raw.rawHtml }, row.title, 1);
          if (hnbParsed?.merchant?.name) {
            if (hnbParsed.merchant.name !== row.title) {
              if (hnbParsed.merchant.name !== newMerchant) {
                newMerchant = hnbParsed.merchant.name;
                merchantImproved++;
                hnbRecovered++;
                hasChanges = true;
              }
            } else {
              // Genuinely ambiguous promotional headline preserved
              hnbAmbiguousPreserved++;
            }
          }
        } catch {}
      }
    }

    // 4. Location cleaning & false precision elimination (respect manual override)
    let newLocation = row.merchant_location;
    if (!manual.merchant_location && newLocation) {
      const locTrim = newLocation.trim().toLowerCase();
      const titleTrim = (row.title || '').trim().toLowerCase();
      const merchTrim = (newMerchant || '').trim().toLowerCase();

      // Check if location is identical to title, merchant name, or generic card/payment tokens
      if (
        locTrim === titleTrim ||
        locTrim === merchTrim ||
        /^(?:mastercard|visa|credit|debit|all\s+cards?|cards?|commercial\s+bank|bank|hnb|boc|nsb)$/i.test(locTrim)
      ) {
        if (b === 'hnb') {
          const idMatch = row.unique_id.replace(/^hnb_/, '');
          const hnbParsed = parseHNBDetail(idMatch, { ...raw, content: raw.rawHtml }, row.title, 1);
          newLocation = hnbParsed?.merchant?.location ?? null;
        } else {
          newLocation = null;
        }
        if (newLocation !== row.merchant_location) {
          locationsCleaned++;
          hasChanges = true;
        }
      }
    }

    // 5. Canonical Merchant resolution (respect manual override)
    let canonicalMerchant: string | null = null;
    if (manual.canonical_merchant) {
      canonicalMerchant = manual.canonical_merchant;
    } else if (newMerchant) {
      const canonRes = resolveCanonicalMerchant(newMerchant);
      if (canonRes.isCanonical || canonRes.matchedAlias) {
        canonicalMerchant = canonRes.canonicalName;
      }
    }
    if (canonicalMerchant !== row.canonical_merchant) {
      canonicalAssigned++;
      hasChanges = true;
    }

    // 6. Location Scope determination (respect manual override)
    let locationScope = row.location_scope || 'UNRESOLVED';
    if (manual.location_scope) {
      locationScope = manual.location_scope;
    } else {
      const scopeRes = determineLocationScope({
        location: newLocation,
        title: row.title,
        description: raw.rawHtml || raw.description || raw.offer?.description || '',
        merchantName: newMerchant || '',
      });
      locationScope = scopeRes.scope;
    }
    if (locationScope !== row.location_scope) {
      scopeAssigned++;
      hasChanges = true;
    }

    // 7. Update raw_offer JSON structure
    const updatedRawOffer: Offer = {
      ...raw,
      uniqueId: row.unique_id,
      merchant: {
        ...(raw.merchant || {}),
        name: newMerchant,
        location: newLocation ?? undefined,
        canonicalName: canonicalMerchant ?? undefined,
      },
      locationScope: locationScope as any,
      validityPeriods: [
        {
          periodType: PeriodType.OFFER,
          validFrom: newValidFrom,
          validTo: newValidTo,
          raw: textForPeriod.slice(0, 200),
        },
      ],
      cardEligibility: cleanedCardEligibility,
    };

    // 8. Re-run validator
    const validation = validator.validate(updatedRawOffer);

    // 9. Persist if changes detected
    if (hasChanges) {
      await pool.query(
        `UPDATE offers
         SET valid_from = $1,
             valid_to = $2,
             merchant_name = $3,
             merchant_location = $4,
             canonical_merchant = $5,
             location_scope = $6,
             card_eligibility = $7,
             raw_offer = $8,
             rule_passed = $9,
             rule_errors = $10,
             rule_warnings = $11,
             updated_at = NOW()
         WHERE id = $12`,
        [
          newValidFrom,
          newValidTo,
          newMerchant,
          newLocation,
          canonicalMerchant,
          locationScope,
          JSON.stringify(cleanedCardEligibility),
          JSON.stringify(updatedRawOffer),
          validation.valid,
          JSON.stringify(validation.errors),
          JSON.stringify(validation.warnings),
          row.id,
        ]
      );
      updatedCount++;
    }
  }

  // 10. Reconcile expired offers
  const expiryResult = await reconcileExpiredOffers();

  console.log(`[Renormalize] Completed:`);
  console.log(` - Total Offers: ${rows.rows.length}`);
  console.log(` - Offers Updated: ${updatedCount}`);
  console.log(` - Inverted Dates Fixed: ${invertedFixed}`);
  console.log(` - Generic Cards Cleaned: ${genericCardsCleaned}`);
  console.log(` - Merchants Improved: ${merchantImproved}`);
  console.log(`   * HNB Merchants Recovered: ${hnbRecovered}`);
  console.log(`   * HNB Ambiguous Preserved: ${hnbAmbiguousPreserved}`);
  console.log(` - Bogus Locations Cleaned: ${locationsCleaned}`);
  console.log(` - Canonical Merchants Assigned: ${canonicalAssigned}`);
  console.log(` - Location Scopes Assigned: ${scopeAssigned}`);
  console.log(` - Expired Offers Reconciled to EXPIRED: ${expiryResult.expiredCount}`);

  return {
    total: rows.rows.length,
    updated: updatedCount,
    invertedFixed,
    genericCardsCleaned,
    merchantImproved,
    hnbRecovered,
    hnbAmbiguousPreserved,
    locationsCleaned,
    canonicalAssigned,
    scopeAssigned,
    expiredReconciled: expiryResult.expiredCount,
  };
}

async function main() {
  try {
    await renormalizeAllOffers();
  } catch (err) {
    console.error('[Renormalize] Fatal error:', err);
    process.exit(1);
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main();
}
