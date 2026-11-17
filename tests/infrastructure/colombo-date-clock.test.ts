/**
 * valid_to is inclusive through the Asia/Colombo calendar day.
 * CURRENT_DATE follows the session, and toISOString() is UTC. Both are wrong
 * between 00:00 and 05:30 in Colombo. These assertions fail if either comes back.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CustomRule } from '@/infrastructure/repositories/rule-config.repository';
import { buildOfferListQuery } from '@/api/offer-query-scope';

const mockQuery = jest.fn();

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  withTransaction: jest.fn(),
}));

import { GeoRepository } from '@/infrastructure/repositories/geo.repository';
import { evalCustomRule } from '@/infrastructure/repositories/rule-config.repository';

const COLOMBO_TODAY = "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Colombo')::date";

function rule(partial: Pick<CustomRule, 'operator' | 'field_path' | 'config'>): CustomRule {
  return {
    id: 'r1',
    name: 'expiry',
    description: null,
    group_name: 'Dates',
    severity: 'error',
    enabled: true,
    notes: null,
    is_builtin: true,
    builtin_id: 'offer_expired',
    banks: null,
    ...partial,
  };
}

describe('Asia/Colombo validity clock', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('public offer queries use the Colombo calendar date, not CURRENT_DATE', () => {
    const pub = buildOfferListQuery({});
    expect(pub.whereSql).toContain(`valid_to >= ${COLOMBO_TODAY}`);
    expect(pub.whereSql).not.toContain('CURRENT_DATE');
  });

  it('nearby offers use the Colombo calendar date, not CURRENT_DATE', async () => {
    await new GeoRepository().findNearbyOffers({ lat: 6.9, lng: 79.8 });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain(`o.valid_to >= ${COLOMBO_TODAY}`);
    expect(sql).not.toContain('CURRENT_DATE');
  });

  it('expiry reconciliation compares valid_to to the Colombo date, not CURRENT_DATE', () => {
    // The workflow module does not typecheck until the unrelated `terms` error
    // is fixed, so this reads the predicate in place instead of importing it.
    const src = readFileSync(
      join(process.cwd(), 'src/infrastructure/db/offer-workflow-repository.ts'),
      'utf8',
    );
    const predicates = src.split('\n').filter((line) => /AND valid_to\s*</.test(line));
    expect(predicates).toHaveLength(2);
    for (const line of predicates) {
      expect(line).toContain(`valid_to < ${COLOMBO_TODAY}`);
      expect(line).not.toContain('CURRENT_DATE');
    }
  });

  it('not_expired and array_any_not_expired end the valid_to day in Colombo, not UTC', () => {
    // 00:30 on 1 Aug Colombo is still 31 Jul UTC. The valid_to day has ended.
    jest.useFakeTimers({ now: new Date('2026-07-31T19:00:00.000Z') });
    try {
      const single = evalCustomRule(
        rule({ operator: 'not_expired', field_path: 'validTo', config: {} }),
        { validTo: '2026-07-31' },
      );
      expect(single.passed).toBe(false);

      const periods = evalCustomRule(
        rule({
          operator: 'array_any_not_expired',
          field_path: 'validityPeriods',
          config: { date_field: 'validTo' },
        }),
        { validityPeriods: [{ validTo: '2026-07-31' }] },
      );
      expect(periods.passed).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps valid_to on the Colombo day it names', () => {
    // 22:30 on 31 Jul Colombo is the same UTC calendar day, and still that Colombo day.
    jest.useFakeTimers({ now: new Date('2026-07-31T17:00:00.000Z') });
    try {
      const single = evalCustomRule(
        rule({ operator: 'not_expired', field_path: 'validTo', config: {} }),
        { validTo: '2026-07-31' },
      );
      expect(single.passed).toBe(true);

      const periods = evalCustomRule(
        rule({
          operator: 'array_any_not_expired',
          field_path: 'validityPeriods',
          config: { date_field: 'validTo' },
        }),
        { validityPeriods: [{ validTo: '2026-07-31' }] },
      );
      expect(periods.passed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
