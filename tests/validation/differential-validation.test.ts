import {
  ValidationDecisionSchema,
  FieldCorrectionSchema,
  toFullOfferValidationProposal,
  FullOfferValidationProposalSchema,
} from '@/llm/schemas/offer-validation.schema';
import { parseJsonProposal } from '@/llm/llm-tool-session';
import { OfferToolExecutor } from '@/llm/tools/offer-tool-executor';
import { OfferCorrectionValidator } from '@/parsing/validators/offer-correction-validator';
import { buildOfferEvidenceSnippets } from '@/parsing/validators/offer-evidence';
import { Offer, PeriodType, RecurrenceType } from '@/core/types/offers';

describe('Differential Validation & Structured Output Repair', () => {
  const dummyOffer: Offer = {
    uniqueId: 'hnb_2451',
    source: 'hnb',
    sourceId: '2451',
    sourceUrl: 'https://venus.hnb.lk/api/get_web_card_promo?id=2451',
    title: '20% off on BB, HB and FB basis at Centauria Wild Udawalawa',
    category: 'Hotel',
    categoryId: 1,
    cardType: 'Credit Card, Debit Card',
    scrapedAt: '2026-10-03T15:03:31.434Z',
    merchant: {
      name: 'Centauria Wild - Udawalawa',
      location: 'Udawalawa',
      addresses: ['wild@centauriaho, Sri Lanka', 'mktg@centauriaho, Sri Lanka'],
      phone: ['0112581132'],
      email: [],
      website: 'www.centauriahotels.com',
      logo: null,
    },
    offer: {
      description: '20% off (from rack rates) on Bed & Breakfast, Half Board, Full Board basis',
      discountPercentage: 20,
      applicableCards: ['Debit Card'],
      bookingRequired: true,
      restrictions: ['Cannot be combined with other offers'],
      specialConditions: [],
      generalTerms: [],
    },
    installmentPlans: [],
    transactionRange: {
      min: null,
      max: null,
      currency: 'LKR',
    },
    cardEligibility: {
      includedCards: [],
      excludedCards: [],
      cardTypes: ['Credit Card', 'Debit Card'],
      networks: ['Visa', 'Mastercard'],
      restrictions: [],
    },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [
      {
        validFrom: '2026-10-03',
        validTo: '2026-12-31',
        periodType: PeriodType.OFFER,
        recurrenceType: RecurrenceType.DAILY,
        recurrenceDays: null,
        timeWindow: null,
        exclusionDays: null,
        blackoutPeriods: null,
        exclusionNotes: null,
        rawPeriodText: 'Till 31st December 2026',
      },
    ],
    contentHash: 'c6f140e79756dcbf0ccaf380687325c4d8fe53418ba2d4650306c1d5698113e2',
  };

  const evidence = buildOfferEvidenceSnippets(dummyOffer);

  describe('1. Differential Schemas (Phase 2)', () => {
    it('validates a concise ACCEPT decision with zero unneeded fields', () => {
      const decision = {
        decision: 'ACCEPT',
        overallScore: 92,
        corrections: [],
        unresolvedIssues: [],
        summaryReasoning: 'Offer is completely grounded in source evidence with 20% discount confirmed.',
        locationScope: 'EXPLICIT_BRANCH',
      };

      const parsed = ValidationDecisionSchema.safeParse(decision);
      expect(parsed.success).toBe(true);
    });

    it('validates a targeted CORRECT decision with single field correction', () => {
      const decision = {
        decision: 'CORRECT',
        overallScore: 80,
        corrections: [
          {
            fieldPath: 'merchant.addresses',
            proposedValue: [],
            originalValue: ['wild@centauriaho, Sri Lanka'],
            evidenceIds: ['ev-merchant-loc'],
            reason: 'Truncated email address mis-parsed as physical venue',
            confidence: 'HIGH',
          },
        ],
        unresolvedIssues: [],
        summaryReasoning: 'Removed contaminated email address from physical merchant address array.',
        locationScope: 'EXPLICIT_BRANCH',
      };

      const parsed = ValidationDecisionSchema.safeParse(decision);
      expect(parsed.success).toBe(true);
    });

    it('rejects correction missing evidence citations', () => {
      const invalid = {
        fieldPath: 'offer.discountPercentage',
        proposedValue: 30,
        evidenceIds: [], // missing!
        reason: 'Speculative discount upgrade',
      };

      const check = FieldCorrectionSchema.safeParse(invalid);
      expect(check.success).toBe(false);
    });

    it('rejects decision with summaryReasoning shorter than 10 characters', () => {
      const invalid = {
        decision: 'ACCEPT',
        overallScore: 90,
        corrections: [],
        unresolvedIssues: [],
        summaryReasoning: 'Too short',
      };

      const check = ValidationDecisionSchema.safeParse(invalid);
      expect(check.success).toBe(false);
    });
  });

  describe('2. Proposal Conversion & Adaptability', () => {
    it('converts differential decision into valid FullOfferValidationProposal', () => {
      const decision = {
        decision: 'CORRECT' as const,
        overallScore: 85,
        corrections: [
          {
            fieldPath: 'merchant.addresses' as const,
            originalValue: ['wild@centauriaho, Sri Lanka'],
            proposedValue: [],
            evidenceIds: ['ev-merchant-loc'],
            reason: 'Address cleanup',
            confidence: 'HIGH' as const,
          },
        ],
        unresolvedIssues: [],
        summaryReasoning: 'Cleaned up email addresses from physical location array.',
        locationScope: 'EXPLICIT_BRANCH' as const,
      };

      const full = toFullOfferValidationProposal(decision, dummyOffer);
      const zodCheck = FullOfferValidationProposalSchema.safeParse(full);
      expect(zodCheck.success).toBe(true);
      expect(full.qualityGate.status).toBe('VALIDATED');
      expect(full.corrections).toHaveLength(1);
      expect(full.corrections[0].fieldPath).toBe('merchant.addresses');
    });

    it('safely classifies REVIEW_REQUIRED when decision is REVIEW_REQUIRED', () => {
      const decision = {
        decision: 'REVIEW_REQUIRED' as const,
        overallScore: 60,
        corrections: [],
        unresolvedIssues: ['Source text contains conflicting discount tiers (20% vs 30%)'],
        summaryReasoning: 'Ambiguity in discount tiers requires human operator review.',
      };

      const full = toFullOfferValidationProposal(decision, dummyOffer);
      expect(full.qualityGate.status).toBe('REVIEW_REQUIRED');
      expect(full.qualityGate.reasons).toContain('Source text contains conflicting discount tiers (20% vs 30%)');
    });
  });

  describe('3. Robust JSON Output Parsing & Markdown Recovery', () => {
    it('recovers differential decision enclosed in markdown codeblock', () => {
      const raw = `\`\`\`json
{
  "decision": "ACCEPT",
  "overallScore": 95,
  "corrections": [],
  "unresolvedIssues": [],
  "summaryReasoning": "All offer claims verified against source evidence."
}
\`\`\``;

      const proposal = parseJsonProposal(raw, dummyOffer);
      expect(proposal).not.toBeNull();
      expect(proposal?.qualityGate.status).toBe('VALIDATED');
    });

    it('recovers differential decision with conversational prefix and suffix', () => {
      const raw = `Based on the source evidence, here is my structured validation proposal:
\`\`\`json
{
  "decision": "CORRECT",
  "overallScore": 82,
  "corrections": [
    {
      "fieldPath": "merchant.addresses",
      "originalValue": ["wild@centauriaho"],
      "proposedValue": [],
      "evidenceIds": ["ev-1"],
      "reason": "Email address in physical location"
    }
  ],
  "unresolvedIssues": [],
  "summaryReasoning": "Stripped corrupted email strings from address array."
}
\`\`\`
Note: No further tools were needed.`;

      const proposal = parseJsonProposal(raw, dummyOffer);
      expect(proposal).not.toBeNull();
      expect(proposal?.corrections).toHaveLength(1);
    });

    it('returns null on completely unparseable text', () => {
      const broken = 'The model failed completely and generated no json whatsoever.';
      const proposal = parseJsonProposal(broken, dummyOffer);
      expect(proposal).toBeNull();
    });
  });

  describe('4. Tool Executor Budget & Quota Enforcement (Phase 4)', () => {
    it('exempts submit_validation_decision from attempt-level inspection limit', async () => {
      const executor = new OfferToolExecutor(dummyOffer, [], {
        maxToolCallsPerAttempt: 2,
        maxToolCallsPerOffer: 10,
      });

      // 2 inspection calls (hitting attempt budget)
      const call1 = await executor.executeTool('get_source_section', { section: 'title' });
      const call2 = await executor.executeTool('get_source_section', { section: 'merchant' });
      expect(call1.success).toBe(true);
      expect(call2.success).toBe(true);

      // Third inspection call fails due to attempt quota
      const call3 = await executor.executeTool('get_source_section', { section: 'description' });
      expect(call3.success).toBe(false);
      expect(call3.error).toContain('Tool call limit exceeded for this attempt');

      // But submission tool is EXEMPT from attempt limit and succeeds!
      const submit = await executor.executeTool('submit_validation_decision', {
        decision: 'ACCEPT',
        overallScore: 90,
        corrections: [],
        unresolvedIssues: [],
        summaryReasoning: 'Validated after inspection calls completed.',
      });

      expect(submit.success).toBe(true);
      expect(executor.getSubmittedDecision()?.decision).toBe('ACCEPT');
      expect(executor.getSubmittedProposal()).not.toBeNull();
    });

    it('enforces global offer tool budget ceiling across all attempts', async () => {
      const executor = new OfferToolExecutor(dummyOffer, [], {
        maxToolCallsPerAttempt: 10,
        maxToolCallsPerOffer: 3, // global cap 3
      });

      await executor.executeTool('get_source_section', { section: 'title' });
      await executor.executeTool('get_source_section', { section: 'merchant' });
      await executor.executeTool('get_source_section', { section: 'validity' });

      // 4th call exceeds global ceiling
      const call4 = await executor.executeTool('get_source_section', { section: 'terms' });
      expect(call4.success).toBe(false);
      expect(call4.error).toContain('Global offer tool budget exhausted');
    });

    it('compacts get_source_section snippets to prevent oversized history', async () => {
      const longSnippetOffer: Offer = {
        ...dummyOffer,
        title: 'Title',
        offer: {
          ...dummyOffer.offer,
          description: 'A'.repeat(1500), // 1500 chars
        },
      };

      const executor = new OfferToolExecutor(longSnippetOffer);
      const res = await executor.executeTool('get_source_section', { section: 'description' });
      expect(res.success).toBe(true);
      const data = res.data as { snippets: Array<{ text: string }> };
      for (const snippet of data.snippets) {
        expect(snippet.text.length).toBeLessThanOrEqual(420); // capped at 400 + truncation indicator
      }
    });
  });

  describe('5. OfferCorrectionValidator Grounding & Post-Validation', () => {
    const validator = new OfferCorrectionValidator();

    it('accepts grounded address correction', () => {
      const corr = {
        fieldPath: 'merchant.addresses' as const,
        originalValue: dummyOffer.merchant.addresses,
        proposedValue: [],
        evidenceIds: [evidence[0].id],
        reason: 'Removing email contamination',
        confidence: 'HIGH' as const,
      };

      const res = validator.validateProposal(corr, dummyOffer, evidence);
      expect(res.valid).toBe(true);
    });

    it('rejects proposal attempting to overwrite sacred manual overrides', () => {
      const corr = {
        fieldPath: 'offer.discountPercentage' as const,
        originalValue: dummyOffer.offer.discountPercentage,
        proposedValue: 25,
        evidenceIds: [evidence[0].id],
        reason: 'Automated discount bump',
        confidence: 'HIGH' as const,
      };

      const manualOverride = {
        'offer.discountPercentage': 15,
      };

      const res = validator.validateProposal(corr, dummyOffer, evidence, manualOverride);
      expect(res.valid).toBe(false);
      expect(res.rejectionReason).toContain('sacred manual override');
    });
  });
});
