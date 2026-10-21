/**
 * Lanka Offers — Geo Correction Validator & Audit Patch Generator
 *
 * Implements Section 9 of the Intelligent Address Validation Pipeline.
 * Validates proposed corrections against deterministic rules and source evidence,
 * producing safe audit patch objects without mutating original offers or financial fields.
 */

import { Offer } from '@/core/types/offers';
import { GeoOfferContext } from '@/geo/geo-evidence';
import { GeoValidationProposal } from '@/llm/schemas/geo-validation.schema';
import { assessAddressQuality } from '@/geo/address-quality';

export interface GeoCorrectionPatch {
  offerId: string;
  originalValue: {
    merchantName: string;
    addresses: string[];
    locationScope: string;
    rawLocation: string | null;
  };
  proposedValue: {
    merchantName?: string;
    addresses: string[];
    locationScope: string;
  };
  evidenceReferences: string[];
  validatorOutcome: 'ACCEPTED' | 'REJECTED' | 'MODIFIED_SAFE';
  validationErrors: string[];
  validationWarnings: string[];
  modelIdentifier: string;
  attemptCount: number;
  reason: string;
  timestamp: string;
}

export class GeoCorrectionValidator {
  /**
   * Validates a proposed correction against the original offer and evidence.
   */
  static validateProposal(
    proposal: GeoValidationProposal,
    context: GeoOfferContext,
    completeRawSource?: string,
    modelId = 'unknown-model',
    attemptCount = 1
  ): GeoCorrectionPatch {
    const originalAddresses = context.extractedGeo.candidateAddresses;
    const proposedAddresses = proposal.proposedAddresses.map((p) => p.address.trim());
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Evidence Grounding Check
    // All evidence IDs cited in the proposal must exist in the context
    const validEvIds = new Set(context.sourceEvidence.relevantSnippets.map((s) => s.id));
    const citedEvIds: string[] = [];

    for (const p of proposal.proposedAddresses) {
      for (const evId of p.evidenceIds) {
        citedEvIds.push(evId);
        if (!validEvIds.has(evId)) {
          errors.push(`Cited evidenceId "${evId}" not found in provided source snippets`);
        }
      }
    }

    // 2. Textual Grounding Check
    // The proposed address text must have grounded token overlap with the raw text/snippets
    const combinedEvidenceText = [
      ...context.sourceEvidence.relevantSnippets.map((s) => s.text),
      completeRawSource ?? '',
      context.offer.title,
      context.offer.description ?? '',
      ...context.offer.terms,
    ].join(' ').toLowerCase();

    for (const addr of proposedAddresses) {
      const tokens = addr
        .toLowerCase()
        .replace(/sri\s+lanka/g, '')
        .split(/[\s,]+/)
        .filter((t) => t.length >= 4);

      if (tokens.length > 0) {
        const matchingTokens = tokens.filter((t) => combinedEvidenceText.includes(t));
        const overlap = matchingTokens.length / tokens.length;
        if (overlap < 0.4) {
          errors.push(`Proposed address "${addr.slice(0, 30)}" lacks sufficient textual evidence in raw source (grounding ratio: ${Math.round(overlap * 100)}%)`);
        }
      }
    }

    // 3. Prohibit converting AREA_ONLY to an exact branch without evidence
    if (context.extractedGeo.addressQuality === 'AREA_ONLY' && proposal.addressQuality === 'EXACT_ADDRESS') {
      const hasExplicitNewEvidence = proposal.proposedAddresses.some((p) =>
        /\b(?:No\.?\s*\d+|Road|Street|Mawatha|Lane|Junction)\b/i.test(p.address)
      );
      if (!hasExplicitNewEvidence) {
        errors.push('Cannot promote AREA_ONLY to EXACT_ADDRESS without explicit street or number evidence');
      }
    }

    // 4. Validate quality of proposed addresses
    const qualityAssessment = assessAddressQuality({
      candidateAddresses: proposedAddresses,
      merchantName: proposal.merchantName ?? context.merchant.name,
      rawText: combinedEvidenceText,
    });

    if (qualityAssessment.quality === 'INVALID') {
      errors.push(`Proposed address evaluated to INVALID quality: ${qualityAssessment.reasons.join(', ')}`);
    }

    // 5. Final Outcome
    let outcome: 'ACCEPTED' | 'REJECTED' | 'MODIFIED_SAFE' = 'ACCEPTED';
    let safeAddresses = proposedAddresses;

    if (errors.length > 0) {
      outcome = 'REJECTED';
      safeAddresses = originalAddresses; // Fall back to original
    } else if (qualityAssessment.cleanAddresses.length > 0 && qualityAssessment.cleanAddresses.length !== proposedAddresses.length) {
      outcome = 'MODIFIED_SAFE';
      safeAddresses = qualityAssessment.cleanAddresses;
      warnings.push('Sanitized proposed addresses removed noisy candidates');
    }

    return {
      offerId: context.offerId,
      originalValue: {
        merchantName: context.merchant.name,
        addresses: originalAddresses,
        locationScope: context.offer.locationScope,
        rawLocation: context.merchant.location,
      },
      proposedValue: {
        merchantName: proposal.merchantName,
        addresses: safeAddresses,
        locationScope: proposal.locationScope,
      },
      evidenceReferences: [...new Set(citedEvIds)],
      validatorOutcome: outcome,
      validationErrors: errors,
      validationWarnings: warnings,
      modelIdentifier: modelId,
      attemptCount,
      reason: proposal.reasoning ?? (errors.length > 0 ? errors.join('; ') : 'Validation succeeded'),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Applies a safe correction patch to an offer object (pure function, does NOT mutate input).
   */
  static applyPatch(offer: Offer, patch: GeoCorrectionPatch): Offer {
    if (patch.validatorOutcome === 'REJECTED') {
      return offer; // No change
    }

    return {
      ...offer,
      merchant: {
        ...offer.merchant,
        name: patch.proposedValue.merchantName ?? offer.merchant.name,
        addresses: patch.proposedValue.addresses,
      },
    };
  }
}
