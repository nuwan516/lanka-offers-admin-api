/**
 * Real-world HNB Merchant/Location structures observed on the live
 * HNB Card Promotions modals (July 2026 survey of 561 offers).
 */
import { AddressEngine } from '@/parsing/address/address-engine';

const engine = new AddressEngine({ country: 'Sri Lanka' });

describe('HNB location structures', () => {
    it('L1 single merchant + single location town (Aminra Jewellers)', () => {
        const text = 'Merchant: Aminra Jewellers Offer: 20% off Location: Mount Lavinia';
        expect(engine.extract(text, 'Aminra Jewellers')).toEqual(['Mount Lavinia, Sri Lanka']);
    });

    it('L2 no Location field at all → merchant-name fallback for Places search', () => {
        const text = 'Merchant: Flawless Diamond Jewellery Offer: 15% off on diamonds';
        expect(engine.extract(text, 'Flawless Diamond Jewellery'))
            .toEqual(['Flawless Diamond Jewellery, Sri Lanka']);
    });

    it('L3 combined merchant name joined with " - " stays one search query', () => {
        const name = 'Browns Tours (Pvt) Ltd - BG Air Services (Pvt) Ltd';
        const text = `Merchant: ${name} Offer: Special airfares`;
        expect(engine.extract(text, name)).toEqual([`${name}, Sri Lanka`]);
    });

    it('L4 plural "Locations:" label is recognized', () => {
        const text = 'Locations: Rajagiriya';
        expect(engine.extract(text, 'Full\'r Burgers')).toEqual(['Rajagiriya, Sri Lanka']);
    });

    it('L5 "Locations:" with a branch list splits into one entry per branch', () => {
        const text = 'Locations: Glomark - Thalawathugoda, Glomark - Negombo, Glomark - Kandy';
        expect(engine.extract(text, 'Glomark')).toEqual([
            'Glomark - Thalawathugoda, Sri Lanka',
            'Glomark - Negombo, Sri Lanka',
            'Glomark - Kandy, Sri Lanka',
        ]);
    });

    it('L6 generic "Locations: All outlets" falls back to merchant name (not geocodable)', () => {
        const text = 'Offer: 10% off Locations: All outlets';
        expect(engine.extract(text, 'Pizza Hut')).toEqual(['Pizza Hut, Sri Lanka']);
    });

    it('L7 multi-brand venue: location still extracted from Location field', () => {
        const text =
            "Merchant: Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo) " +
            'Offer: 25% off Location: Colombo 02';
        expect(engine.extract(text, "Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo)"))
            .toEqual(['Colombo 02, Sri Lanka']);
    });
});
