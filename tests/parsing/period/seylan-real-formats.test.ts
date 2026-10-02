/**
 * Real-world Seylan period formats (July 2026 survey: 156 offers, the
 * messiest period field of all surveyed banks — 19 recurring patterns,
 * ~1 in 10 entries carries a typo).
 */
import { parsePeriod } from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

const today = '2026-07-18';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe('Seylan period formats', () => {
    it('Y1 dominant "Valid until 31st December 2026" (70/156)', () => {
        const [v] = parsePeriod('Valid until 31st December 2026', opts);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('Y2 dash range "Valid from 01st August - 30th September 2026" (16/156)', () => {
        const [v] = parsePeriod('Valid from 01st August - 30th September 2026', opts);
        expect(v.validFrom).toBe('2026-08-01');
        expect(v.validTo).toBe('2026-09-30');
    });

    it('Y3 dual Offer + EPP dates split into typed periods (13/156)', () => {
        const result = parsePeriod(
            'Offer valid until 31st August 2026 EPP valid until 31st December 2026',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].periodType).toBe(PeriodType.OFFER);
        expect(result[0].validTo).toBe('2026-08-31');
        expect(result[1].periodType).toBe(PeriodType.INSTALLMENT);
        expect(result[1].validTo).toBe('2026-12-31');
    });

    it('Y4 no ordinal suffix "Valid until 31 December 2026" (9/156)', () => {
        const [v] = parsePeriod('Valid until 31 December 2026', opts);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('Y5 EPP-only "EPP valid until 31st December 2026" (7/156) is INSTALLMENT-typed', () => {
        const [v] = parsePeriod('EPP valid until 31st December 2026', opts);
        expect(v.periodType).toBe(PeriodType.INSTALLMENT);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('Y6 "Offers valid from 24th - 26th July 2026"', () => {
        const [v] = parsePeriod('Offers valid from 24th - 26th July 2026', opts);
        expect(v.periodType).toBe(PeriodType.OFFER);
        expect(v.validFrom).toBe('2026-07-24');
        expect(v.validTo).toBe('2026-07-26');
    });

    it('Y7 "Booking Period : 19th - 21st July 2026" is BOOKING-typed', () => {
        const [v] = parsePeriod('Booking Period : 19th - 21st July 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validFrom).toBe('2026-07-19');
        expect(v.validTo).toBe('2026-07-21');
    });

    it('Y8 "Offer valid until 31st July 2026"', () => {
        const [v] = parsePeriod('Offer valid until 31st July 2026', opts);
        expect(v.validTo).toBe('2026-07-31');
    });

    it('Y9 "Valid every Saturday until 25th July 2026"', () => {
        const [v] = parsePeriod('Valid every Saturday until 25th July 2026', opts);
        expect(v.validTo).toBe('2026-07-25');
        expect(v.recurrenceDays).toEqual(['saturday']);
    });

    it('Y10 "Easy Payment Plans valid until 31st December 2026" is INSTALLMENT-typed', () => {
        const [v] = parsePeriod('Easy Payment Plans valid until 31st December 2026', opts);
        expect(v.periodType).toBe(PeriodType.INSTALLMENT);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('Y11 numeric DD.MM.YYYY "Booking Period – 01.04.2026 to 30.09.2026"', () => {
        const [v] = parsePeriod('Booking Period – 01.04.2026 to 30.09.2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validFrom).toBe('2026-04-01');
        expect(v.validTo).toBe('2026-09-30');
    });

    it('Y12 typo soup "Valid on 29h & 30th Ju;ly 2026"', () => {
        const [v] = parsePeriod('Valid on 29h & 30th Ju;ly 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-29', '2026-07-30']);
    });

    it('Y13 "Validity from 01st May to 31st July 2026"', () => {
        const [v] = parsePeriod('Validity from 01st May to 31st July 2026', opts);
        expect(v.validFrom).toBe('2026-05-01');
        expect(v.validTo).toBe('2026-07-31');
    });

    it('Y14 multi-month specific dates "27th June & 25th July (Saturdays)"', () => {
        const [v] = parsePeriod('Offer valid on below dates only 27th June & 25th July (Saturdays)', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-06-27', '2026-07-25']);
    });

    it('Y15 named sub-campaigns each get their own range', () => {
        const result = parsePeriod(
            'General Campaign : 20th March – 12th April 2026 / Exclusive Cardholder Offer : 27th – 30th March',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].validFrom).toBe('2026-03-20');
        expect(result[0].validTo).toBe('2026-04-12');
        expect(result[1].validFrom).toBe('2026-03-27');
        expect(result[1].validTo).toBe('2026-03-30');
    });

    it('Y16 named-occasion + EPP: Mother\'s Day offer', () => {
        const result = parsePeriod(
            "Mother's Day Offer - 01st May to 12th May 2026, Installment Plans valid until 31st December 2026",
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].validFrom).toBe('2026-05-01');
        expect(result[0].validTo).toBe('2026-05-12');
        expect(result[1].periodType).toBe(PeriodType.INSTALLMENT);
        expect(result[1].validTo).toBe('2026-12-31');
    });

    it('Y17 "Booking & Stay Periods: until 30th November 2026"', () => {
        const [v] = parsePeriod('Booking & Stay Periods: until 30th November 2026', opts);
        expect(v.periodType).toBe(PeriodType.BOOKING);
        expect(v.validTo).toBe('2026-11-30');
    });

    it('Y18 stray punctuation "EPP valid ; 15th - 31st July 2026"', () => {
        const [v] = parsePeriod('EPP valid ; 15th - 31st July 2026', opts);
        expect(v.periodType).toBe(PeriodType.INSTALLMENT);
        expect(v.validFrom).toBe('2026-07-15');
        expect(v.validTo).toBe('2026-07-31');
    });

    it('Y19 month typo "Valid until 31st Dcember 2026"', () => {
        const [v] = parsePeriod('Valid until 31st Dcember 2026', opts);
        expect(v.validTo).toBe('2026-12-31');
    });
});
