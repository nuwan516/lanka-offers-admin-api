/**
 * Real-world BOC location structures (July 2026 survey).
 * BOC has no structured merchant field — locations appear as free-text lines,
 * a "Location :" label, or a multi-line "Locations:" branch list.
 */
import { AddressEngine } from '@/parsing/address/address-engine';

const engine = new AddressEngine({ country: 'Sri Lanka' });

describe('BOC location structures', () => {
    it('BL1 city + country line: "Wadduwa, Sri Lanka"', () => {
        const text = 'Wadduwa, Sri Lanka\nEnjoy 15% savings on room bookings with BOC Credit Cards';
        expect(engine.extract(text, 'The Blue Water Hotel')).toEqual(['Wadduwa, Sri Lanka']);
    });

    it('BL1b "Mirissa, Sri Lanka"', () => {
        const text = 'Mirissa, Sri Lanka\nSpecial rates for BOC cardholders';
        expect(engine.extract(text, 'Paradise Beach Club')).toEqual(['Mirissa, Sri Lanka']);
    });

    it('BL2 district only, no country suffix: "Colombo 03"', () => {
        const text = 'Colombo 03\nBuffet dinner deals with BOC Credit Cards';
        expect(engine.extract(text, 'Cinnamon Grand Colombo')).toEqual(['Colombo 03, Sri Lanka']);
    });

    it('BL3 venue embedded with "@" in offer prose', () => {
        const text = 'Enjoy a sumptuous dinner buffet @ Nuga Gama Restaurant, Cinnamon Grand Colombo. Advance booking recommended.';
        expect(engine.extract(text, 'Nuga Gama')).toEqual([
            'Nuga Gama Restaurant, Cinnamon Grand Colombo, Sri Lanka',
        ]);
    });

    it('BL4 "Location :" label with street address + contact number (Siddhalepa Hospital)', () => {
        const text = 'Location : No 106A, Templers Road, Mt. Lavinia - Contact No : 077 371 0139 / 011 273 8622';
        expect(engine.extract(text, 'Siddhalepa Ayurveda Hospital')).toEqual([
            'No 106A, Templers Road, Mt. Lavinia, Sri Lanka',
        ]);
    });

    it('BL5 plural "Locations:" with one branch per line (Siddhalepa Clinics)', () => {
        const text = [
            'Locations: No 33, Wijerama Mawatha, Colombo 07 - Contact: 011 269 8161',
            'No 106A, Templers Road, Mt. Lavinia - Contact: 011 273 8622',
            'No 471, Pannipitiya Road, Battaramulla - Contact: 011 287 4744',
            'No 5, Main Street, Negombo - Contact: 031 223 8768',
            'Beach Road, Mirissa - Contact: 041 225 0999',
        ].join('\n');

        expect(engine.extract(text, 'Siddhalepa Clinics')).toEqual([
            'No 33, Wijerama Mawatha, Colombo 07, Sri Lanka',
            'No 106A, Templers Road, Mt. Lavinia, Sri Lanka',
            'No 471, Pannipitiya Road, Battaramulla, Sri Lanka',
            'No 5, Main Street, Negombo, Sri Lanka',
            'Beach Road, Mirissa, Sri Lanka',
        ]);
    });

    it('BL6 no location at all (nationwide chains) → merchant fallback', () => {
        const text = 'Save big on your grocery bill every week with BOC Credit Cards';
        expect(engine.extract(text, 'Keells Super')).toEqual(['Keells Super, Sri Lanka']);
    });
});
