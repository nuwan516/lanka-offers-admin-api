/**
 * CostGuard — one small reusable quota gate for optional external calls
 * (LLM validation, geocoding, places enrichment).
 *
 * Decisions are ALLOW / WARN / BLOCK, driven entirely by configuration
 * (see `src/config/cost-control.ts`) plus the current month's usage counter
 * in Postgres (`external_api_usage`). No provider-specific quota assumptions
 * are hardcoded here — a limit of 0 or `enabled: false` simply blocks.
 *
 * BLOCK must never crash the caller: the scraper/geocoder continues
 * processing other offers, just without this optional call.
 */

import { getServiceUsage } from '@/infrastructure/db/offer-repository';
import { getCostControlConfig, type ServiceQuotaConfig } from '@/config/cost-control';

export type CostGuardVerdict = 'ALLOW' | 'WARN' | 'BLOCK';

export interface CostGuardDecision {
  verdict: CostGuardVerdict;
  service: string;
  used: number;
  limit: number;
  percentage: number;
  reason: string;
}

function decide(config: ServiceQuotaConfig, used: number): CostGuardDecision {
  if (!config.enabled) {
    return { verdict: 'BLOCK', service: config.service, used, limit: config.limit, percentage: 0, reason: 'service disabled by config' };
  }
  if (config.limit <= 0) {
    return { verdict: 'BLOCK', service: config.service, used, limit: config.limit, percentage: 0, reason: 'no quota configured (limit=0)' };
  }

  const percentage = Math.round((used / config.limit) * 100);
  if (percentage >= config.blockPercent) {
    return { verdict: 'BLOCK', service: config.service, used, limit: config.limit, percentage, reason: `usage at ${percentage}% >= block threshold ${config.blockPercent}%` };
  }
  if (percentage >= config.warnPercent) {
    return { verdict: 'WARN', service: config.service, used, limit: config.limit, percentage, reason: `usage at ${percentage}% >= warn threshold ${config.warnPercent}%` };
  }
  return { verdict: 'ALLOW', service: config.service, used, limit: config.limit, percentage, reason: 'within budget' };
}

/**
 * Pure decision function — takes usage as a parameter so it's trivially
 * unit-testable without a database.
 */
export function evaluateCostGuard(config: ServiceQuotaConfig, used: number): CostGuardDecision {
  return decide(config, used);
}

export class CostGuard {
  /** Short in-memory cache so a batch of 100 offers doesn't issue 100 usage queries. */
  private cache = new Map<string, { decision: CostGuardDecision; expiresAt: number }>();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlMs = 15_000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  async canCall(service: string): Promise<CostGuardDecision> {
    const cached = this.cache.get(service);
    if (cached && cached.expiresAt > Date.now()) return cached.decision;

    const config = getCostControlConfig().services[service];
    if (!config) {
      const decision: CostGuardDecision = { verdict: 'BLOCK', service, used: 0, limit: 0, percentage: 0, reason: `unknown service "${service}"` };
      this.cache.set(service, { decision, expiresAt: Date.now() + this.cacheTtlMs });
      return decision;
    }

    let used = 0;
    try {
      used = await getServiceUsage(service);
    } catch {
      // DB unreachable — fail safe by blocking the optional call rather than
      // crashing the caller or silently generating unmetered cost.
      const decision: CostGuardDecision = { verdict: 'BLOCK', service, used: 0, limit: config.limit, percentage: 0, reason: 'usage lookup failed; failing safe' };
      this.cache.set(service, { decision, expiresAt: Date.now() + this.cacheTtlMs });
      return decision;
    }

    const decision = decide(config, used);
    this.cache.set(service, { decision, expiresAt: Date.now() + this.cacheTtlMs });
    return decision;
  }

  /** Drop cached decisions immediately after recording a call, so the next
   *  check in the same run sees the incremented count. */
  invalidate(service: string): void {
    this.cache.delete(service);
  }
}

/** Process-wide singleton — usage counters are shared across a scrape run. */
export const costGuard = new CostGuard();
