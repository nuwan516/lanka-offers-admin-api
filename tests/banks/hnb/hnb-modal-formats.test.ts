/**
 * End-to-end parseHNBDetail tests for the two named survey examples:
 *  - Hilton Colombo multi-brand offer (Graze Kitchen | Emperor's Wok | Café Kai)
 *  - Jewellery combo offer with split Offer Period / Installment Period
 */
import { parseHNBDetail, HNBDetailResponse } from '@/banks/hnb/hnb-parser';
import { PeriodType } from '@/core/types/offers';

function detail(overrides: Partial<HNBDetailResponse>): HNBDetailResponse {
    return {
        id: '9001',
        title: 'Test Offer',
        from: '2026-07-01',
        to: '2026-08-31',
        cardType: 'Credit Card',
        content: '',
        ...overrides,
    };
}

describe('parseHNBDetail — real modal structures', () => {
    it('Hilton Colombo multi-brand offer', () => {
        const resp = detail({
            id: '9001',
            title: '25% off at Hilton Colombo restaurants',
            from: '2026-07-06',
            to: '2026-07-31',
            content:
                "<p>Merchant: Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo)</p>" +
                '<p>Offer: 25% off on food and beverages</p>' +
                '<p>Period: 06th to 31st July 2026</p>' +
                '<p>Location: Colombo 02</p>',
        });

        const offer = parseHNBDetail('9001', resp, 'Dining', 3);
        expect(offer).not.toBeNull();
        // Multi-brand merchant string is preserved verbatim (splitting into
        // per-outlet merchants is a modeling decision, not an extraction bug)
        expect(offer!.merchant.name).toBe("Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo)");
        expect(offer!.merchant.addresses).toEqual(['Colombo 02, Sri Lanka']);
        expect(offer!.offer.discountPercentage).toBe(25);

        expect(offer!.validityPeriods).toHaveLength(1);
        expect(offer!.validityPeriods[0].validFrom).toBe('2026-07-06');
        expect(offer!.validityPeriods[0].validTo).toBe('2026-07-31');
    });

    it('jewellery combo offer with split Offer/Installment periods', () => {
        const resp = detail({
            id: '9002',
            title: '20% off at Aminra Jewellers',
            from: '2026-07-01',
            to: '2026-08-31',
            content:
                '<p>Merchant: Aminra Jewellers</p>' +
                '<p>Offer: 20% off on gold jewellery</p>' +
                '<p>Offer Period: Till 31st August 2026</p>' +
                '<p>Installment Period: Till 31st July 2026</p>' +
                '<p>Location: Mount Lavinia</p>',
        });

        const offer = parseHNBDetail('9002', resp, 'Jewellery', 11);
        expect(offer).not.toBeNull();
        expect(offer!.merchant.name).toBe('Aminra Jewellers');
        expect(offer!.merchant.addresses).toEqual(['Mount Lavinia, Sri Lanka']);

        const types = offer!.validityPeriods.map(p => p.periodType);
        expect(types).toEqual([PeriodType.OFFER, PeriodType.INSTALLMENT]);
        expect(offer!.validityPeriods[0].validTo).toBe('2026-08-31');
        expect(offer!.validityPeriods[1].validTo).toBe('2026-07-31');
    });

    it('offer with no Location line falls back to merchant-name search query', () => {
        const resp = detail({
            id: '9003',
            title: 'Flawless Diamond Jewellery',
            content:
                '<p>Merchant: Flawless Diamond Jewellery</p>' +
                '<p>Offer: 15% off on diamonds</p>' +
                '<p>Period: Till 31st December 2026</p>',
        });

        const offer = parseHNBDetail('9003', resp, 'Jewellery', 11);
        expect(offer!.merchant.addresses).toEqual(['Flawless Diamond Jewellery, Sri Lanka']);
        expect(offer!.validityPeriods[0].validTo).toBe('2026-12-31');
    });

    it('cleans card eligibility and splits compound excluded cards', () => {
        const resp = detail({
            id: '9004',
            title: '20% off at Odel with HNB Cards',
            cardType: 'Credit Card, Visa Signature, Visa Infinite',
            content:
                '<p>Merchant: Odel</p>' +
                '<p>Offer: 20% off on all items (except Corporate, Business and Fuel Cards)</p>' +
                '<p>Period: Till 31st December 2026</p>',
        });

        const offer = parseHNBDetail('9004', resp, 'Shopping', 5);
        expect(offer).not.toBeNull();
        expect(offer!.cardEligibility.cardTypes).toContain('Credit Card');
        // 'Credit Card' generic token should NOT be in includedCards
        expect(offer!.cardEligibility.includedCards).not.toContain('Credit Card');
        expect(offer!.cardEligibility.includedCards).toEqual(['Visa Signature', 'Visa Infinite']);
        // Compound exclusions should be split into individual card types
        expect(offer!.cardEligibility.excludedCards).toEqual(['Corporate', 'Business', 'Fuel Cards']);
    });

    it('captures "up to" discount from title into restrictions', () => {
        const resp = detail({
            id: '9005',
            title: 'Up to 30% off at Arpico Supercentre',
            content:
                '<p>Merchant: Arpico Supercentre</p>' +
                '<p>Offer: 30% off on selected items</p>' +
                '<p>Period: Till 31st December 2026</p>',
        });

        const offer = parseHNBDetail('9005', resp, 'Supermarkets', 2);
        expect(offer).not.toBeNull();
        expect(offer!.offer.restrictions.some(r => /up to/i.test(r))).toBe(true);
    });

    it('extracts transaction minimum with flexible prefixes and suffixes', () => {
        const resp = detail({
            id: '9006',
            title: '20% off at Glomark',
            content:
                '<p>Merchant: Glomark</p>' +
                '<p>Offer: 20% off</p>' +
                '<p>Period: Till 31st December 2026</p>' +
                '<p>Minimum Bill Value - 10,000/-</p>',
        });

        const offer = parseHNBDetail('9006', resp, 'Supermarkets', 2);
        expect(offer).not.toBeNull();
        expect(offer!.transactionRange.min).toBe(10000);
    });
});
