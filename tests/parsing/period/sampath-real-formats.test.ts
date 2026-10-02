/**
 * Real-world Sampath Bank period formats (July 2026 survey: 100 offers,
 * 109 period entries — manual content entry, so typos are part of the spec).
 */
import { parsePeriod, parseHumanDate, extractTimeWindow } from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

const today = '2026-07-17';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe('Sampath period formats', () => {
    it('S1 dominant "Valid till 20th July 2026" (53/109)', () => {
        const [v] = parsePeriod('Valid till 20th July 2026', opts);
        expect(v.validTo).toBe('2026-07-20');
    });

    it('S2 bare range "14th July to 31st August 2026" (24/109)', () => {
        const [v] = parsePeriod('14th July to 31st August 2026', opts);
        expect(v.validFrom).toBe('2026-07-14');
        expect(v.validTo).toBe('2026-08-31');
    });

    it('S3 "Valid from 08th July to 31st August 2026" (14/109)', () => {
        const [v] = parsePeriod('Valid from 08th July to 31st August 2026', opts);
        expect(v.validFrom).toBe('2026-07-08');
        expect(v.validTo).toBe('2026-08-31');
    });

    it('S4 specific days "Valid on 11th & 25th July 2026"', () => {
        const [v] = parsePeriod('Valid on 11th & 25th July 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-11', '2026-07-25']);
    });

    it('S5 "Every Sunday till 26th July 2026"', () => {
        const [v] = parsePeriod('Every Sunday till 26th July 2026', opts);
        expect(v.validTo).toBe('2026-07-26');
        expect(v.recurrenceDays).toEqual(['sunday']);
    });

    it('S6 mixed till/to typo "Valid till 16th July to 18th July 2026"', () => {
        const [v] = parsePeriod('Valid till 16th July to 18th July 2026', opts);
        expect(v.validFrom).toBe('2026-07-16');
        expect(v.validTo).toBe('2026-07-18');
    });

    it('S7 "From 1st July till 30th September 2026"', () => {
        const [v] = parsePeriod('From 1st July till 30th September 2026', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-09-30');
    });

    it('S8 typo "Valid form 1st July till 31st October 2026"', () => {
        const [v] = parsePeriod('Valid form 1st July till 31st October 2026', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-10-31');
    });

    it('S9 "Valid for 01st July to 15th August 2026"', () => {
        const [v] = parsePeriod('Valid for 01st July to 15th August 2026', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-08-15');
    });

    it('S10 single date "Valid only on 31st July 2026"', () => {
        const [v] = parsePeriod('Valid only on 31st July 2026', opts);
        expect(v.validTo).toBe('2026-07-31');
    });

    it('S11 "Before 31st December 2026"', () => {
        const [v] = parsePeriod('Before 31st December 2026', opts);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('S12 "Valid on every Thursdays till 28th February 2027"', () => {
        const [v] = parsePeriod('Valid on every Thursdays till 28th February 2027', { ...opts, fallbackYear: 2027 });
        expect(v.validTo).toBe('2027-02-28');
        expect(v.recurrenceDays).toEqual(['thursday']);
    });

    it('S13 "Valid every Thursday till 31st July 2026"', () => {
        const [v] = parsePeriod('Valid every Thursday till 31st July 2026', opts);
        expect(v.validTo).toBe('2026-07-31');
        expect(v.recurrenceDays).toEqual(['thursday']);
    });

    it('S14 ordinal typo "31at July 2026"', () => {
        expect(parseHumanDate('31at July 2026')).toBe('2026-07-31');
        const [v] = parsePeriod('Valid till 31at July 2026', opts);
        expect(v.validTo).toBe('2026-07-31');
    });

    it('S15 placeholder text falls back to API expiry', () => {
        const [v] = parsePeriod('Offer Details', { ...opts, apiTo: '2026-09-30' });
        expect(v.validTo).toBe('2026-09-30');
        const [v2] = parsePeriod('Please refer the Artwork', { ...opts, apiTo: '2026-09-30' });
        expect(v2.validTo).toBe('2026-09-30');
    });

    it('S16 long descriptive sentence with weekdays + single-suffix time range', () => {
        const [v] = parsePeriod(
            'Offer is valid every Monday, Friday & Saturday from 07th to 28th July 2026, 6:00-7:00 PM',
            opts
        );
        expect(v.validFrom).toBe('2026-07-07');
        expect(v.validTo).toBe('2026-07-28');
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['monday', 'friday', 'saturday']));
        expect(v.timeWindow).toEqual({ from: '18:00', to: '19:00' });
    });

    it('dual periods: Booking Period + Stay Period typed separately', () => {
        const result = parsePeriod(
            'Booking Period: Valid till 31st July 2026 Stay Period: 1st August to 31st October 2026',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].periodType).toBe(PeriodType.BOOKING);
        expect(result[0].validTo).toBe('2026-07-31');
        expect(result[1].periodType).toBe(PeriodType.STAY);
        expect(result[1].validFrom).toBe('2026-08-01');
        expect(result[1].validTo).toBe('2026-10-31');
    });

    it('single labeled sub-period keeps its type ("Booking Period: ..." alone)', () => {
        const [v] = parsePeriod('Booking Period: Valid till 31st July 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-07-31');
    });
});

describe('extractTimeWindow — single-suffix meridiem', () => {
    it('infers first meridiem from second: "6:00-7:00 PM" → 18:00–19:00', () => {
        expect(extractTimeWindow('6:00-7:00 PM')).toEqual({ from: '18:00', to: '19:00' });
    });
    it('does not treat date ranges as times ("07th to 28th July")', () => {
        expect(extractTimeWindow('from 07th to 28th July 2026')).toBeNull();
    });
});
