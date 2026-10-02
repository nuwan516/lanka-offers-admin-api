/**
 * End-to-end parseBOCOffer tests using realistic BOCRawOffer shapes as the
 * fetcher produces them from live detail pages (July 2026 survey).
 */
import { parseBOCOffer, BOCRawOffer } from '@/banks/boc/boc-parser';
import { RecurrenceType } from '@/core/types/offers';

function rawOffer(overrides: Partial<BOCRawOffer>): BOCRawOffer {
    return {
        url: '/personal-banking/card-offers/dining/test-merchant/product',
        title: 'Test Merchant',
        description: [],
        ...overrides,
    };
}

describe('parseBOCOffer — real page structures', () => {
    it('universal "Expiration date : 31 Dec 2026" becomes validTo even when prose has no date', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Softlogic Retail',
            expirationDate: '31 Dec 2026',
            offerValue: '20% OFF',
            description: ['Enjoy exclusive savings on home appliances with BOC Credit Cards.'],
        }));

        expect(offer).not.toBeNull();
        expect(offer!.validityPeriods[0].validTo).toBe('2026-12-31');
        expect(offer!.offer.discountPercentage).toBe(20);
    });

    it('dining offer: range in prose overrides the later expiry field', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Cinnamon Grand Colombo',
            expirationDate: '31 Jul 2026',
            description: ['From 01st to 31st July 2026', 'Colombo 03'],
        }));

        const [v] = offer!.validityPeriods;
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-07-31');
        // district-only line becomes the geocodable address
        expect(offer!.merchant.addresses).toEqual(['Colombo 03, Sri Lanka']);
    });

    it('supermarket offer: dual weekday pattern yields two validity rows', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Keells Super',
            expirationDate: '31 Jul 2026',
            description: [
                'On Thursdays from 02nd to 30th July 2026 and On Fridays from 03rd to 31st July 2026',
            ],
        }));

        expect(offer!.validityPeriods).toHaveLength(2);
        expect(offer!.validityPeriods[0].recurrenceDays).toEqual(['thursday']);
        expect(offer!.validityPeriods[1].recurrenceDays).toEqual(['friday']);
        // no location lines → merchant-name fallback for Places search
        expect(offer!.merchant.addresses).toEqual(['Keells Super, Sri Lanka']);
    });

    it('Cargills: weekday pair with parenthetical range', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Cargills Food City',
            expirationDate: '29 Jul 2026',
            description: ['On Wednesdays & Sundays (01st - 29th July 2026)'],
        }));

        const [v] = offer!.validityPeriods;
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['wednesday', 'sunday']));
        expect(v.validFrom).toBe('2026-07-01');
        expect(v.validTo).toBe('2026-07-29');
    });

    it('Siddhalepa: fetcher-supplied addresses and contacts pass through unchanged', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Siddhalepa Ayurveda Hospital',
            expirationDate: '31 Dec 2026',
            addresses: ['No 106A, Templers Road, Mt. Lavinia, Sri Lanka'],
            contactNumbers: ['077 371 0139', '011 273 8622'],
            location: 'No 106A, Templers Road, Mt. Lavinia',
            description: [
                'Location : No 106A, Templers Road, Mt. Lavinia - Contact No : 077 371 0139 / 011 273 8622',
            ],
        }));

        expect(offer!.merchant.addresses).toEqual(['No 106A, Templers Road, Mt. Lavinia, Sri Lanka']);
        expect(offer!.merchant.phone).toEqual(['077 371 0139', '011 273 8622']);
        expect(offer!.validityPeriods[0].validTo).toBe('2026-12-31');
    });

    it('Zero Plans: "Valid till" in body wins over Expiration date field', () => {
        const offer = parseBOCOffer(rawOffer({
            title: 'Air Tickets Zero Plan',
            expirationDate: '31 Dec 2026',
            description: ['0% installment plans on air tickets for BOC Credit Cards. Valid till 31st August 2026.'],
        }));

        expect(offer!.validityPeriods[0].validTo).toBe('2026-08-31');
    });

    it('uniqueId derives from the URL slug', () => {
        const offer = parseBOCOffer(rawOffer({
            url: '/personal-banking/card-offers/dining/nuga-gama/product',
            title: 'Nuga Gama',
        }));
        expect(offer!.uniqueId).toBe('boc_nuga-gama');
        expect(offer!.sourceUrl).toBe('https://www.boc.lk/personal-banking/card-offers/dining/nuga-gama/product');
    });

    it('preserves "Up to" semantics in restrictions and correctly parses embedded range', () => {
        const offer = parseBOCOffer(rawOffer({
            url: '/personal-banking/card-offers/travel-and-leisure/fox-kandy/product',
            title: 'Fox Kandy',
            expirationDate: '30 Nov 2026',
            description: [
                'Reservations : 074 253 2186 | 077 942 6570',
                'Up to 50% off on rack rates for BOC Credit Cardholders',
                'From 01st September to 30th November 2026',
                '*Conditions apply.',
            ],
        }));

        expect(offer).not.toBeNull();
        expect(offer!.offer.discountPercentage).toBe(50);
        expect(offer!.offer.restrictions).toContain('Discount is "up to" the stated percentage, may vary by item/venue');
        expect(offer!.validityPeriods[0].validFrom).toBe('2026-09-01');
        expect(offer!.validityPeriods[0].validTo).toBe('2026-11-30');
    });
});
