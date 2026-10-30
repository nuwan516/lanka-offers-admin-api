import { decideOfferQuality } from '@/domain/offer-quality-decision';
import { resetQualityPolicyConfigCache } from '@/config/quality-policy';

describe('decideOfferQuality', () => {
  const ENV_KEYS = ['QUALITY_AUTO_APPROVE_SCORE', 'QUALITY_REJECT_SCORE_FLOOR', 'QUALITY_ALLOW_RULE_ONLY_AUTO_APPROVE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    resetQualityPolicyConfigCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetQualityPolicyConfigCache();
  });

  it('AUTO_APPROVEs a high-confidence, rule-valid offer with no warnings', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 95, llmValid: true, llmStatus: 'validated',
    });
    expect(decision).toBe('AUTO_APPROVE');
  });

  it('sends a mid-confidence offer to REVIEW_REQUIRED', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 75, llmValid: true, llmStatus: 'validated',
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  it('sends a rule-invalid offer to REVIEW_REQUIRED, not straight to REJECT', () => {
    const decision = decideOfferQuality({
      ruleValid: false, ruleErrorCount: 2, ruleWarningCount: 0,
      llmScore: null, llmValid: null, llmStatus: null,
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  it('sends a duplicate to REVIEW_REQUIRED, never REJECT, regardless of score', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 99, llmValid: true, llmStatus: 'validated', isDuplicate: true,
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  it('REJECTs a very low LLM score', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 10, llmValid: false, llmStatus: 'validated',
    });
    expect(decision).toBe('REJECT');
  });

  it('sends to REVIEW_REQUIRED when the LLM never ran (no usable signal), by default', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: null, llmValid: null, llmStatus: null,
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  it('does not auto-approve on a budget-blocked LLM status even with a stale score', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 95, llmValid: true, llmStatus: 'skipped_budget',
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  it('honors QUALITY_ALLOW_RULE_ONLY_AUTO_APPROVE=true when the LLM never ran', () => {
    process.env.QUALITY_ALLOW_RULE_ONLY_AUTO_APPROVE = 'true';
    resetQualityPolicyConfigCache();
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: null, llmValid: null, llmStatus: null,
    });
    expect(decision).toBe('AUTO_APPROVE');
  });

  it('thresholds are configuration — a custom auto-approve score changes the outcome', () => {
    process.env.QUALITY_AUTO_APPROVE_SCORE = '70';
    resetQualityPolicyConfigCache();
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
      llmScore: 75, llmValid: true, llmStatus: 'validated',
    });
    expect(decision).toBe('AUTO_APPROVE');
  });

  it('warnings block auto-approval even at a high score', () => {
    const decision = decideOfferQuality({
      ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 1,
      llmScore: 99, llmValid: true, llmStatus: 'validated',
    });
    expect(decision).toBe('REVIEW_REQUIRED');
  });

  describe('classifyDetailedOfferQuality (Phase 4 Ingestion Quality Gate)', () => {
    const { classifyDetailedOfferQuality } = require('@/domain/offer-quality-decision');

    it('classifies SOURCE_INCOMPLETE when essential promotion attributes are missing', () => {
      const res = classifyDetailedOfferQuality({
        ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
        llmScore: 95, llmValid: true, llmStatus: 'validated',
        isSourceIncomplete: true,
      });
      expect(res.category).toBe('SOURCE_INCOMPLETE');
      expect(res.decision).toBe('REVIEW_REQUIRED');
    });

    it('classifies DUPLICATE_CANDIDATE when duplicate flag is present', () => {
      const res = classifyDetailedOfferQuality({
        ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
        llmScore: 95, llmValid: true, llmStatus: 'validated',
        isDuplicate: true,
      });
      expect(res.category).toBe('DUPLICATE_CANDIDATE');
      expect(res.decision).toBe('REVIEW_REQUIRED');
    });

    it('classifies INVALID when parser rules fail or LLM score is below floor', () => {
      const ruleFail = classifyDetailedOfferQuality({
        ruleValid: false, ruleErrorCount: 2, ruleWarningCount: 0,
        llmScore: 95, llmValid: true, llmStatus: 'validated',
      });
      expect(ruleFail.category).toBe('INVALID');
      expect(ruleFail.decision).toBe('REVIEW_REQUIRED');

      const floorFail = classifyDetailedOfferQuality({
        ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 0,
        llmScore: 20, llmValid: false, llmStatus: 'validated',
      });
      expect(floorFail.category).toBe('INVALID');
      expect(floorFail.decision).toBe('REJECT');
    });

    it('classifies VALID_WITH_WARNINGS when warnings exist despite high score', () => {
      const res = classifyDetailedOfferQuality({
        ruleValid: true, ruleErrorCount: 0, ruleWarningCount: 2,
        llmScore: 95, llmValid: true, llmStatus: 'validated',
      });
      expect(res.category).toBe('VALID_WITH_WARNINGS');
      expect(res.decision).toBe('REVIEW_REQUIRED');
    });

    it('classifies VALID_EXPIRED and returns EXPIRE decision for expired valid promotions', () => {
      const res = classifyDetailedOfferQuality({
        ruleValid: false, ruleErrorCount: 1, ruleWarningCount: 0,
        llmScore: null, llmValid: null, llmStatus: null,
        isExpired: true,
      });
      expect(res.category).toBe('VALID_EXPIRED');
      expect(res.decision).toBe('EXPIRE');
      expect(res.reasons[0]).toContain('expired');
    });

    it('decideOfferQuality returns EXPIRE for expired offers', () => {
      const decision = decideOfferQuality({
        ruleValid: false, ruleErrorCount: 1, ruleWarningCount: 0,
        llmScore: null, llmValid: null, llmStatus: null,
        isExpired: true,
      });
      expect(decision).toBe('EXPIRE');
    });
  });
});

