/**
 * Real-world BOC period formats.
 *
 * BOC has one structured field ("Expiration date : DD Mon YYYY") on every
 * offer; all other validity detail is free-text prose inside Offer Details.
 * Formats below were observed on the live BOC card-offers pages
 * (13 categories, ~71 offers, July 2026 survey).
 */
import { parsePeriod, parseHumanDate } from '@/parsing/period/period-engine';
import { RecurrenceType } from '@/core/types/offers';

const today = '2026-07-12';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe('BOC period formats', () => {
    it('B0 "31 Dec 2026" (Expiration date field format) normalizes to ISO', () => {
        expect(parseHumanDate('31 Dec 2026')).toBe('2026-12-31');
        expect(parseHumanDate('01 Jan 2027')).toBe('2027-01-01');
    });

    it('B1 prose with no date at all → expiry field wins as validTo', () => {
        const [v] = parsePeriod(
            'Enjoy exclusive savings on your favourite brands with BOC Credit Cards.',
            { ...opts, apiTo: '2026-12-31' }
        );
        expect(v.validTo).toBe('2026-12-31');
    });

    it('B2 simple range "From 01st to 31st July 2026" (Cinnamon Grand dining)', () => {
        const [v] = parsePeriod('From 01st to 31st July 2026', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-07-31');
    });

    it('B3 dual weekly patterns joined with "and" (Keells, Laugfs)', () => {
        const result = parsePeriod(
            'On Thursdays from 02nd to 30th July 2026 and On Fridays from 03rd to 31st July 2026',
            opts
        );
        expect(result).toHaveLength(2);
        expect(result[0].validFrom).toBe('2026-07-02');
        expect(result[0].validTo).toBe('2026-07-30');
        expect(result[0].recurrenceDays).toEqual(['thursday']);
        expect(result[1].validFrom).toBe('2026-07-03');
        expect(result[1].validTo).toBe('2026-07-31');
        expect(result[1].recurrenceDays).toEqual(['friday']);
    });

    it('B4 dual-weekday with parenthetical range (Cargills Food City)', () => {
        const [v] = parsePeriod('On Wednesdays & Sundays (01st - 29th July 2026)', opts);
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-07-29');
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['wednesday', 'sunday']));
    });

    it('B5 fixed dates plus channel note (Softlogic Glomark)', () => {
        const [v] = parsePeriod('On 12th & 26th July 2026 | In-Stores & Online (www.glomark.lk)', opts);
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.recurrenceDays).toEqual(['2026-07-12', '2026-07-26']);
    });

    it('B6 "Valid till" embedded in body text beats the expiry field (Zero Plans)', () => {
        const [v] = parsePeriod(
            '0% installment plans on air tickets for BOC Credit Cards. Valid till 31st August 2026.',
            { ...opts, apiTo: '2026-12-31' }
        );
        expect(v.validTo).toBe('2026-08-31');
    });

    it('B7 plain descriptive sentence (VISA cross-border) → expiry only', () => {
        const [v] = parsePeriod(
            'Get amazing deals in Singapore and Thailand when you pay with your BOC Visa card.',
            { ...opts, apiTo: '2026-12-31' }
        );
        expect(v.validTo).toBe('2026-12-31');
        expect(v.recurrenceType).toBe(RecurrenceType.DAILY);
    });

    it('B8 dual-rate weekday/weekend split does NOT become a date list (Laya Beach)', () => {
        const [v] = parsePeriod(
            'Reservations : 076 828 2410 / 038 223 2815 ' +
            '35% off on weekdays & 30% off on weekends for BOC Credit & Debit Cardholders ' +
            'From 05th June to 31st August 2026 *Conditions apply.',
            opts
        );
        // "& 30% off" must not trigger the specific-dates branch, and phone
        // digits must never be harvested as day numbers
        expect(v.recurrenceType).not.toBe(RecurrenceType.SPECIFIC_DATES);
        expect(v.validFrom).toBe('2026-06-05');
        expect(v.validTo).toBe('2026-08-31');
    });

    it('B7b weekday name inside prose still yields recurrence (VISA Thursday promos)', () => {
        const [v] = parsePeriod(
            'Special discounts every Thursday with your BOC Visa card.',
            { ...opts, apiTo: '2026-12-31' }
        );
        expect(v.validTo).toBe('2026-12-31');
        expect(v.recurrenceDays).toEqual(['thursday']);
    });
});
