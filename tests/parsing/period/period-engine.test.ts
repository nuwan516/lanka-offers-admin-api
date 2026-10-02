import {
    parseHumanDate,
    extractYear,
    normalizeWeekday,
    extractRecurrenceDays,
    parsePeriod,
} from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

describe('parseHumanDate', () => {
    it('parses "31st January 2026"', () => {
        expect(parseHumanDate('31st January 2026')).toBe('2026-01-31');
    });
    it('parses "January 31, 2026"', () => {
        expect(parseHumanDate('January 31, 2026')).toBe('2026-01-31');
    });
    it('parses "20 Dec 2026"', () => {
        expect(parseHumanDate('20 Dec 2026')).toBe('2026-12-20');
    });
    it('parses typo "31st Decmber 2026"', () => {
        expect(parseHumanDate('31st Decmber 2026')).toBe('2026-12-31');
    });
    it('returns null for invalid date', () => {
        expect(parseHumanDate('not a date')).toBeNull();
    });
    it('uses fallback year if missing', () => {
        expect(parseHumanDate('15 March', 2026)).toBe('2026-03-15');
    });
});

describe('extractYear', () => {
    it('finds 2026', () => {
        expect(extractYear('Valid until 2026-12-31')).toBe(2026);
    });
    it('returns null if no year', () => {
        expect(extractYear('no year here')).toBeNull();
    });
});

describe('normalizeWeekday', () => {
    it('normalizes "mon" to monday', () => {
        expect(normalizeWeekday('mon')).toBe('monday');
    });
    it('normalizes "mondy" to monday', () => {
        expect(normalizeWeekday('mondy')).toBe('monday');
    });
    it('returns null for invalid', () => {
        expect(normalizeWeekday('xyz')).toBeNull();
    });
});

describe('extractRecurrenceDays', () => {
    it('extracts "every Monday"', () => {
        expect(extractRecurrenceDays('every Monday')).toEqual(['monday']);
    });
    it('extracts weekend', () => {
        expect(extractRecurrenceDays('Valid on weekends')).toEqual(['saturday', 'sunday']);
    });
    it('extracts range "Monday to Friday"', () => {
        expect(extractRecurrenceDays('Monday to Friday')).toEqual(
            expect.arrayContaining(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
        );
    });
    it('extracts weekdays', () => {
        expect(extractRecurrenceDays('Valid on weekdays')).toEqual(
            expect.arrayContaining(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
        );
    });
});

describe('parsePeriod', () => {
    const today = '2026-06-15';

    it('handles simple "Till 31st December 2026"', () => {
        const result = parsePeriod('Till 31st December 2026', { today });
        expect(result).toHaveLength(1);
        expect(result[0].validTo).toBe('2026-12-31');
        expect(result[0].periodType).toBe(PeriodType.OFFER);
    });

    it('handles "From 1st May to 30th May 2026"', () => {
        const result = parsePeriod('From 1st May to 30th May 2026', { today });
        expect(result[0].validFrom).toBe('2026-05-01');
        expect(result[0].validTo).toBe('2026-05-30');
    });

    it('handles range with dash "1st - 30th April 2026"', () => {
        const result = parsePeriod('1st - 30th April 2026', { today });
        expect(result[0].validFrom).toBe('2026-04-01');
        expect(result[0].validTo).toBe('2026-04-30');
    });

    it('handles "every Tuesday till 28th February 2026"', () => {
        const result = parsePeriod('every Tuesday till 28th February 2026', { today });
        expect(result[0].recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(result[0].recurrenceDays).toContain('tuesday');
        expect(result[0].validTo).toBe('2026-02-28');
    });

    it('handles "Month end"', () => {
        const result = parsePeriod('Month end January 2026', { today });
        expect(result[0].validTo).toBe('2026-01-31');
    });

    it('handles monthly range "1st to 28th of each month"', () => {
        const result = parsePeriod('1st to 28th of each month', { today });
        expect(result[0].recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        expect(result[0].recurrenceDays).toEqual(['1-28']);
    });

    it('handles specific dates "21st & 22nd March 2026"', () => {
        const result = parsePeriod('21st & 22nd March 2026', { today });
        expect(result[0].recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(result[0].recurrenceDays).toContain('2026-03-21');
        expect(result[0].recurrenceDays).toContain('2026-03-22');
    });

    it('handles multi‑period labels', () => {
        const text = 'Booking period: 1st Jan to 28th Feb 2026 Travel period: 1st Mar to 31st Mar 2026';
        const result = parsePeriod(text, { today });
        expect(result).toHaveLength(2);
        expect(result[0].periodType).toBe(PeriodType.BOOKING);
        expect(result[1].periodType).toBe(PeriodType.TRAVEL);
    });

    it('falls back to API dates if only they exist', () => {
        const result = parsePeriod('', { today, apiFrom: '2026-07-01', apiTo: '2026-07-31' });
        expect(result[0].validFrom).toBe('2026-07-01');
        expect(result[0].validTo).toBe('2026-07-31');
    });

    it('swaps reversed dates (from > to)', () => {
        const result = parsePeriod('From 31st August 2026 to 25th July 2026', { today });
        expect(result[0].validFrom).toBe('2026-07-25');
        expect(result[0].validTo).toBe('2026-08-31');
    });

    it('does not invent a future validFrom when fallback today is after an expired deadline', () => {
        // e.g. An offer that ended in Dec 2025 parsed on today = 2026-06-15
        const result = parsePeriod('Until 20th December 2025', { today });
        expect(result[0].validTo).toBe('2025-12-20');
        expect(result[0].validFrom).toBeNull(); // Must not be 2026-06-15 (which would invert from > to)
    });

    it('leaves validFrom as null when only an expired apiTo is given without apiFrom', () => {
        const result = parsePeriod('', { today, apiTo: '2025-12-31' });
        expect(result[0].validTo).toBe('2025-12-31');
        expect(result[0].validFrom).toBeNull();
    });

    it('sanitizes invalid dates', () => {
        const result = parsePeriod('', { today, apiFrom: '2026-10-35', apiTo: '2026-08-00' });
        expect(result[0].validFrom).toBe(today); // falls back to today because apiFrom is invalid
        expect(result[0].validTo).toBeNull(); // falls back to null because apiTo is invalid
    });

    it('correctly parses date ranges embedded after "Up to X%" discounts without hijacking range', () => {
        const text = 'Reservations : 074 253 2186 | 077 942 6570 Up to 50% off on rack rates for BOC Credit Cardholders From 01st September to 30th November 2026 *Conditions apply.';
        const result = parsePeriod(text, { today: '2026-09-04' });
        expect(result[0].validFrom).toBe('2026-09-01');
        expect(result[0].validTo).toBe('2026-11-30');
    });

    it('correctly parses compact "Period – 8th to 15th Dec 2025" preceded by "to all the customers"', () => {
        const text = 'Exclusive 10% discount to all the customers. Applicable categories – Flowers Period – 8th to 15th Dec 2025 (7 days)';
        const result = parsePeriod(text, { today: '2026-09-04' });
        expect(result[0].validFrom).toBe('2025-12-08');
        expect(result[0].validTo).toBe('2025-12-15');
    });

    it('reconciles with apiTo when description text contains earlier start date', () => {
        const text = 'Up to 40% off for BOC Credit Cardholders From 01st September to 30th November 2026';
        const result = parsePeriod(text, { today: '2026-09-04', apiTo: '2026-11-30' });
        expect(result[0].validFrom).toBe('2026-09-01');
        expect(result[0].validTo).toBe('2026-11-30');
    });
});