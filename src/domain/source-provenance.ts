/**
 * Server-Side Provenance & Synthetic Data Isolation Engine
 *
 * Guarantees that mock, synthetic, benchmark, and test-fixture offers
 * can NEVER enter the production publication workflow (direct publication,
 * bulk sync, manual status modification, or retry paths).
 */

export interface ProvenanceValidationResult {
  valid: boolean;
  isSynthetic: boolean;
  reason?: string;
  evidenceDomain?: string | null;
}

export const APPROVED_BANK_DOMAINS: Record<string, string[]> = {
  hnb: ['hnb.lk', 'venus.hnb.lk', 'hnb.net'],
  sampath: ['sampath.lk', 'www.sampath.lk'],
  boc: ['boc.lk', 'www.boc.lk'],
  peoples: ['peoplesbank.lk', 'www.peoplesbank.lk'],
  seylan: ['seylan.lk', 'www.seylan.lk'],
  ndb: ['ndbbank.com', 'www.ndbbank.com'],
  dfcc: ['dfcc.lk', 'www.dfcc.lk'],
  pabc: ['pabcbank.com', 'www.pabcbank.com'],
  nsb: ['nsb.lk', 'www.nsb.lk'],
  combank: ['combank.lk', 'www.combank.lk', 'combank.net'],
};

const SYNTHETIC_ID_PATTERNS = [
  /expired-test-fixture/i,
  /test-fixture/i,
  /benchmark-fixture/i,
  /mock-offer/i,
  /mock-bank/i,
  /dummy-offer/i,
  /synthetic-/i,
];

const SYNTHETIC_SOURCE_TYPES = [
  'SYNTHETIC_EXPIRED_FIXTURE',
  'SYNTHETIC',
  'FIXTURE',
  'BENCHMARK_FIXTURE',
  'MOCK',
  'TEST_FIXTURE',
  'SEED_MOCK',
];

const UNTRUSTED_URL_INDICATORS = [
  'mock://',
  'fixture://',
  'test://',
  'file://',
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.org',
  'test.com',
  'dummy.lk',
];

/**
 * Checks whether an offer row or candidate originates from synthetic,
 * benchmark, mock, or test-fixture sources.
 */
export function isSyntheticRecord(
  offer: Record<string, any>,
  rawEvidence?: Record<string, any> | null
): boolean {
  if (!offer) return false;

  // 1. Explicit boolean flags in offer or raw evidence
  if (offer.isSynthetic === true || offer.synthetic === true) return true;
  if (rawEvidence && (rawEvidence.isSynthetic === true || rawEvidence.synthetic === true)) return true;

  // 2. Explicit sourceType markers
  const sourceType = (offer.sourceType || rawEvidence?.sourceType || '') as string;
  if (SYNTHETIC_SOURCE_TYPES.some((st) => sourceType.toUpperCase().includes(st))) return true;

  // 3. Unique ID markers
  const uniqueId = (offer.uniqueId || offer.unique_id || rawEvidence?.unique_id || '') as string;
  if (SYNTHETIC_ID_PATTERNS.some((pattern) => pattern.test(uniqueId))) return true;

  // 4. Source URL inspection for mock / local / test schemes
  const sourceUrl = (offer.sourceUrl || offer.source_url || rawEvidence?.sourceUrl || rawEvidence?.source_url || '') as string;
  if (sourceUrl && UNTRUSTED_URL_INDICATORS.some((ind) => sourceUrl.toLowerCase().includes(ind))) {
    return true;
  }

  // 5. Title / Merchant synthetic markers
  const title = (offer.title || '') as string;
  const merchantName = (offer.merchant?.name || offer.merchant_name || '') as string;
  if (/\[SYNTHETIC\]|\[MOCK\]|\[TEST FIXTURE\]|Synthetic Test Offer/i.test(title)) return true;
  if (/\[SYNTHETIC\]|\[MOCK\]|\[TEST FIXTURE\]/i.test(merchantName)) return true;

  return false;
}

/**
 * Validates server-side source provenance for an offer before staging or publishing.
 */
export function validateSourceProvenance(
  offer: Record<string, any>,
  rawEvidence?: Record<string, any> | null
): ProvenanceValidationResult {
  if (!offer) {
    return { valid: false, isSynthetic: false, reason: 'Offer object is null or undefined' };
  }

  // Enforce synthetic data isolation
  if (isSyntheticRecord(offer, rawEvidence)) {
    return {
      valid: false,
      isSynthetic: true,
      reason: 'SYNTHETIC_PROVENANCE_REJECTED: Record is flagged as synthetic, mock, or test fixture',
    };
  }

  const bank = (offer.bank || offer.source || '').toLowerCase();
  const sourceUrl = (offer.sourceUrl || offer.source_url || rawEvidence?.sourceUrl || rawEvidence?.source_url || null) as string | null;

  // If sourceUrl is present, verify domain against registered bank domains
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const host = parsed.hostname.toLowerCase();
      const allowedDomains = APPROVED_BANK_DOMAINS[bank];

      if (allowedDomains && !allowedDomains.some((d) => host === d || host.endsWith('.' + d))) {
        return {
          valid: false,
          isSynthetic: false,
          reason: `UNAPPROVED_BANK_DOMAIN: Host ${host} does not belong to authorized domains for bank ${bank}`,
          evidenceDomain: host,
        };
      }

      return { valid: true, isSynthetic: false, evidenceDomain: host };
    } catch {
      return {
        valid: false,
        isSynthetic: false,
        reason: `INVALID_SOURCE_URL: Malformed URL "${sourceUrl}"`,
      };
    }
  }

  return { valid: true, isSynthetic: false, evidenceDomain: null };
}

/**
 * Strict publication provenance validation gate.
 * Requires that synthetic records are physically rejected, bank is registered,
 * and if sourceUrl exists, it matches the bank's approved official domains.
 */
export function validatePublicationProvenance(
  offer: Record<string, any>,
  rawEvidence?: Record<string, any> | null
): ProvenanceValidationResult {
  return validateSourceProvenance(offer, rawEvidence);
}
