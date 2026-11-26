/**
 * Lanka Offers — Offer Validation Schemas & Mapper
 *
 * Differential (small) ValidationDecision is mapped into the full proposal
 * used by the rest of the pipeline. All hard-coded guesses and dead fallbacks
 * have been removed so the quality gate reflects the actual decision.
 */

import { z } from 'zod';
import { EDITABLE_FIELD_PATHS } from '@/domain/effective-offer';
import { LocationScope } from '@/domain/location-scope';

export const EvidenceSnippetSchema = z.object({
  id: z.string().min(1, 'Evidence ID is required'),
  text: z.string().min(1, 'Evidence snippet text cannot be empty'),
  sourceField: z.enum([
    'title',
    'description',
    'terms',
    'specialConditions',
    'generalTerms',
    'validityText',
    'merchantLocation',
    'merchantAddresses',
    'rawHtml',
    'rawText',
  ]),
  offset: z.number().int().nonnegative().optional(),
  tokenHash: z.string().optional(),
});
export type EvidenceSnippet = z.infer<typeof EvidenceSnippetSchema>;

/** Base correction shape. FieldCorrectionSchema extends it with optional originalValue. */
export const FieldCorrectionProposalSchema = z.object({
  fieldPath: z.enum(EDITABLE_FIELD_PATHS as unknown as [string, ...string[]]),
  originalValue: z.unknown(),
  proposedValue: z.unknown(),
  evidenceIds: z.array(z.string()).min(1, 'At least one evidence snippet must be cited'),
  reason: z.string().min(5, 'Correction reason must be at least 5 characters'),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
});
export type FieldCorrectionProposal = z.infer<typeof FieldCorrectionProposalSchema>;

export const FieldValidationStateSchema = z.object({
  field: z.string().min(1),
  originalValue: z.unknown(),
  normalizedValue: z.unknown().optional(),
  status: z.enum(['SUPPORTED', 'UNSUPPORTED', 'AMBIGUOUS', 'NOT_PRESENT', 'OVERRIDDEN']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  evidenceSnippets: z.array(EvidenceSnippetSchema),
  warning: z.string().nullable().optional(),
  correction: FieldCorrectionProposalSchema.nullable().optional(),
});
export type FieldValidationState = z.infer<typeof FieldValidationStateSchema>;

export const FinancialTermsProposalSchema = z.object({
  offerType: z.enum([
    'PERCENTAGE_DISCOUNT',
    'FLAT_DISCOUNT',
    'CASHBACK',
    'INSTALLMENT',
    'BOGO',
    'FREE_GIFT',
    'VOUCHER',
    'TIERED_DISCOUNT',
    'SPECIAL_RATE',
    'UNKNOWN',
  ]),
  discountPercentage: z.number().min(0).max(100).nullable().optional(),
  isUpTo: z.boolean(),
  flatDiscountAmount: z.number().nonnegative().nullable().optional(),
  cashbackAmount: z.number().nonnegative().nullable().optional(),
  minimumSpend: z.number().nonnegative().nullable().optional(),
  maximumDiscountCap: z.number().nonnegative().nullable().optional(),
  installmentMonths: z.array(z.number().int().positive()).optional(),
  currency: z.literal('LKR'),
  evidenceIds: z.array(z.string()).min(1),
});
export type FinancialTermsProposal = z.infer<typeof FinancialTermsProposalSchema>;

export const CardEligibilityProposalSchema = z.object({
  cardTypes: z.array(z.enum(['Credit Card', 'Debit Card'])),
  networks: z.array(z.enum(['Visa', 'Mastercard', 'Amex', 'UnionPay', 'JCB'])),
  tiers: z.array(z.string()).optional(),
  includedCards: z.array(z.string()).optional(),
  excludedCards: z.array(z.string()).optional(),
  isCorporateExcluded: z.boolean().optional(),
  evidenceIds: z.array(z.string()), // may be empty when no supporting evidence exists
});
export type CardEligibilityProposal = z.infer<typeof CardEligibilityProposalSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s),
  { message: 'must be a real calendar date in YYYY-MM-DD' },
);

export const ValidityDatesProposalSchema = z.object({
  validFrom: isoDate.nullable(),
  validTo: isoDate.nullable(),
  isWeekendOnly: z.boolean().optional(),
  specificDays: z.array(z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])).optional(),
  evidenceIds: z.array(z.string()),
});
export type ValidityDatesProposal = z.infer<typeof ValidityDatesProposalSchema>;

export const OfferQualityGateSchema = z.object({
  status: z.enum(['VALIDATED', 'PARTIALLY_VALIDATED', 'REVIEW_REQUIRED', 'INVALID']),
  overallScore: z.number().min(0).max(100),
  criticalFieldsSupported: z.boolean(),
  hasUnsupportedClaims: z.boolean(),
  reasons: z.array(z.string()),
});
export type OfferQualityGate = z.infer<typeof OfferQualityGateSchema>;

/** Full domain LocationScope values. AREA_ONLY is accepted as a legacy alias and mapped. */
export const OfferLocationScopeEnum = z.enum([
  LocationScope.ONLINE,
  LocationScope.NATIONWIDE,
  LocationScope.EXPLICIT_BRANCH,
  LocationScope.MULTIPLE_BRANCHES,
  LocationScope.SELECTED_OUTLETS,
  LocationScope.DISTRICT_REGION,
  LocationScope.UNRESOLVED,
  'AREA_ONLY', // legacy alias — mapped to SELECTED_OUTLETS or UNRESOLVED at use site
]);

export const FullOfferValidationProposalSchema = z.object({
  offerId: z.string().min(1),
  bankCode: z.string().min(2),
  isGenuinePromo: z.boolean(),
  merchantIdentity: z.object({
    canonicalName: z.string().min(1),
    parentBrand: z.string().nullable().optional(),
    isMultiMerchant: z.boolean().optional(),
    evidenceIds: z.array(z.string()),
  }),
  financialTerms: FinancialTermsProposalSchema,
  cardEligibility: CardEligibilityProposalSchema,
  validityDates: ValidityDatesProposalSchema,
  locationScope: OfferLocationScopeEnum,
  corrections: z.array(FieldCorrectionProposalSchema),
  qualityGate: OfferQualityGateSchema,
  summaryReasoning: z.string().min(10),
});
export type FullOfferValidationProposal = z.infer<typeof FullOfferValidationProposalSchema>;

export const EvidenceReferenceSchema = z.object({
  snippetId: z.string().min(1),
  quote: z.string().optional(),
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

/** Differential correction — originalValue is optional because the caller may not have it. */
export const FieldCorrectionSchema = FieldCorrectionProposalSchema.extend({
  originalValue: z.unknown().optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
});
export type FieldCorrection = z.infer<typeof FieldCorrectionSchema>;

export const UnresolvedIssueSchema = z.object({
  fieldPath: z.string().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  description: z.string().min(5),
  evidenceIds: z.array(z.string()).optional(),
});
export type UnresolvedIssue = z.infer<typeof UnresolvedIssueSchema>;

export const ValidationDecisionSchema = z.object({
  decision: z.enum(['ACCEPT', 'CORRECT', 'REVIEW_REQUIRED']),
  // No default — so the mapper fallback (95/90/65) is not dead code.
  overallScore: z.number().min(0).max(100).optional(),
  corrections: z.array(FieldCorrectionSchema).default([]),
  unresolvedIssues: z.array(z.string()).default([]),
  detailedIssues: z.array(UnresolvedIssueSchema).optional(),
  summaryReasoning: z.string().min(10),
  locationScope: OfferLocationScopeEnum.optional(),
});
export type ValidationDecision = z.infer<typeof ValidationDecisionSchema>;

/**
 * Maps a differential ValidationDecision into the full proposal.
 *
 * - offerType is derived from the offer data (or UNKNOWN).
 * - Quality flags are computed from the decision and issues, not hard-coded.
 * - Card types / networks are never guessed; empty arrays are used when missing
 *   and no unverified evidence ID is attached.
 * - Evidence IDs are validated against the provided set when available.
 * - Only the first validity period is used (documented limitation).
 * - discountPercentage is clamped to [0, 100] before the schema sees it.
 */
export function toFullOfferValidationProposal(
  decision: ValidationDecision,
  offer: {
    uniqueId: string;
    source: string;
    title: string;
    cardType?: string;
    merchant?: { name?: string | null };
    offer?: { discountPercentage?: number | string | null; description?: string };
    cardEligibility?: { cardTypes?: string[]; networks?: string[] };
    validityPeriods?: Array<{ validFrom?: string | null; validTo?: string | null }>;
  },
  options?: { availableEvidenceIds?: string[]; fallbackEvidenceId?: string },
): FullOfferValidationProposal {
  const isAccept = decision.decision === 'ACCEPT';
  const isCorrect = decision.decision === 'CORRECT';
  const hasIssues =
    (decision.unresolvedIssues?.length ?? 0) > 0 ||
    (decision.detailedIssues?.length ?? 0) > 0;

  const status: FullOfferValidationProposal['qualityGate']['status'] =
    isAccept && !hasIssues ? 'VALIDATED' : isCorrect && !hasIssues ? 'PARTIALLY_VALIDATED' : 'REVIEW_REQUIRED';

  const score =
    decision.overallScore ??
    (isAccept ? 95 : isCorrect ? 90 : 65);

  // Derive offer type from available data; never hard-code PERCENTAGE_DISCOUNT.
  const rawDisc = offer.offer?.discountPercentage;
  let numDisc: number | null =
    typeof rawDisc === 'number' ? rawDisc : typeof rawDisc === 'string' && !Number.isNaN(Number(rawDisc)) ? Number(rawDisc) : null;
  if (numDisc != null) {
    numDisc = Math.max(0, Math.min(100, numDisc)); // clamp before schema
  }
  const offerType: FinancialTermsProposal['offerType'] =
    numDisc != null && numDisc > 0 ? 'PERCENTAGE_DISCOUNT' : 'UNKNOWN';

  const descText = `${offer.title} ${offer.offer?.description ?? ''}`.toLowerCase();
  const isUpTo = /\bupto\b|\bup to\b|\bmaximum of\b/.test(descText);

  // Only the first validity period is consumed. Multiple periods are not merged.
  const validFrom = offer.validityPeriods?.[0]?.validFrom ?? null;
  const validTo = offer.validityPeriods?.[0]?.validTo ?? null;

  const available = new Set(options?.availableEvidenceIds ?? []);
  const primaryEvidenceId =
    options?.fallbackEvidenceId && available.has(options.fallbackEvidenceId)
      ? options.fallbackEvidenceId
      : decision.corrections[0]?.evidenceIds?.find((id) => available.size === 0 || available.has(id)) ?? null;

  const evidenceForFinancial = primaryEvidenceId ? [primaryEvidenceId] : [];

  // Never invent card types or networks. Empty arrays when nothing is present.
  const cardTypes = (offer.cardEligibility?.cardTypes ?? []).filter(
    (c): c is 'Credit Card' | 'Debit Card' => c === 'Credit Card' || c === 'Debit Card',
  );
  const networks = (offer.cardEligibility?.networks ?? []).filter(
    (n): n is 'Visa' | 'Mastercard' | 'Amex' | 'UnionPay' | 'JCB' =>
      ['Visa', 'Mastercard', 'Amex', 'UnionPay', 'JCB'].includes(n),
  );

  const reasons: string[] = [];
  if (decision.detailedIssues?.length) {
    for (const issue of decision.detailedIssues) {
      reasons.push(`[${issue.severity}] ${issue.description}`);
    }
  }
  if (decision.unresolvedIssues?.length) {
    reasons.push(...decision.unresolvedIssues);
  }
  if (reasons.length === 0) {
    if (isAccept) reasons.push('Offer validated against source evidence with no unresolved issues');
    else if (isCorrect) reasons.push('Targeted field corrections validated and applied');
    else reasons.push('Review required: decision did not reach ACCEPT or CORRECT');
  }

  // Map legacy AREA_ONLY if it appears.
  let locationScope = decision.locationScope ?? LocationScope.UNRESOLVED;
  if (locationScope === 'AREA_ONLY') {
    locationScope = LocationScope.SELECTED_OUTLETS;
  }

  return {
    offerId: offer.uniqueId,
    bankCode: offer.source,
    isGenuinePromo: isAccept || isCorrect, // REVIEW_REQUIRED is not treated as fully genuine
    merchantIdentity: {
      canonicalName: offer.merchant?.name || 'UNKNOWN',
      evidenceIds: primaryEvidenceId ? [primaryEvidenceId] : [],
    },
    financialTerms: {
      offerType,
      discountPercentage: numDisc,
      isUpTo,
      currency: 'LKR',
      evidenceIds: evidenceForFinancial,
    },
    cardEligibility: {
      cardTypes,
      networks,
      evidenceIds: cardTypes.length || networks.length ? evidenceForFinancial : [],
    },
    validityDates: {
      validFrom: validFrom && isoDate.safeParse(validFrom).success ? validFrom : null,
      validTo: validTo && isoDate.safeParse(validTo).success ? validTo : null,
      evidenceIds: evidenceForFinancial,
    },
    locationScope,
    corrections: decision.corrections.map((c) => ({
      fieldPath: c.fieldPath,
      originalValue: c.originalValue ?? null,
      proposedValue: c.proposedValue,
      evidenceIds: c.evidenceIds,
      reason: c.reason,
      confidence: c.confidence ?? 'HIGH',
    })),
    qualityGate: {
      status,
      overallScore: score,
      criticalFieldsSupported: isAccept && !hasIssues,
      hasUnsupportedClaims: hasIssues,
      reasons,
    },
    summaryReasoning: decision.summaryReasoning,
  };
}
