/**
 * Seylan address-field shapes (July 2026 survey: 92 of 156 offers carry an
 * "Address:" line; 7 hold a website URL and 2 a phone number by mistake).
 */
import { AddressEngine } from '@/parsing/address/address-engine';

const engine = new AddressEngine({ country: 'Sri Lanka' });

describe('Seylan address structures', () => {
    it('Y-A1 number/street/city without "No" prefix (31/92)', () => {
        expect(engine.extract('27/1, Visaka Road, Colombo 04', 'Merchant')).toEqual([
            '27/1, Visaka Road, Colombo 04, Sri Lanka',
        ]);
    });

    it('Y-A2 explicit "No." prefix (23/92)', () => {
        expect(engine.extract('No.3, Alfred Place, Colombo 03', 'Merchant')).toEqual([
            'No.3, Alfred Place, Colombo 03, Sri Lanka',
        ]);
    });

    it('Y-A3 street/area + city, no house number (19/92)', () => {
        expect(engine.extract('New Parliament Rd, Battaramulla', 'Merchant')).toEqual([
            'New Parliament Rd, Battaramulla, Sri Lanka',
        ]);
    });

    it('Y-A4 " / "-separated multi-branch list splits per branch (7/92)', () => {
        const text = '168, Old Negombo Road, Kanuwana Ja-Ela / 98, Old Negombo Road, Negombo / 451, Peradeniya Road, Kandy';
        expect(engine.extract(text, 'Pit & Drive')).toEqual([
            '168, Old Negombo Road, Kanuwana Ja-Ela, Sri Lanka',
            '98, Old Negombo Road, Negombo, Sri Lanka',
            '451, Peradeniya Road, Kandy, Sri Lanka',
        ]);
    });

    it('Y-A5 website URL as address (data error, 7/92) → merchant fallback', () => {
        expect(engine.extract('www.pitanddrive.lk', 'Pit & Drive')).toEqual(['Pit & Drive, Sri Lanka']);
    });

    it('Y-A6 phone number as address (data error, 2/92) → merchant fallback', () => {
        expect(engine.extract('+94 77 686 8255', 'Some Salon')).toEqual(['Some Salon, Sri Lanka']);
    });

    it('Y-A7 PO Box format is kept as a geocodable address', () => {
        expect(engine.extract('PO Box 07, Rajawella, Sri Lanka', 'Victoria Golf')).toEqual([
            'PO Box 07, Rajawella, Sri Lanka',
        ]);
    });
});
