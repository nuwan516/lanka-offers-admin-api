import { Offer } from '@/core/types/offers';
import { FieldCorrectionProposal, EvidenceSnippet } from '@/llm/schemas/offer-validation.schema';
import { EDITABLE_FIELD_PATHS, ManualOverride } from '@/domain/effective-offer';
import {
  verifyEvidenceTokens,
  verifyNumericEvidence,
  verifySemanticNumericEvidence,
  detectUpToSemantics,
} from './offer-evidence';

export interface ValidationGuardResult {
  valid: boolean;
  rejectionReason: string | null;
  sanitizedProposal: FieldCorrectionProposal | null;
}

export class OfferCorrectionValidator {
  private readonly editableSet = new Set<string>(EDITABLE_FIELD_PATHS);

  /**
   * Validates a single proposed field correction against domain invariants and source evidence.
   * Never accepts changes without factual proof.
   */
  public validateProposal(
    proposal: FieldCorrectionProposal,
    offer: Offer,
    evidenceSnippets: EvidenceSnippet[],
    existingManualOverride?: ManualOverride | null
  ): ValidationGuardResult {
    // 1. Invariant: Field path must be in allowlist
    if (!this.editableSet.has(proposal.fieldPath)) {
      return {
        valid: false,
        rejectionReason: `Field path "${proposal.fieldPath}" is not on the editable allowlist`,
        sanitizedProposal: null,
      };
    }

    // 2. Invariant: Manual overrides are sacred — scrapers and LLM proposals must never overwrite human edits
    if (existingManualOverride && proposal.fieldPath in existingManualOverride) {
      return {
        valid: false,
        rejectionReason: `Field "${proposal.fieldPath}" has an existing sacred manual override (${JSON.stringify(
          existingManualOverride[proposal.fieldPath]
        )}) and cannot be overwritten by automated proposal`,
        sanitizedProposal: null,
      };
    }

    // 3. Invariant: Evidence citations must exist
    if (!proposal.evidenceIds || proposal.evidenceIds.length === 0) {
      return {
        valid: false,
        rejectionReason: 'Correction proposal lacks cited evidence snippet IDs',
        sanitizedProposal: null,
      };
    }

    const citedSnippets = evidenceSnippets.filter((s) => proposal.evidenceIds.includes(s.id));
    if (citedSnippets.length === 0) {
      return {
        valid: false,
        rejectionReason: `None of the cited evidence IDs (${proposal.evidenceIds.join(', ')}) exist in the offer's evidence inventory`,
        sanitizedProposal: null,
      };
    }

    // 4. Domain-specific checks by field path

    // ─── Financial terms guards ──────────────────────────────────────────────
    if (proposal.fieldPath === 'offer.discountPercentage') {
      const disc = proposal.proposedValue;
      if (disc !== null) {
        const numDisc = Number(disc);
        if (Number.isNaN(numDisc) || numDisc < 0 || numDisc > 100) {
          return {
            valid: false,
            rejectionReason: `Proposed discount ${disc} is outside the valid range of 0 to 100%`,
            sanitizedProposal: null,
          };
        }

        // Invariant: A 0% installment promotion is an interest-free payment plan, NEVER a 0% price discount
        const offerText = `${offer.title} ${offer.offer?.description ?? ''}`.toLowerCase();
        const hasInstallmentIntent =
          offerText.includes('installment') ||
          offerText.includes('instalment') ||
          offerText.includes('easy payment') ||
          offerText.includes('epp');
        if (numDisc === 0 && hasInstallmentIntent) {
          return {
            valid: false,
            rejectionReason:
              'A 0% installment promotion represents an interest-free payment facility, not a 0% price discount. discountPercentage must not be 0.',
            sanitizedProposal: null,
          };
        }

        // Must physically exist in cited evidence with semantic discount context (not a street number or date)
        const numCheck = verifySemanticNumericEvidence(numDisc, 'DISCOUNT_PERCENT', citedSnippets);
        if (!numCheck.found) {
          return {
            valid: false,
            rejectionReason: `Proposed discount value (${numDisc}%) does not semantically exist as a discount percentage in cited evidence (calendar dates and street numbers are excluded): "${citedSnippets.map((s) => s.text).join(' ')}"`,
            sanitizedProposal: null,
          };
        }

        // Invariant #8: If cited evidence specifies "up to N%", the promotion must not be presented as a flat N% discount
        const upToCheck = detectUpToSemantics(
          citedSnippets.map((s) => s.text).join(' '),
          numDisc
        );
        if (upToCheck.isUpTo && typeof offer.title === 'string' && !offer.title.toLowerCase().includes('up to')) {
          // If title omits "up to", require proposal reasoning to acknowledge "up to" semantics
          if (!proposal.reason.toLowerCase().includes('up to')) {
            return {
              valid: false,
              rejectionReason: `Critical Invariant #8: Source evidence states "up to ${numDisc}%". Cannot set flat discount without acknowledging up-to semantics.`,
              sanitizedProposal: null,
            };
          }
        }
      }
    }

    if (proposal.fieldPath === 'transactionRange.min') {
      const val = proposal.proposedValue;
      if (val !== null) {
        const numVal = Number(val);
        if (Number.isNaN(numVal) || numVal < 0) {
          return {
            valid: false,
            rejectionReason: `Transaction minimum spend ${val} must be a non-negative number`,
            sanitizedProposal: null,
          };
        }
        const numCheck = verifySemanticNumericEvidence(numVal, 'MINIMUM_SPEND', citedSnippets);
        if (!numCheck.found) {
          return {
            valid: false,
            rejectionReason: `Proposed minimum spend (${numVal}) does not exist in cited evidence with spend/purchase context`,
            sanitizedProposal: null,
          };
        }
      }
    }

    if (proposal.fieldPath === 'transactionRange.max') {
      const val = proposal.proposedValue;
      if (val !== null) {
        const numVal = Number(val);
        if (Number.isNaN(numVal) || numVal < 0) {
          return {
            valid: false,
            rejectionReason: `Transaction maximum amount ${val} must be a non-negative number`,
            sanitizedProposal: null,
          };
        }
        const numCheck = verifySemanticNumericEvidence(numVal, 'MAXIMUM_TRANSACTION_LIMIT', citedSnippets);
        if (!numCheck.found) {
          return {
            valid: false,
            rejectionReason: `Proposed maximum transaction limit (${numVal}) does not exist in cited evidence with transaction cap context`,
            sanitizedProposal: null,
          };
        }
      }
    }

    // ─── Validity dates guards ───────────────────────────────────────────────
    if (proposal.fieldPath === 'validityPeriods') {
      const periods = proposal.proposedValue;
      if (!Array.isArray(periods) || periods.length === 0) {
        return {
          valid: false,
          rejectionReason: 'Proposed validityPeriods must be a non-empty array',
          sanitizedProposal: null,
        };
      }

      const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      for (const [idx, p] of periods.entries()) {
        if (p.validFrom && !ISO_DATE_RE.test(p.validFrom)) {
          return {
            valid: false,
            rejectionReason: `Period [${idx}].validFrom "${p.validFrom}" is not in YYYY-MM-DD format`,
            sanitizedProposal: null,
          };
        }
        if (p.validTo && !ISO_DATE_RE.test(p.validTo)) {
          return {
            valid: false,
            rejectionReason: `Period [${idx}].validTo "${p.validTo}" is not in YYYY-MM-DD format`,
            sanitizedProposal: null,
          };
        }
        if (p.validFrom && p.validTo && p.validFrom > p.validTo) {
          return {
            valid: false,
            rejectionReason: `Period [${idx}].validFrom (${p.validFrom}) is chronologically after validTo (${p.validTo})`,
            sanitizedProposal: null,
          };
        }

        // Check if expiry date extension exists in cited evidence
        if (p.validTo) {
          const originalValidTo = offer.validityPeriods?.[idx]?.validTo;
          if (originalValidTo && p.validTo > originalValidTo) {
            // Verify that the proposed end date or year exists in evidence
            const yearStr = p.validTo.slice(0, 4);
            const tokenCheck = verifyEvidenceTokens(yearStr, citedSnippets);
            if (!tokenCheck.grounded) {
              return {
                valid: false,
                rejectionReason: `Proposed expiry extension to ${p.validTo} lacks textual year support in cited evidence`,
                sanitizedProposal: null,
              };
            }
          }
        }
      }
    }

    // ─── Card eligibility guards ─────────────────────────────────────────────
    if (proposal.fieldPath === 'cardEligibility.cardTypes' || proposal.fieldPath === 'cardEligibility.networks') {
      const list = proposal.proposedValue;
      if (Array.isArray(list)) {
        for (const item of list) {
          const tokenCheck = verifyEvidenceTokens(String(item), citedSnippets);
          if (!tokenCheck.grounded) {
            return {
              valid: false,
              rejectionReason: `Proposed card eligibility "${item}" has zero token overlap with cited evidence`,
              sanitizedProposal: null,
            };
          }
        }
      }
    }

    // ─── Merchant name guards ────────────────────────────────────────────────
    if (proposal.fieldPath === 'merchant.name') {
      const name = String(proposal.proposedValue ?? '').trim();
      if (name.length === 0) {
        return {
          valid: false,
          rejectionReason: 'Proposed merchant.name cannot be empty',
          sanitizedProposal: null,
        };
      }
      const tokenCheck = verifyEvidenceTokens(name, citedSnippets);
      if (!tokenCheck.grounded) {
        return {
          valid: false,
          rejectionReason: `Proposed merchant name "${name}" is not grounded in cited evidence (token overlap ${Math.round(
            tokenCheck.tokenOverlapRatio * 100
          )}% < 40%)`,
          sanitizedProposal: null,
        };
      }
    }

    // ─── Merchant location & address guards ──────────────────────────────────
    if (proposal.fieldPath === 'merchant.addresses') {
      const addrs = proposal.proposedValue;
      if (Array.isArray(addrs)) {
        for (const addr of addrs) {
          const s = String(addr).trim();
          if (s.length > 0) {
            // Check for coordinate injection attempt (e.g. "6.9271, 79.8612")
            if (/^-?\d+\.\d+,\s*-?\d+\.\d+$/.test(s)) {
              return {
                valid: false,
                rejectionReason: 'False location precision: numeric coordinates cannot be injected as street addresses',
                sanitizedProposal: null,
              };
            }
            const tokenCheck = verifyEvidenceTokens(s, citedSnippets);
            if (!tokenCheck.grounded) {
              return {
                valid: false,
                rejectionReason: `Proposed branch address "${s}" is not grounded in source text`,
                sanitizedProposal: null,
              };
            }
          }
        }
      }
    }

    // All guards passed
    return {
      valid: true,
      rejectionReason: null,
      sanitizedProposal: proposal,
    };
  }

  /**
   * Batch-validates a set of proposals, returning accepted proposals and rejected diagnostics.
   */
  public filterProposals(
    proposals: FieldCorrectionProposal[],
    offer: Offer,
    evidenceSnippets: EvidenceSnippet[],
    existingManualOverride?: ManualOverride | null
  ): {
    accepted: FieldCorrectionProposal[];
    rejected: Array<{ proposal: FieldCorrectionProposal; reason: string }>;
  } {
    const accepted: FieldCorrectionProposal[] = [];
    const rejected: Array<{ proposal: FieldCorrectionProposal; reason: string }> = [];

    for (const prop of proposals) {
      const res = this.validateProposal(prop, offer, evidenceSnippets, existingManualOverride);
      if (res.valid && res.sanitizedProposal) {
        accepted.push(res.sanitizedProposal);
      } else {
        rejected.push({
          proposal: prop,
          reason: res.rejectionReason ?? 'Unknown validation failure',
        });
      }
    }

    return { accepted, rejected };
  }
}
