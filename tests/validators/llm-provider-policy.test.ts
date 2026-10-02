import { resolveLlmProvider } from '@/parsing/validators/llm-validator';
import { resetCostControlConfigCache } from '@/config/cost-control';

const ENV_KEYS = ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ALLOW_PAID_LLM_FALLBACK', 'LLM_MODE', 'LLM_PRIMARY_PROVIDER'];

describe('resolveLlmProvider — explicit provider policy (Step 5)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    resetCostControlConfigCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetCostControlConfigCache();
  });

  it('prefers Gemini when its key is present, regardless of a DeepSeek key also existing', () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.DEEPSEEK_API_KEY = 'd-key';
    const { provider, apiKey } = resolveLlmProvider();
    expect(provider).toBe('gemini');
    expect(apiKey).toBe('g-key');
  });

  it('does NOT fall back to the paid DeepSeek key when Gemini is missing and fallback is not explicitly enabled', () => {
    process.env.DEEPSEEK_API_KEY = 'd-key';
    // ALLOW_PAID_LLM_FALLBACK left unset -> defaults to false
    const { provider, apiKey } = resolveLlmProvider();
    expect(provider).toBe('gemini');
    expect(apiKey).toBeUndefined(); // no key resolved -> validator stays unavailable, no silent paid call
  });

  it('falls back to DeepSeek only when ALLOW_PAID_LLM_FALLBACK=true is explicitly set', () => {
    process.env.DEEPSEEK_API_KEY = 'd-key';
    process.env.ALLOW_PAID_LLM_FALLBACK = 'true';
    process.env.LLM_MODE = 'allow_paid';
    const { provider, apiKey } = resolveLlmProvider();
    expect(provider).toBe('deepseek');
    expect(apiKey).toBe('d-key');
  });

  it('never picks a provider based solely on "whichever key exists" — no key at all means no apiKey resolved', () => {
    const { apiKey } = resolveLlmProvider();
    expect(apiKey).toBeUndefined();
  });
});
