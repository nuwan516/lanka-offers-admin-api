/**
 * Operational Alerts & Reliability Health Engine (Batch G)
 *
 * Evaluates actionable conditions:
 * - Multiple consecutive scraper failures (>= 2).
 * - Stale feeds (> 48h without successful scrape).
 * - Degraded extraction quality (> 30% error rate).
 */

export interface OperationalAlert {
  id: string;
  level: 'info' | 'warning' | 'critical';
  component: string;
  bank?: string;
  title: string;
  description: string;
  triggeredAt: string;
}

export interface BankHealthInput {
  bank: string;
  consecutiveFailures: number;
  lastSuccessAt?: Date | string | null;
  lastAttemptAt?: Date | string | null;
  lastError?: string | null;
  validationErrorRate?: number;
}

export function evaluateOperationalAlerts(banks: BankHealthInput[]): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  const now = Date.now();

  for (const b of banks) {
    // 1. Multiple consecutive scraper failures
    if (b.consecutiveFailures >= 2) {
      alerts.push({
        id: `alert-fail-${b.bank}`,
        level: b.consecutiveFailures >= 3 ? 'critical' : 'warning',
        component: 'scraper',
        bank: b.bank,
        title: `Repeated scraper failures for ${b.bank.toUpperCase()}`,
        description: `Bank ${b.bank.toUpperCase()} has experienced ${b.consecutiveFailures} consecutive failures. Last error: ${b.lastError || 'Unknown'}`,
        triggeredAt: new Date(now).toISOString(),
      });
    }

    // 2. Feed becoming stale (> 48h without successful extraction)
    if (b.lastSuccessAt) {
      const lastSuccessTime = new Date(b.lastSuccessAt).getTime();
      const elapsedHours = (now - lastSuccessTime) / (1000 * 60 * 60);
      if (elapsedHours > 48) {
        alerts.push({
          id: `alert-stale-${b.bank}`,
          level: 'warning',
          component: 'freshness',
          bank: b.bank,
          title: `Stale offer feed for ${b.bank.toUpperCase()}`,
          description: `No successful scrape in ${Math.round(elapsedHours)} hours (threshold: 48h).`,
          triggeredAt: new Date(now).toISOString(),
        });
      }
    }

    // 3. High validation failure rate (> 30%)
    if (b.validationErrorRate !== undefined && b.validationErrorRate > 0.3) {
      alerts.push({
        id: `alert-quality-${b.bank}`,
        level: 'warning',
        component: 'quality',
        bank: b.bank,
        title: `Degraded extraction quality for ${b.bank.toUpperCase()}`,
        description: `Validation error rate is ${Math.round(b.validationErrorRate * 100)}% (threshold: 30%). Potential DOM drift.`,
        triggeredAt: new Date(now).toISOString(),
      });
    }
  }

  return alerts;
}
