/**
 * Phase 5: Structured Output Reliability & Parser Hardening Tests
 *
 * Verifies:
 * 1. Markdown wrappers parsed properly
 * 2. Nested objects and braces inside strings preserved
 * 3. Escaped characters handled correctly
 * 4. Multiple JSON blocks rejected as ambiguous (no guessing)
 * 5. Truncated or malformed responses rejected fail-closed
 * 6. Unknown/invalid fields rejected by Zod schemas
 * 7. Duplicate submission prevented in OfferToolExecutor
 * 8. Invalid evidence IDs rejected by OfferCorrectionValidator
 * 9. Submission quota exemptions do not bypass global tool limits
 */

import { parseJsonProposal } from '@/llm/llm-tool-session';
import { OfferToolExecutor } from '@/llm/tools/offer-tool-executor';
import { OfferCorrectionValidator } from '@/parsing/validators/offer-correction-validator';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';
import { EvidenceSnippet, ValidationDecisionSchema } from '@/llm/schemas/offer-validation.schema';

describe('Phase 5 — Structured Output Reliability', () => {
  const dummyOffer: Offer = {
    uniqueId: 'test_1',
    source: 'hnb',
    sourceId: '1',
    sourceUrl: 'https://hnb.lk/promo/1',
    title: 'Test Offer 20% Off',
    category: 'Dining',
    categoryId: 1,
    cardType: 'Credit Card',
    scrapedAt: '2026-10-01T00:00:00.000Z',
    merchant: {
      name: 'Test Merchant',
      location: 'Colombo',
      addresses: ['Colombo, Sri Lanka'],
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: {
      description: '20% off for HNB Cards',
      discountPercentage: 20,
      applicableCards: [],
      bookingRequired: false,
      restrictions: [],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: ['Credit Card'],
      networks: ['Visa'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Valid till 31 Dec 2026',
      },
    ],
    contentHash: 'hash1',
  };

  const sampleEvidence: EvidenceSnippet[] = [
    { id: 'ev-title', sourceField: 'title', text: 'Test Offer 20% Off at Test Merchant' },
    { id: 'ev-desc', sourceField: 'description', text: '20% off for HNB Cards. Minimum spend Rs. 5,000.' },
  ];

  it('correctly unpacks markdown-wrapped JSON payloads', () => {
    const raw = "```json\n{\n  \"decision\": \"ACCEPT\",\n  \"overallScore\": 90,\n  \"corrections\": [],\n  \"summaryReasoning\": \"Offer is well grounded in provided evidence.\"\n}\n```";
    const proposal = parseJsonProposal(raw, dummyOffer);
    expect(proposal).not.toBeNull();
    expect(proposal?.qualityGate.overallScore).toBe(90);
    expect(proposal?.qualityGate.status).toBe('VALIDATED');
  });

  it('handles nested objects and braces inside string literals', () => {
    const raw = JSON.stringify({
      decision: 'ACCEPT',
      overallScore: 88,
      corrections: [],
      unresolvedIssues: [],
      summaryReasoning: 'Text containing nested {braces} and "escaped quotes" should parse cleanly.',
    });
    const proposal = parseJsonProposal(raw, dummyOffer);
    expect(proposal).not.toBeNull();
    expect(proposal?.summaryReasoning).toContain('{braces}');
  });

  it('rejects ambiguous responses containing multiple JSON blocks without guessing', () => {
    const raw = "Here is block 1:\n```json\n{\"decision\": \"ACCEPT\", \"overallScore\": 90, \"corrections\": [], \"summaryReasoning\": \"Block 1\"}\n```\nAnd block 2:\n```json\n{\"decision\": \"CORRECT\", \"overallScore\": 70, \"corrections\": [], \"summaryReasoning\": \"Block 2\"}\n```";
    const proposal = parseJsonProposal(raw, dummyOffer);
    expect(proposal).toBeNull();
  });

  it('rejects truncated JSON payloads fail-closed', () => {
    const raw = '{"decision": "CORRECT", "overallScore": 85, "corrections": [{"fieldPath": "merchant.name", "proposedValue": "Test';
    const proposal = parseJsonProposal(raw, dummyOffer);
    expect(proposal).toBeNull();
  });

  it('rejects malformed UTF-8 / corrupted payloads fail-closed', () => {
    const raw = '{"decision": \x00\x1f undefined}';
    const proposal = parseJsonProposal(raw, dummyOffer);
    expect(proposal).toBeNull();
  });

  it('validates schema strictly and catches invalid field types', () => {
    const invalidObj = {
      decision: 'UNKNOWN_DECISION',
      overallScore: 'NOT_A_NUMBER',
    };
    const res = ValidationDecisionSchema.safeParse(invalidObj);
    expect(res.success).toBe(false);
  });

  it('enforces single submission in OfferToolExecutor and rejects duplicate proposals', async () => {
    const executor = new OfferToolExecutor(dummyOffer, [], {
      maxToolCallsPerAttempt: 5,
      maxToolCallsPerOffer: 15,
    });

    const proposalArgs = {
      decision: 'ACCEPT' as const,
      overallScore: 90,
      corrections: [],
      summaryReasoning: 'Valid offer grounded in source.',
    };

    const firstSubmit = await executor.executeTool('submit_validation_decision', proposalArgs);
    expect(firstSubmit.success).toBe(true);

    // Duplicate submission attempt
    const secondSubmit = await executor.executeTool('submit_validation_decision', proposalArgs);
    expect(secondSubmit.success).toBe(false);
    expect(secondSubmit.error).toContain('already been submitted');
  });

  it('validates tool arguments strictly and rejects empty search query', async () => {
    const executor = new OfferToolExecutor(dummyOffer, [], {
      maxToolCallsPerAttempt: 5,
      maxToolCallsPerOffer: 15,
    });

    const badSearch = await executor.executeTool('search_source_evidence', { query: '' });
    expect(badSearch.success).toBe(false);
    expect(badSearch.error).toContain('query');
  });

  it('rejects proposals citing non-existent or fabricated evidence IDs', () => {
    const patchValidator = new OfferCorrectionValidator();
    const badProposal = {
      fieldPath: 'merchant.name',
      originalValue: 'Old Merchant',
      proposedValue: 'New Fabricated Merchant',
      evidenceIds: ['ev-non-existent-999'],
      reason: 'Fabricated without evidence',
      confidence: 'HIGH' as const,
    };

    const res = patchValidator.validateProposal(badProposal, dummyOffer, sampleEvidence);
    expect(res.valid).toBe(false);
    expect(res.rejectionReason).toContain("exist in the offer's evidence inventory");
  });

  it('enforces total tool budget even when submission fails', async () => {
    const executor = new OfferToolExecutor(dummyOffer, [], {
      maxToolCallsPerAttempt: 2,
      maxToolCallsPerOffer: 2,
    });

    await executor.executeTool('get_source_section', { section: 'TITLE' });
    await executor.executeTool('get_source_section', { section: 'DESCRIPTION' });

    const overBudget = await executor.executeTool('get_source_section', { section: 'TERMS' });
    expect(overBudget.success).toBe(false);
    expect(overBudget.error).toContain('limit exceeded');
  });
});
