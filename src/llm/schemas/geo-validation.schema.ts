/**
 * Lanka Offers — Geo Validation Schema & Post-Validation Guards (Zod)
 *
 * Single source of truth: LocationScope comes from @/domain/location-scope.
 * All consistency rules that the Zod schema alone cannot express live here
 * so they cannot silently fail on a type or value mismatch.
 */

import { z } from 'zod';
import { LocationScope } from '@/domain/location-scope';

export const GeoValidationDecisionEnum = z.enum([
  'ACCEPT',
  'CORRECT',
  'REJECT',
  'NEEDS_MORE_EVIDENCE',
  'REVIEW_REQUIRED',
]);
export type GeoValidationDecision = z.infer<typeof GeoValidationDecisionEnum>;

/** Derived from the domain enum so the string values cannot drift. */
export const LocationScopeEnum = z.enum([
  LocationScope.EXPLICIT_BRANCH,
  LocationScope.MULTIPLE_BRANCHES,
  LocationScope.SELECTED_OUTLETS,
  LocationScope.DISTRICT_REGION,
  LocationScope.NATIONWIDE,
  LocationScope.ONLINE,
  LocationScope.UNRESOLVED,
]);

export const AddressQualityEnum = z.enum([
  'EXACT_ADDRESS',
  'BRANCH_OR_VENUE_NAME',
  'AREA_ONLY',
  'ONLINE_ONLY',
  'INVALID',
  'AMBIGUOUS',
]);

export const ProposedAddressItemSchema = z.object({
  address: z.string().trim().min(1, 'Address cannot be empty'),
  evidenceIds: z.array(z.string().min(1)).min(1, 'Must cite at least one evidenceId'),
  reason: z.string().trim().default(''),
});
export type ProposedAddressItem = z.infer<typeof ProposedAddressItemSchema>;

export const GeoValidationProposalSchema = z
  .object({
    decision: GeoValidationDecisionEnum,
    locationScope: LocationScopeEnum,
    addressQuality: AddressQualityEnum,
    merchantName: z.string().trim().optional(),
    proposedAddresses: z.array(ProposedAddressItemSchema).default([]),
    removedCandidates: z.array(z.string()).default([]),
    uncertainties: z.array(z.string()).default([]),
    needsGeocoding: z.boolean().default(false),
    needsHumanReview: z.boolean().default(false),
    reasoning: z.string().trim().optional(),
  })
  .strict(); // Extra undeclared properties are rejected by Zod itself.

export type GeoValidationProposal = z.infer<typeof GeoValidationProposalSchema>;

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedProposal: GeoValidationProposal | null;
}

/**
 * Validates raw LLM output against the schema + domain consistency rules.
 *
 * Note: the explicit coordinate / financial-field guards below overlap with
 * `.strict()` (which already rejects unknown keys). They are kept so that
 * the error messages stay CRITICAL and human-readable instead of a generic
 * "unrecognized key" from Zod.
 *
 * Evidence-ID checks for `removedCandidates` and `uncertainties` are intentionally
 * omitted: those fields are free-text human notes / rejected candidate strings,
 * not structured citations. Only `proposedAddresses[].evidenceIds` are required
 * to ground against the available evidence set.
 */
export function validateGeoValidationProposal(
  raw: unknown,
  availableEvidenceIds: string[],
): SchemaValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['LLM output is not an object'], sanitizedProposal: null };
  }

  const rawObj = raw as Record<string, unknown>;

  // Explicit guards (overlap with .strict() but give clearer CRITICAL messages).
  if ('latitude' in rawObj || 'longitude' in rawObj || 'lat' in rawObj || 'lng' in rawObj || 'coords' in rawObj) {
    errors.push('CRITICAL: LLM output contained prohibited coordinate fields');
  }
  if (
    'discountPercentage' in rawObj ||
    'minSpend' in rawObj ||
    'maxDiscount' in rawObj ||
    'validUntil' in rawObj ||
    'cardType' in rawObj
  ) {
    errors.push('CRITICAL: LLM output attempted to modify financial, card, or validity fields');
  }

  const parseResult = GeoValidationProposalSchema.safeParse(raw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      errors.push(`${issue.path.join('.') || 'root'}: ${issue.message}`);
    }
    return { valid: false, errors, sanitizedProposal: null };
  }

  const proposal = parseResult.data;
  const validEvIds = new Set(availableEvidenceIds);

  // Grounding: proposed address evidence IDs must exist.
  for (let i = 0; i < proposal.proposedAddresses.length; i++) {
    const item = proposal.proposedAddresses[i];
    for (const evId of item.evidenceIds) {
      if (!validEvIds.has(evId)) {
        errors.push(`proposedAddresses[${i}] cited nonexistent evidenceId: "${evId}"`);
      }
    }
  }

  // Consistency: ACCEPT / CORRECT must propose at least one address.
  if (
    (proposal.decision === 'ACCEPT' || proposal.decision === 'CORRECT') &&
    proposal.proposedAddresses.length === 0
  ) {
    errors.push('ACCEPT or CORRECT requires at least one proposed address');
  }

  // Consistency: ONLINE scope cannot claim an exact physical address.
  if (proposal.locationScope === LocationScope.ONLINE && proposal.addressQuality === 'EXACT_ADDRESS') {
    errors.push('ONLINE location scope cannot have addressQuality EXACT_ADDRESS');
  }

  // Consistency: ACCEPT cannot also request human review.
  if (proposal.decision === 'ACCEPT' && proposal.needsHumanReview) {
    errors.push('ACCEPT decision cannot set needsHumanReview=true');
  }

  // Existing anti-hallucination rules.
  if (proposal.addressQuality === 'AREA_ONLY' && proposal.needsGeocoding) {
    errors.push('CRITICAL: AREA_ONLY address cannot request exact geocoding');
  }
  if (proposal.locationScope === LocationScope.ONLINE && proposal.proposedAddresses.length > 0) {
    errors.push('ONLINE location scope cannot have physical proposed addresses');
  }

  if (errors.length > 0) {
    return { valid: false, errors, sanitizedProposal: null };
  }

  return { valid: true, errors: [], sanitizedProposal: proposal };
}
