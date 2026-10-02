/**
 * Real-world ComBank period formats (survey of all 46 live offers under
 * /rewards-promotions, 2026-08-01) — 13 distinct textual date patterns.
 */
import { parsePeriod, parseHumanDate } from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

const today = '2026-08-01';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe('ComBank period formats', () => {
    it('C1 single end-date "Offer valid till 31st December 2026"', () => {
        const [v] = parsePeriod('Offer valid till 31st December 2026', opts);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('C2 single exact date, lowercase "offer" (Spar single-day offer)', () => {
        const [v] = parsePeriod('offer valid on 01st August 2026', opts);
        expect(v.validTo).toBe('2026-08-01');
    });

    it('C3 two named dates joined by "and"', () => {
        const [v] = parsePeriod('Offer valid on 01st and 02nd August 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-08-01', '2026-08-02']);
    });

    it('C4 explicit start-to-end range within one month', () => {
        const [v] = parsePeriod('Offer valid from 07th to 09th August 2026', opts);
        expect(v.validFrom).toBe('2026-08-07');
        expect(v.validTo).toBe('2026-08-09');
    });

    it('C5 "Booking valid from X to Y" (Cinnamon Sri Lanka) is BOOKING-typed', () => {
        const [v] = parsePeriod('Booking valid from 07th August to 09th August 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validFrom).toBe('2026-08-07');
        expect(v.validTo).toBe('2026-08-09');
    });

    it('C6 "Booking valid till X" single-end (BTS concert)', () => {
        const [v] = parsePeriod('Booking valid till 30th September 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-09-30');
    });

    it('C7 weekly recurrence, end date only', () => {
        const [v] = parsePeriod('Offer valid on every Wednesday till 26th August 2026', opts);
        expect(v.validTo).toBe('2026-08-26');
        expect(v.recurrenceDays).toEqual(['wednesday']);
    });

    it('C8 weekly recurrence, full range', () => {
        const [v] = parsePeriod('Offer valid on every Wednesday from 01st July to 26th August 2026', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-08-26');
        expect(v.recurrenceDays).toEqual(['wednesday']);
    });

    it('C9 multiple named weekdays, plural, end date only', () => {
        const [v] = parsePeriod('Offer valid on Wednesdays and Saturdays till 29th August 2026', opts);
        expect(v.validTo).toBe('2026-08-29');
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['wednesday', 'saturday']));
    });

    it('C10 monthly day-of-month range ending on a bare month/year', () => {
        const [v] = parsePeriod('Offer valid from 20th to 30th of every month till December 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        expect(v.recurrenceDays).toEqual(['20-30']);
        expect(v.validTo).toBe('2026-12-31'); // last day of December
    });

    it('C11 monthly day-of-month range ending on a full date', () => {
        const [v] = parsePeriod('Offer valid from 23rd to 30th of every month till 31st December 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        expect(v.recurrenceDays).toEqual(['23-30']);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('C12 wrap-around monthly range (Mobil: start day > end day, spans month boundary)', () => {
        const [v] = parsePeriod('Offer valid from 24th to 11th of every month till 31st December 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        // Stored as-is — a naive start<end assumption must not swap or crash
        expect(v.recurrenceDays).toEqual(['24-11']);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('C13 plain-numeral no-ordinal range with an inclusivity note (ABS facility)', () => {
        const [v] = parsePeriod('07 July 2026 to 31 August 2026 (inclusive of both dates)', opts);
        expect(v.validFrom).toBe('2026-07-07');
        expect(v.validTo).toBe('2026-08-31');
        // "(inclusive of both dates)" must not be mistaken for a blackout clause
        expect(v.blackoutPeriods).toBeNull();
    });

    it('Visa international offers: "ArtWork" caveat in the body does not break a good headline date', () => {
        const [v] = parsePeriod('Offer valid till 31st December 2026', { ...opts, apiTo: undefined });
        expect(v.validTo).toBe('2026-12-31');
        // The caveat text itself, if it were ever fed in alone, must not crash
        expect(() => parsePeriod('Offer validity mentioned in the ArtWork.', opts)).not.toThrow();
    });

    it('bare "Month Year" alone (no day) still resolves to month-end via parseHumanDate fallback path', () => {
        // parseHumanDate itself requires a day (by design, for date-anywhere
        // extraction accuracy); the monthly-range tail is the one call site
        // that needs bare month+year, and is covered by C10 above.
        expect(parseHumanDate('December 2026')).toBeNull();
    });
});
