/**
 * Real-world People's Bank "Validity:" formats (July 2026 survey of ~20 offers
 * across all 11 categories). Every offer page has a labeled Validity line in
 * one of five patterns; day/time restrictions come in double parentheses.
 */
import { parsePeriod, extractTimeWindow } from '@/parsing/period/period-engine';
import { RecurrenceType } from '@/core/types/offers';

const today = '2026-07-17';
const fallbackYear = 2026;
const opts = { today, fallbackYear };

describe("People's Bank validity formats", () => {
    it('P1 simple range "From July 10, 2026 to July 30, 2026"', () => {
        const [v] = parsePeriod('From July 10, 2026 to July 30, 2026', opts);
        expect(v.validFrom).toBe('2026-07-10');
        expect(v.validTo).toBe('2026-07-30');
    });

    it('P1b cross-month range "From June 5, 2026 to September 5, 2026"', () => {
        const [v] = parsePeriod('From June 5, 2026 to September 5, 2026', opts);
        expect(v.validFrom).toBe('2026-06-05');
        expect(v.validTo).toBe('2026-09-05');
    });

    it('P2 end date only "Till August 31, 2026"', () => {
        const [v] = parsePeriod('Till August 31, 2026', opts);
        expect(v.validTo).toBe('2026-08-31');
        expect(v.validFrom).toBe(today); // fallback
    });

    it('P3 range + day-and-time restriction in double parentheses (Kurundu Wellness)', () => {
        const [v] = parsePeriod(
            'From June 2, 2026 to July 31, 2026 ((Valid Monday to Friday | 10:00 AM – 9:00 PM))',
            opts
        );
        expect(v.validFrom).toBe('2026-06-02');
        expect(v.validTo).toBe('2026-07-31');
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(v.recurrenceDays).toEqual(
            expect.arrayContaining(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
        );
        expect(v.recurrenceDays).not.toEqual(expect.arrayContaining(['saturday']));
        expect(v.timeWindow).toEqual({ from: '10:00', to: '21:00' });
    });

    it('P4 end date + specific weekdays, plural (Cargills)', () => {
        const [v] = parsePeriod('Till July 31, 2026 ((Every Tuesdays & Thursdays))', opts);
        expect(v.validTo).toBe('2026-07-31');
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['tuesday', 'thursday']));
    });

    it('P4b end date + specific weekdays, singular (Keells)', () => {
        const [v] = parsePeriod('Till July 31, 2026 ((Every Monday & Wednesday))', opts);
        expect(v.validTo).toBe('2026-07-31');
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['monday', 'wednesday']));
    });
});

describe('extractTimeWindow — 12-hour formats with minutes', () => {
    it('parses "10:00 AM – 9:00 PM" (en dash, minutes)', () => {
        expect(extractTimeWindow('10:00 AM – 9:00 PM')).toEqual({ from: '10:00', to: '21:00' });
    });
    it('parses "10.30am-5pm" (dot minutes, hyphen)', () => {
        expect(extractTimeWindow('10.30am-5pm')).toEqual({ from: '10:30', to: '17:00' });
    });
    it('still parses bare "3pm to 9pm"', () => {
        expect(extractTimeWindow('3pm to 9pm')).toEqual({ from: '15:00', to: '21:00' });
    });
    it('handles 12-hour edge cases "12:00 PM to 12:30 AM"', () => {
        expect(extractTimeWindow('12:00 PM to 12:30 AM')).toEqual({ from: '12:00', to: '00:30' });
    });
});
