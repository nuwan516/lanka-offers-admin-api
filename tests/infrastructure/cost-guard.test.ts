import { evaluateCostGuard, CostGuard } from '@/infrastructure/cost-control/cost-guard';
import type { ServiceQuotaConfig } from '@/config/cost-control';

jest.mock('@/infrastructure/db/offer-repository', () => ({
  getServiceUsage: jest.fn(),
}));
import { getServiceUsage } from '@/infrastructure/db/offer-repository';

function makeConfig(overrides: Partial<ServiceQuotaConfig> = {}): ServiceQuotaConfig {
  return { service: 'gemini_llm', limit: 100, warnPercent: 70, blockPercent: 95, enabled: true, ...overrides };
}

describe('evaluateCostGuard (pure decision function)', () => {
  it('ALLOWs when usage is well under budget', () => {
    expect(evaluateCostGuard(makeConfig(), 10).verdict).toBe('ALLOW');
  });

  it('WARNs at/above the warn threshold', () => {
    expect(evaluateCostGuard(makeConfig(), 70).verdict).toBe('WARN');
    expect(evaluateCostGuard(makeConfig(), 94).verdict).toBe('WARN');
  });

  it('BLOCKs at/above the block threshold', () => {
    const decision = evaluateCostGuard(makeConfig(), 95);
    expect(decision.verdict).toBe('BLOCK');
    expect(decision.percentage).toBe(95);
  });

  it('BLOCKs when the service is disabled regardless of usage', () => {
    expect(evaluateCostGuard(makeConfig({ enabled: false }), 0).verdict).toBe('BLOCK');
  });

  it('BLOCKs when limit is 0 (no quota configured — e.g. paid fallback by default)', () => {
    expect(evaluateCostGuard(makeConfig({ limit: 0 }), 0).verdict).toBe('BLOCK');
  });

  it('thresholds are configuration, not hardcoded — a custom config changes the outcome', () => {
    const lenient = makeConfig({ warnPercent: 90, blockPercent: 99 });
    expect(evaluateCostGuard(lenient, 80).verdict).toBe('ALLOW');
  });
});

describe('CostGuard (DB-backed usage lookup)', () => {
  const mockedGetServiceUsage = getServiceUsage as jest.Mock;
  beforeEach(() => mockedGetServiceUsage.mockReset());

  it('ALLOWs an unblocked, low-usage service', async () => {
    mockedGetServiceUsage.mockResolvedValueOnce(5);
    const guard = new CostGuard();
    const decision = await guard.canCall('gemini_llm');
    expect(decision.verdict).toBe('ALLOW');
  });

  it('fails safe (BLOCK) when the usage lookup throws, instead of crashing the caller', async () => {
    mockedGetServiceUsage.mockRejectedValueOnce(new Error('connection refused'));
    const guard = new CostGuard();
    const decision = await guard.canCall('gemini_llm');
    expect(decision.verdict).toBe('BLOCK');
  });

  it('BLOCKs an unknown service name rather than allowing an unmetered call', async () => {
    const guard = new CostGuard();
    const decision = await guard.canCall('unknown_service');
    expect(decision.verdict).toBe('BLOCK');
    expect(mockedGetServiceUsage).not.toHaveBeenCalled();
  });

  it('caches a decision briefly so a batch of calls issues one usage query', async () => {
    mockedGetServiceUsage.mockResolvedValue(5);
    const guard = new CostGuard(60_000);
    await guard.canCall('gemini_llm');
    await guard.canCall('gemini_llm');
    await guard.canCall('gemini_llm');
    expect(mockedGetServiceUsage).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops the cache so the next call re-checks usage', async () => {
    mockedGetServiceUsage.mockResolvedValue(5);
    const guard = new CostGuard(60_000);
    await guard.canCall('gemini_llm');
    guard.invalidate('gemini_llm');
    await guard.canCall('gemini_llm');
    expect(mockedGetServiceUsage).toHaveBeenCalledTimes(2);
  });
});
