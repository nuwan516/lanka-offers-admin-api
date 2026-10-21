/**
 * Lanka Offers — Geo Validation Schema & Post-Validation Guards (Zod-Powered)
 *
 * Implements Section 8 of the Intelligent Address Validation Pipeline using Zod.
 * Enforces strict structural, safety, evidence grounding, and anti-hallucination constraints.
 */

import { z } from 'zod';
import { LocationScope } from '@/domain/location-scope';
import { AddressQuality } from '@/geo/address-quality';

// ─── Zod Enums & Schemas ───────────────────────────────────────────────────────

export const GeoValidationDecisionEnum = z.enum([
  'ACCEPT',
  'CORRECT',
  'REJECT',
  'NEEDS_MORE_EVIDENCE',
  'REVIEW_REQUIRED',
]);
export type GeoValidationDecision = z.infer<typeof GeoValidationDecisionEnum>;

export const LocationScopeEnum = z.enum([
  'EXPLICIT_BRANCH',
  'MULTIPLE_BRANCHES',
  'SELECTED_OUTLETS',
  'DISTRICT_REGION',
  'NATIONWIDE',
  'ONLINE',
  'UNRESOLVED',
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
  .strict(); // Disallow extra undeclared root properties

export type GeoValidationProposal = z.infer<typeof GeoValidationProposalSchema>;

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedProposal: GeoValidationProposal | null;
}

// ─── Deterministic Post-Validation & Safety Guards ────────────────────────────

/**
 * Validates raw parsed LLM response against strict Zod schema and evidence grounding constraints.
 */
export function validateGeoValidationProposal(
  raw: unknown,
  availableEvidenceIds: string[]
): SchemaValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['LLM output is not an object'], sanitizedProposal: null };
  }

  const rawObj = raw as Record<string, unknown>;

  // 1. Critical safety guard: reject hallucinated/fabricated coordinates
  if ('latitude' in rawObj || 'longitude' in rawObj || 'lat' in rawObj || 'lng' in rawObj || 'coords' in rawObj) {
    errors.push('CRITICAL: LLM output contained prohibited coordinate fields');
  }

  // 2. Critical safety guard: prohibit modifying non-geo financial / validity fields
  if (
    'discountPercentage' in rawObj ||
    'minSpend' in rawObj ||
    'maxDiscount' in rawObj ||
    'validUntil' in rawObj ||
    'cardType' in rawObj
  ) {
    errors.push('CRITICAL: LLM output attempted to modify financial, card, or validity fields');
  }

  // 3. Zod Schema parse
  const parseResult = GeoValidationProposalSchema.safeParse(raw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      errors.push(`${issue.path.join('.') || 'root'}: ${issue.message}`);
    }
    return { valid: false, errors, sanitizedProposal: null };
  }

  const proposal = parseResult.data;

  // 4. Grounding Check: all cited evidenceIds must exist in available evidence snippets
  const validEvIds = new Set(availableEvidenceIds);
  for (let i = 0; i < proposal.proposedAddresses.length; i++) {
    const item = proposal.proposedAddresses[i];
    for (const evId of item.evidenceIds) {
      if (!validEvIds.has(evId)) {
        errors.push(`proposedAddresses[${i}] cited nonexistent evidenceId: "${evId}"`);
      }
    }
  }

  // 5. Anti-hallucination guard: AREA_ONLY must NEVER request geocoding to exact pin
  if (proposal.addressQuality === 'AREA_ONLY' && proposal.needsGeocoding) {
    errors.push('CRITICAL: AREA_ONLY address cannot request exact geocoding');
  }

  // 6. ONLINE location scope cannot have physical proposed addresses
  if (proposal.locationScope === LocationScope.ONLINE && proposal.proposedAddresses.length > 0) {
    errors.push('ONLINE location scope cannot have physical proposed addresses');
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      sanitizedProposal: null,
    };
  }

  return {
    valid: true,
    errors: [],
    sanitizedProposal: proposal,
  };
}
