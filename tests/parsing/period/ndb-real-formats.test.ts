/**
 * Real-world NDB period formats (July 2026 survey: 105 offers on
 * ndbbank.com/cards/card-offers, "Offer valid period :" field).
 */
import { parsePeriod } from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

const today = '2026-07-18';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe('NDB period formats', () => {
    it('N1 dominant "Until 31st July 2026" (76/105)', () => {
        const [v] = parsePeriod('Until 31st July 2026', opts);
        expect(v.validTo).toBe('2026-07-31');
    });

    it('N2 lowercase "until 23rd July 2026"', () => {
        const [v] = parsePeriod('until 23rd July 2026', opts);
        expect(v.validTo).toBe('2026-07-23');
    });

    it('N3 "Booking & Stay Period - Until 30th November 2026" (12/105) is typed', () => {
        const [v] = parsePeriod('Booking & Stay Period - Until 30th November 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-11-30');
    });

    it('N4 "Booking Period - Until 31st July 2026" (4/105)', () => {
        const [v] = parsePeriod('Booking Period - Until 31st July 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-07-31');
    });

    it('N5 "Booking & Travel Period - Until 31st December 2026"', () => {
        const [v] = parsePeriod('Booking & Travel Period - Until 31st December 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('N6 hyphen range without Until: "11th -23rd July 2026"', () => {
        const [v] = parsePeriod('11th -23rd July 2026', opts);
        expect(v.validFrom).toBe('2026-07-11');
        expect(v.validTo).toBe('2026-07-23');
    });

    it('N7 en-dash range: "11th – 23rd July 2026"', () => {
        const [v] = parsePeriod('11th – 23rd July 2026', opts);
        expect(v.validFrom).toBe('2026-07-11');
        expect(v.validTo).toBe('2026-07-23');
    });

    it('N8 two specific dates "15th & 29th July 2026"', () => {
        const [v] = parsePeriod('15th & 29th July 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-15', '2026-07-29']);
    });

    it('N9 "Every Thursday till 27th August 2026"', () => {
        const [v] = parsePeriod('Every Thursday till 27th August 2026', opts);
        expect(v.validTo).toBe('2026-08-27');
        expect(v.recurrenceDays).toEqual(['thursday']);
    });

    it('N10 recurring monthly: "20th - Month end in Every month 2026"', () => {
        const [v] = parsePeriod('20th - Month end in Every month 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        expect(v.recurrenceDays).toEqual(['20-31']);
    });

    it('N11 missing period field → open-ended validity, no crash', () => {
        const [v] = parsePeriod('', opts);
        expect(v.validFrom).toBe(today);
        expect(v.validTo).toBeNull();
    });

    it('regression: Sampath colon-form dual labels still split correctly', () => {
        const result = parsePeriod(
            'Booking period: 1st Jan to 28th Feb 2026 Travel period: 1st Mar to 31st Mar 2026',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].periodType).toBe(PeriodType.BOOKING);
        expect(result[1].periodType).toBe(PeriodType.TRAVEL);
    });
});
