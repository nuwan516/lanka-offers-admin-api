import { Offer } from '@/core/types/offers';
import { ValidationResult, FieldError } from '@/core/types/validation';

// ─── Date validation ──────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(d: string | null): boolean {
  if (!d) return true; // null is allowed
  if (!ISO_DATE_RE.test(d)) return false;
  const parsed = new Date(d);
  return !isNaN(parsed.getTime());
}

// ─── OfferValidator ───────────────────────────────────────────────────────────

/**
 * Rule-based validator for scraped Offer objects.
 *
 * Checks:
 * - Required fields are present (uniqueId, source, title, scrapedAt)
 * - Date formats are YYYY-MM-DD
 * - Discount percentage is 0–100 (or null)
 * - At least one merchant address or location exists
 * - Transaction range amounts are positive
 * - Content hash is a 64-char hex string (sha256)
 *
 * Returns a ValidationResult — never throws.
 */
export class OfferValidator {
  validate(offer: Offer): ValidationResult {
    const errors: FieldError[] = [];
    const warnings: FieldError[] = [];

    // ── Required fields ─────────────────────────────────────────────────────
    if (!offer.uniqueId) {
      errors.push({ field: 'uniqueId', message: 'uniqueId is required', severity: 'error' });
    }
    if (!offer.source) {
      errors.push({ field: 'source', message: 'source is required', severity: 'error' });
    }
    if (!offer.title || offer.title.trim().length === 0) {
      errors.push({ field: 'title', message: 'title is required', severity: 'error' });
    }
    if (!offer.scrapedAt) {
      errors.push({ field: 'scrapedAt', message: 'scrapedAt is required', severity: 'error' });
    }

    // ── Validity periods ────────────────────────────────────────────────────
    for (const [i, period] of offer.validityPeriods.entries()) {
      if (period.validFrom && !isValidDate(period.validFrom)) {
        errors.push({
          field: `validityPeriods[${i}].validFrom`,
          message: `Invalid date format: "${period.validFrom}" (expected YYYY-MM-DD)`,
          severity: 'error',
        });
      }
      if (period.validTo && !isValidDate(period.validTo)) {
        errors.push({
          field: `validityPeriods[${i}].validTo`,
          message: `Invalid date format: "${period.validTo}" (expected YYYY-MM-DD)`,
          severity: 'error',
        });
      }
      if (period.validFrom && period.validTo && period.validFrom > period.validTo) {
        errors.push({
          field: `validityPeriods[${i}]`,
          message: `validFrom (${period.validFrom}) is after validTo (${period.validTo})`,
          severity: 'error',
        });
      }
    }

    // ── Expired offers ───────────────────────────────────────────────────────
    // Banks leave dead offers on their sites; an offer whose every dated
    // period has already ended must not reach publication.
    const today = new Date().toISOString().split('T')[0];
    const datedPeriods = offer.validityPeriods.filter((p) => p.validTo && isValidDate(p.validTo));
    if (datedPeriods.length > 0 && datedPeriods.every((p) => p.validTo! < today)) {
      errors.push({
        field: 'validityPeriods',
        message: `Offer is fully expired (latest validTo ${datedPeriods.map((p) => p.validTo).sort().at(-1)} < ${today})`,
        severity: 'error',
      });
    }

    // ── Discount percentage ─────────────────────────────────────────────────
    const disc = offer.offer.discountPercentage;
    if (disc !== null && typeof disc === 'number') {
      if (disc < 0 || disc > 100) {
        warnings.push({
          field: 'offer.discountPercentage',
          message: `Discount ${disc}% is outside the 0–100 range`,
          severity: 'warning',
        });
      }
    }

    // ── Merchant presence ────────────────────────────────────────────────────
    if (!offer.merchant.name || offer.merchant.name.trim().length === 0) {
      warnings.push({
        field: 'merchant.name',
        message: 'Merchant name is empty',
        severity: 'warning',
      });
    }
    if (!offer.merchant.location && offer.merchant.addresses.length === 0) {
      warnings.push({
        field: 'merchant',
        message: 'No merchant location or addresses — geocoding will rely on name only',
        severity: 'warning',
      });
    }

    // ── Transaction range ─────────────────────────────────────────────────────
    const { min, max } = offer.transactionRange;
    if (min !== null && min < 0) {
      errors.push({
        field: 'transactionRange.min',
        message: `Transaction min (${min}) cannot be negative`,
        severity: 'error',
      });
    }
    if (max !== null && max < 0) {
      errors.push({
        field: 'transactionRange.max',
        message: `Transaction max (${max}) cannot be negative`,
        severity: 'error',
      });
    }
    if (min !== null && max !== null && min > max) {
      warnings.push({
        field: 'transactionRange',
        message: `min (${min}) > max (${max})`,
        severity: 'warning',
      });
    }

    // ── Content hash ──────────────────────────────────────────────────────────
    if (offer.contentHash && !/^[a-f0-9]{64}$/.test(offer.contentHash)) {
      warnings.push({
        field: 'contentHash',
        message: 'contentHash does not look like a sha256 hex string',
        severity: 'warning',
      });
    }

    // ── Category ──────────────────────────────────────────────────────────────
    if (!offer.category || offer.category.trim().length === 0) {
      warnings.push({
        field: 'category',
        message: 'category is empty',
        severity: 'warning',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** Validate a batch of offers. Returns only those with valid=false. */
  validateBatch(offers: Offer[]): Array<{ offer: Offer; result: ValidationResult }> {
    return offers
      .map((offer) => ({ offer, result: this.validate(offer) }))
      .filter(({ result }) => !result.valid || result.warnings.length > 0);
  }
}
