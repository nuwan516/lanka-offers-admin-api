import { buildReusableLlmValidation } from '@/parsing/validators/llm-reuse';
import type { StoredLlmFingerprint } from '@/infrastructure/db/offer-repository';
import type { Offer } from '@/core/types/offers';

function makeFingerprint(overrides: Partial<StoredLlmFingerprint> = {}): StoredLlmFingerprint {
  return {
    offerId: 'offer-1',
    uniqueId: 'hnb_001',
    contentHash: 'hash-a',
    llmValidatedContentHash: 'hash-a',
    llmPromptVersion: 'offer-full-v1',
    llmValidatorVersion: 'v1',
    llmProvider: 'gemini',
    llmModel: 'gemini-1.5-flash',
    llmScore: 88,
    llmValid: true,
    llmStatus: 'validated',
    llmValidatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const policy = { promptVersion: 'offer-full-v1', validatorVersion: 'v1', provider: 'gemini' as const };
const offer = { contentHash: 'hash-a' } as Offer;

describe('buildReusableLlmValidation — Step 4 reuse decision', () => {
  it('reuses when content hash, prompt version, validator version, and provider all match', () => {
    const result = buildReusableLlmValidation(makeFingerprint(), offer, policy);
    expect(result).not.toBeNull();
    expect(result?.isValidOffer).toBe(true);
    expect(result?.extractionScore).toBe(88);
  });

  it('returns null (must re-call LLM) when content_hash changed', () => {
    const result = buildReusableLlmValidation(makeFingerprint(), { contentHash: 'hash-b' } as Offer, policy);
    expect(result).toBeNull();
  });

  it('returns null when there is no prior fingerprint at all (new offer)', () => {
    expect(buildReusableLlmValidation(null, offer, policy)).toBeNull();
  });

  it('returns null when the prompt version was bumped', () => {
    const fp = makeFingerprint({ llmPromptVersion: 'offer-full-v0' });
    expect(buildReusableLlmValidation(fp, offer, policy)).toBeNull();
  });

  it('returns null when the validator version was bumped', () => {
    const fp = makeFingerprint({ llmValidatorVersion: 'v0' });
    expect(buildReusableLlmValidation(fp, offer, policy)).toBeNull();
  });

  it('returns null when the provider differs (e.g. previously validated by a different provider)', () => {
    const fp = makeFingerprint({ llmProvider: 'deepseek' });
    expect(buildReusableLlmValidation(fp, offer, policy)).toBeNull();
  });

  it('returns null for a fingerprint that never produced a usable result (budget-blocked)', () => {
    const fp = makeFingerprint({ llmStatus: 'skipped_budget', llmScore: null, llmValid: null });
    expect(buildReusableLlmValidation(fp, offer, policy)).toBeNull();
  });

  it('returns null for a fingerprint marked review_required', () => {
    const fp = makeFingerprint({ llmStatus: 'review_required' });
    expect(buildReusableLlmValidation(fp, offer, policy)).toBeNull();
  });
});
