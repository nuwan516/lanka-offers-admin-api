/**
 * Real-world HNB period formats.
 *
 * Every case below was observed on the live HNB Card Promotions page
 * (561 offers surveyed, July 2026): 22 card short-hand formats plus the
 * long-form "Period:" structures inside the View More modal.
 */
import { parsePeriod } from '@/parsing/period/period-engine';
import { RecurrenceType, PeriodType } from '@/core/types/offers';

const today = '2026-07-12';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

// ─── Card short-hand formats (shown on the offer card itself) ─────────────────

describe('HNB card short-hand formats', () => {
    it('#1 "Valid Until YYYY-MM-DD" (majority format)', () => {
        const [v] = parsePeriod('Valid Until 2026-08-31', opts);
        expect(v.validTo).toBe('2026-08-31');
    });

    it('#2 "Valid From YYYY-MM-DD to YYYY-MM-DD"', () => {
        const [v] = parsePeriod('Valid From 2026-04-01 to 2026-12-31', opts);
        expect(v.validFrom).toBe('2026-04-01');
        expect(v.validTo).toBe('2026-12-31');
    });

    it('#3 "Valid On (Day) DATE & DATE" — specific date list', () => {
        const [v] = parsePeriod('Valid On (Saturday) 2026-07-18 & 2026-07-25', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-18', '2026-07-25']);
        expect(v.validFrom).toBe('2026-07-18');
        expect(v.validTo).toBe('2026-07-25');
    });

    it('#4 "Valid Until (Every Weekday) DATE"', () => {
        const [v] = parsePeriod('Valid Until (Every Wednesday) 2026-09-30', opts);
        expect(v.validTo).toBe('2026-09-30');
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(v.recurrenceDays).toEqual(['wednesday']);
    });

    it('#5 "Valid Until (Every Weekday from Xpm to Ypm only) DATE"', () => {
        const [v] = parsePeriod('Valid Until (Every Friday from 3pm to 9pm only) 2026-07-30', opts);
        expect(v.validTo).toBe('2026-07-30');
        expect(v.recurrenceDays).toEqual(['friday']);
        expect(v.timeWindow).toEqual({ from: '15:00', to: '21:00' });
    });

    it('#6 "Valid (Day - Full day) On DATE"', () => {
        const [v] = parsePeriod('Valid (Saturday - Full day) On 2026-07-18', opts);
        expect(v.validTo).toBe('2026-07-18');
        expect(v.recurrenceDays).toContain('saturday');
    });

    it('#7 "Valid On (Day) DATE"', () => {
        const [v] = parsePeriod('Valid On (Sunday) 2026-08-09', opts);
        expect(v.validTo).toBe('2026-08-09');
        expect(v.recurrenceDays).toContain('sunday');
    });

    it('#8 "Valid From (Every Weekday) DATE to DATE"', () => {
        const [v] = parsePeriod('Valid From (Every Sunday) 2026-07-05 to 2026-08-30', opts);
        expect(v.validFrom).toBe('2026-07-05');
        expect(v.validTo).toBe('2026-08-30');
        expect(v.recurrenceDays).toEqual(['sunday']);
    });

    it('#9 lowercase "Valid from DATE to DATE"', () => {
        const [v] = parsePeriod('Valid from 2026-07-01 to 2026-12-31', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-12-31');
    });

    it('#10 "Valid From DATE to DATE & DATE to DATE" — two discrete ranges', () => {
        const result = parsePeriod('Valid From 2026-07-01 to 2026-07-15 & 2026-08-01 to 2026-08-15', opts);
        expect(result).toHaveLength(2);
        expect(result[0].validFrom).toBe('2026-07-01');
        expect(result[0].validTo).toBe('2026-07-15');
        expect(result[1].validFrom).toBe('2026-08-01');
        expect(result[1].validTo).toBe('2026-08-15');
    });

    it('#10b two textual ranges joined with "&"', () => {
        const result = parsePeriod('Valid From 01st July to 15th July 2026 & 01st August to 15th August 2026', opts);
        expect(result).toHaveLength(2);
        expect(result[0].validFrom).toBe('2026-07-01');
        expect(result[0].validTo).toBe('2026-07-15');
        expect(result[1].validFrom).toBe('2026-08-01');
        expect(result[1].validTo).toBe('2026-08-15');
    });

    it('#11 "Valid On (Nth Weekday of the month) DATE"', () => {
        const [v] = parsePeriod('Valid On (2nd Thursday of the month) 2026-08-13', opts);
        expect(v.validTo).toBe('2026-08-13');
        expect(v.recurrenceDays).toContain('thursday');
    });

    it('#13 "Valid (Every Weekday) Until DATE"', () => {
        const [v] = parsePeriod('Valid (Every Friday) Until 2026-10-31', opts);
        expect(v.validTo).toBe('2026-10-31');
        expect(v.recurrenceDays).toEqual(['friday']);
    });

    it('#14 "Valid On (Every Day1 and Day2) From DATE to DATE"', () => {
        const [v] = parsePeriod('Valid On (Every Saturday and Sunday) From 2026-07-01 to 2026-08-31', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-08-31');
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['saturday', 'sunday']));
    });

    it('#15 typo "Valid Untill DATE"', () => {
        const [v] = parsePeriod('Valid Untill 2026-08-31', opts);
        expect(v.validTo).toBe('2026-08-31');
    });

    it('#16 lowercase "Valid until DATE"', () => {
        const [v] = parsePeriod('Valid until 2026-08-31', opts);
        expect(v.validTo).toBe('2026-08-31');
    });

    it('#17 double-dash typo "Valid from YYYY-MM--DD to DATE"', () => {
        const [v] = parsePeriod('Valid from 2026-07--01 to 2026-08-31', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-08-31');
    });

    it('#18 "Valid Until (Black out Period: Nth-Nth Month) DATE"', () => {
        const [v] = parsePeriod('Valid Until (Black out Period: 11th-17th April 2026) 2026-10-31', opts);
        expect(v.validTo).toBe('2026-10-31');
        expect(v.blackoutPeriods).toEqual([{ from: '2026-04-11', to: '2026-04-17' }]);
    });

    it('#19 "Valid From (Black out Period: ...) DATE to DATE"', () => {
        const [v] = parsePeriod('Valid From (Black out Period: 11th to 17th April 2026) 2026-03-15 to 2026-10-31', opts);
        expect(v.validFrom).toBe('2026-03-15');
        expect(v.validTo).toBe('2026-10-31');
        expect(v.blackoutPeriods).toEqual([{ from: '2026-04-11', to: '2026-04-17' }]);
    });

    it('#21 "Valid (Nth to Nth of every month) until DATE"', () => {
        const [v] = parsePeriod('Valid (5th to 10th of every month) until 2026-12-31', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.MONTHLY_RANGE);
        expect(v.recurrenceDays).toEqual(['5-10']);
        expect(v.validTo).toBe('2026-12-31');
    });

    it('#22 "Valid On DATE & DATE"', () => {
        const [v] = parsePeriod('Valid On 2026-07-18 & 2026-08-19', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-18', '2026-08-19']);
    });

    it('falls back to API dates when the card text is unparseable', () => {
        const [v] = parsePeriod('Valid Untl garbled text', { ...opts, apiFrom: '2026-07-01', apiTo: '2026-09-30' });
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-09-30');
    });
});

// ─── Long-form "Period:" formats (View More modal) ────────────────────────────

describe('HNB modal long-form Period formats', () => {
    it('M1 plain single line "Period: Till 31st August 2026"', () => {
        const [v] = parsePeriod('Period: Till 31st August 2026', opts);
        expect(v.validTo).toBe('2026-08-31');
        expect(v.periodType).toBe(PeriodType.OFFER);
    });

    it('M2 plain range "Period: 01st April to 31st December 2026"', () => {
        const [v] = parsePeriod('Period: 01st April to 31st December 2026', opts);
        expect(v.validFrom).toBe('2026-04-01');
        expect(v.validTo).toBe('2026-12-31');
    });

    it('M3 split Offer Period + Installment Period (jewellery combo offers)', () => {
        const result = parsePeriod(
            'Offer Period: Till 31st August 2026 Installment Period: Till 31st July 2026',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].periodType).toBe(PeriodType.OFFER);
        expect(result[0].validTo).toBe('2026-08-31');
        expect(result[1].periodType).toBe(PeriodType.INSTALLMENT);
        expect(result[1].validTo).toBe('2026-07-31');
    });

    it('M4 day-specific with weekday label "Period: 06th and 20th July 2026 (Monday)"', () => {
        const [v] = parsePeriod('Period: 06th and 20th July 2026 (Monday)', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-06', '2026-07-20']);
    });

    it('M5 weekly recurring "Period: Till 28th July 2026 (Every Tuesday)"', () => {
        const [v] = parsePeriod('Period: Till 28th July 2026 (Every Tuesday)', opts);
        expect(v.validTo).toBe('2026-07-28');
        expect(v.recurrenceDays).toEqual(['tuesday']);
    });

    it('M6 weekly recurring with time window', () => {
        const [v] = parsePeriod('Period: Till 30th July 2026 (Every Thursday from 3pm to 9pm only)', opts);
        expect(v.validTo).toBe('2026-07-30');
        expect(v.recurrenceDays).toEqual(['thursday']);
        expect(v.timeWindow).toEqual({ from: '15:00', to: '21:00' });
    });

    it('M7 multi-channel breakdown (Glomark) keeps dates + first time window', () => {
        const [v] = parsePeriod(
            'Period: 10th & 31st July 2026 (Friday) In-store - 3pm to 8pm only Glomark.lk - Full day',
            opts
        );
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-10', '2026-07-31']);
        expect(v.timeWindow).toEqual({ from: '15:00', to: '20:00' });
        // Per-channel hours are not modeled — raw text is preserved for review
        expect(v.rawPeriodText).toContain('Glomark.lk');
    });

    it('M8 Nth-weekday-of-month "Period: 15th July 2026 (3rd Wednesday of the month)"', () => {
        const [v] = parsePeriod('Period: 15th July 2026 (3rd Wednesday of the month)', opts);
        expect(v.validTo).toBe('2026-07-15');
        expect(v.recurrenceDays).toContain('wednesday');
    });

    it('M10 range with inline blackout exclusion', () => {
        const [v] = parsePeriod(
            'Period: 15th March to 31st October 2026 (Black out Period: 11th to 17th April 2026)',
            opts
        );
        expect(v.validFrom).toBe('2026-03-15');
        expect(v.validTo).toBe('2026-10-31');
        expect(v.blackoutPeriods).toEqual([{ from: '2026-04-11', to: '2026-04-17' }]);
    });

    it('M12 three compressed monthly ranges (Hemas eStore)', () => {
        const result = parsePeriod(
            'Period: 20th to 31st July 2026, 20th to 31st August 2026, 20th to 30th September 2026',
            opts
        );
        expect(result).toHaveLength(3);
        expect(result[0].validFrom).toBe('2026-07-20');
        expect(result[0].validTo).toBe('2026-07-31');
        expect(result[1].validFrom).toBe('2026-08-20');
        expect(result[1].validTo).toBe('2026-08-31');
        expect(result[2].validFrom).toBe('2026-09-20');
        expect(result[2].validTo).toBe('2026-09-30');
    });

    it('M13 simple two-date list "Period: 18th & 19th July 2026"', () => {
        const [v] = parsePeriod('Period: 18th & 19th July 2026', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-18', '2026-07-19']);
    });

    it('regression: plain "1st to 30th September 2026" gets NO spurious blackout', () => {
        const [v] = parsePeriod('1st to 30th September 2026', opts);
        expect(v.validFrom).toBe('2026-09-01');
        expect(v.validTo).toBe('2026-09-30');
        expect(v.blackoutPeriods).toBeNull();
    });

    it('regression: full modal body with Offer/Merchant text yields no junk periods', () => {
        const result = parsePeriod(
            'Merchant: Aminra Jewellers Offer: 20% off on gold jewellery ' +
            'Offer Period: Till 31st August 2026 Installment Period: Till 31st July 2026',
            { ...opts, apiFrom: '2026-07-01', apiTo: '2026-08-31' }
        );
        expect(result).toHaveLength(2);
        expect(result.map(r => r.periodType)).toEqual([PeriodType.OFFER, PeriodType.INSTALLMENT]);
        expect(result[0].validTo).toBe('2026-08-31');
        expect(result[1].validTo).toBe('2026-07-31');
    });
});
