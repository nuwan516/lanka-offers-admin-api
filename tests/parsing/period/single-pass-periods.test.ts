/**
 * One parsePeriod call must read dates the bank parsers used to pre-cut:
 * BOC "31 Dec 2026" as apiTo, a PABC sentence that ends in "until <date>",
 * and a ComBank headline beside a Stay/Booking Period dash label.
 */
import { parsePeriod } from '@/parsing/period/period-engine';
import { PeriodType } from '@/core/types/offers';
import cases from './fixtures/single-pass-periods.json';

interface GoldenExpect {
    validTo: string;
    periodType: PeriodType;
}

interface GoldenCase {
    id: string;
    bank: string;
    text: string;
    apiTo?: string;
    today: string;
    fallbackYear: number;
    expect: GoldenExpect[];
}

describe('single-pass period fixtures', () => {
    it.each(cases as GoldenCase[])('$bank $id', (row) => {
        const result = parsePeriod(row.text, {
            today: row.today,
            fallbackYear: row.fallbackYear,
            apiTo: row.apiTo,
        });
        expect(result).toHaveLength(row.expect.length);
        row.expect.forEach((expected, index) => {
            expect(result[index].periodType).toBe(expected.periodType);
            expect(result[index].validTo).toBe(expected.validTo);
        });
    });
});
