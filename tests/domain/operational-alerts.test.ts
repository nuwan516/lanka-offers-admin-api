import { evaluateOperationalAlerts, BankHealthInput } from '@/domain/operational-alerts';

describe('Operational Alerts Evaluation Engine (Batch G)', () => {
  it('generates zero alerts when all bank metrics are within normal thresholds', () => {
    const normalInputs: BankHealthInput[] = [
      {
        bank: 'hnb',
        consecutiveFailures: 0,
        lastSuccessAt: new Date(Date.now() - 4 * 3600 * 1000), // 4h ago
        lastAttemptAt: new Date(Date.now() - 4 * 3600 * 1000),
      },
      {
        bank: 'combank',
        consecutiveFailures: 0,
        lastSuccessAt: new Date(Date.now() - 12 * 3600 * 1000), // 12h ago
        lastAttemptAt: new Date(Date.now() - 12 * 3600 * 1000),
      },
    ];

    const alerts = evaluateOperationalAlerts(normalInputs);
    expect(alerts).toHaveLength(0);
  });

  it('triggers warning alert when a bank has 2 consecutive scraper failures (G2)', () => {
    const inputs: BankHealthInput[] = [
      {
        bank: 'boc',
        consecutiveFailures: 2,
        lastError: 'HTTP 503 Service Unavailable',
        lastSuccessAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    ];

    const alerts = evaluateOperationalAlerts(inputs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].component).toBe('scraper');
    expect(alerts[0].bank).toBe('boc');
    expect(alerts[0].description).toContain('2 consecutive failures');
  });

  it('escalates to critical alert when consecutive failures reach 3 or more (G2)', () => {
    const inputs: BankHealthInput[] = [
      {
        bank: 'sampath',
        consecutiveFailures: 3,
        lastError: 'Nuxt headless browser timeout',
        lastSuccessAt: new Date(Date.now() - 36 * 3600 * 1000),
      },
    ];

    const alerts = evaluateOperationalAlerts(inputs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('critical');
    expect(alerts[0].description).toContain('3 consecutive failures');
  });

  it('triggers stale feed alert when no successful scrape has occurred in > 48 hours (G2)', () => {
    const inputs: BankHealthInput[] = [
      {
        bank: 'peoples',
        consecutiveFailures: 0,
        lastSuccessAt: new Date(Date.now() - 72 * 3600 * 1000), // 72 hours ago
      },
    ];

    const alerts = evaluateOperationalAlerts(inputs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].component).toBe('freshness');
    expect(alerts[0].title).toContain('Stale offer feed');
    expect(alerts[0].description).toContain('72 hours');
  });

  it('triggers quality degradation alert when validation error rate exceeds 30% (G2)', () => {
    const inputs: BankHealthInput[] = [
      {
        bank: 'ndb',
        consecutiveFailures: 0,
        lastSuccessAt: new Date(Date.now() - 10 * 3600 * 1000),
        validationErrorRate: 0.45, // 45% error rate
      },
    ];

    const alerts = evaluateOperationalAlerts(inputs);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe('warning');
    expect(alerts[0].component).toBe('quality');
    expect(alerts[0].description).toContain('45%');
  });
});
