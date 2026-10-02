/**
 * Zero-cost control layer configuration.
 *
 * Everything here is read from environment variables so quota values, kill
 * switches, and provider policy are configuration — never hardcoded
 * "permanent truths" about a provider's free tier.
 *
 * Business policy (see task spec):
 *  - Gemini is the preferred free-tier LLM provider.
 *  - DeepSeek is an optional PAID fallback and must never activate
 *    automatically. It only runs when ALLOW_PAID_LLM_FALLBACK=true.
 *  - When a free-tier quota is exhausted, optional calls STOP instead of
 *    silently falling back to a paid provider.
 */

import type { LlmProvider } from '@/core/types/validation';

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.trim().toLowerCase() === 'true' || raw.trim() === '1';
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString<T extends string>(name: string, fallback: T): T {
  const raw = process.env[name];
  return (raw && raw.trim().length > 0 ? raw.trim() : fallback) as T;
}

// ─── Provider policy ────────────────────────────────────────────────────────

export type LlmMode = 'free_only' | 'allow_paid';

export interface LlmPolicyConfig {
  mode: LlmMode;
  primaryProvider: LlmProvider;
  fallbackProvider: LlmProvider | null;
  allowPaidFallback: boolean;
  validationEnabled: boolean;
  promptVersion: string;
  validatorVersion: string;
}

// ─── Quota / CostGuard config ───────────────────────────────────────────────

export interface ServiceQuotaConfig {
  service: string;
  limit: number;
  warnPercent: number;
  blockPercent: number;
  enabled: boolean;
}

export interface CostControlConfig {
  llm: LlmPolicyConfig;
  geoProviderCallsEnabled: boolean;
  placesEnrichmentEnabled: boolean;
  services: Record<string, ServiceQuotaConfig>;
}

/** Validator/prompt version bump invalidates all prior LLM reuse. */
export const LLM_VALIDATOR_VERSION = 'v1';

export function loadCostControlConfig(): CostControlConfig {
  const warnPercent = envNumber('COST_GUARD_WARN_PERCENT', 70);
  const blockPercent = envNumber('COST_GUARD_BLOCK_PERCENT', 95);
  const allowPaidFallback = envBool('ALLOW_PAID_LLM_FALLBACK', false);
  const mode = envString<LlmMode>('LLM_MODE', 'free_only');

  const services: Record<string, ServiceQuotaConfig> = {
    gemini_llm: {
      service: 'gemini_llm',
      limit: envNumber('GEMINI_MONTHLY_REQUEST_LIMIT', 1_000),
      warnPercent,
      blockPercent,
      enabled: envBool('LLM_VALIDATION_ENABLED', true),
    },
    deepseek_llm: {
      service: 'deepseek_llm',
      // Paid provider — default limit is 0 so CostGuard blocks it until an
      // operator explicitly configures a budget AND enables the fallback.
      limit: envNumber('DEEPSEEK_MONTHLY_REQUEST_LIMIT', 0),
      warnPercent,
      blockPercent,
      enabled: allowPaidFallback,
    },
    // Not part of the Gemini/DeepSeek policy — kept only so a caller that
    // explicitly passes provider: 'openai' isn't unconditionally blocked.
    openai_llm: {
      service: 'openai_llm',
      limit: envNumber('OPENAI_MONTHLY_REQUEST_LIMIT', 1_000),
      warnPercent,
      blockPercent,
      enabled: envBool('LLM_VALIDATION_ENABLED', true),
    },
    google_geocoding: {
      service: 'google_geocoding',
      limit: envNumber('GOOGLE_GEOCODING_MONTHLY_LIMIT', 10_000),
      warnPercent,
      blockPercent,
      enabled: envBool('GEO_PROVIDER_CALLS_ENABLED', true),
    },
    google_places: {
      service: 'google_places',
      limit: envNumber('GOOGLE_PLACES_MONTHLY_LIMIT', 10_000),
      warnPercent,
      blockPercent,
      enabled: envBool('PLACES_ENRICHMENT_ENABLED', true),
    },
  };

  return {
    llm: {
      mode,
      primaryProvider: envString<LlmProvider>('LLM_PRIMARY_PROVIDER', 'gemini'),
      fallbackProvider: allowPaidFallback ? envString<LlmProvider>('LLM_FALLBACK_PROVIDER', 'deepseek') : null,
      allowPaidFallback,
      validationEnabled: envBool('LLM_VALIDATION_ENABLED', true),
      promptVersion: envString('LLM_PROMPT_VERSION', 'offer-full-v1'),
      validatorVersion: envString('LLM_VALIDATOR_VERSION', LLM_VALIDATOR_VERSION),
    },
    geoProviderCallsEnabled: envBool('GEO_PROVIDER_CALLS_ENABLED', true),
    placesEnrichmentEnabled: envBool('PLACES_ENRICHMENT_ENABLED', true),
    services,
  };
}

/** Lazily-cached singleton — env vars don't change mid-process. */
let cached: CostControlConfig | null = null;
export function getCostControlConfig(): CostControlConfig {
  if (!cached) cached = loadCostControlConfig();
  return cached;
}

/** Test-only: force a config reload on next access. */
export function resetCostControlConfigCache(): void {
  cached = null;
}

/**
 * Safe, secret-free summary for startup logs (never prints API keys).
 */
export function formatSafePolicySummary(config: CostControlConfig = getCostControlConfig()): string {
  return [
    'Cost-control policy:',
    `  LLM primary: ${config.llm.primaryProvider}`,
    `  Paid LLM fallback: ${config.llm.allowPaidFallback ? `enabled (${config.llm.fallbackProvider})` : 'disabled'}`,
    `  LLM validation: ${config.llm.validationEnabled ? 'enabled' : 'disabled'}`,
    `  Geo provider calls: ${config.geoProviderCallsEnabled ? 'enabled' : 'disabled'}`,
    `  Places enrichment: ${config.placesEnrichmentEnabled ? 'enabled' : 'disabled'}`,
  ].join('\n');
}
