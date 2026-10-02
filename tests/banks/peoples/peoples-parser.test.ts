/**
 * End-to-end parsePeoplesOffer tests using the fixed page template observed
 * in the July 2026 survey: "[Merchant] – [X]% – Credit" title, bullet
 * description, "Validity:" line, "Location:" line repeating the merchant name.
 */
import { parsePeoplesOffer, PeoplesRawOffer } from '@/banks/peoples/peoples-parser';
import { classify } from '@/parsing/geo/branch-classifier';
import { LocationType } from '@/core/types/geo';
import { RecurrenceType } from '@/core/types/offers';

function rawOffer(overrides: {
    merchantName: string;
    discount?: string;
    shortDescription?: string;
    validityRaw?: string;
    location?: string | null;
    terms?: string[];
    detailPageUrl?: string;
}): PeoplesRawOffer {
    return {
        listing: {
            merchantName: overrides.merchantName,
            discount: overrides.discount ?? '',
            shortDescription: overrides.shortDescription ?? '',
            validityRaw: overrides.validityRaw ?? '',
            imageUrl: null,
            detailPageUrl: overrides.detailPageUrl ?? 'https://www.peoplesbank.lk/offers/test-offer/',
            _categoryName: 'Wellness',
            _categoryId: 1,
            _cardType: 'credit',
        },
        detail: {
            sourceUrl: overrides.detailPageUrl ?? 'https://www.peoplesbank.lk/offers/test-offer/',
            imageUrl: null,
            title: overrides.merchantName,
            location: overrides.location ?? overrides.merchantName,
            validityText: overrides.validityRaw ?? null,
            terms: overrides.terms ?? [],
            termsUrl: null,
            structuredTerms: { minimumSpend: null, maximumBill: null, minimumPax: null, maximumPax: null },
            rawDetailHtml: '<div>raw</div>',
        },
    };
}

describe("parsePeoplesOffer — real page structures", () => {
    it('Kurundu Wellness: range + weekday/time restriction + blackout note in description', () => {
        const offer = parsePeoplesOffer(rawOffer({
            merchantName: 'Kurundu Wellness By Choice at Cinnamon Life City of Dreams',
            discount: '25%',
            shortDescription: '25% off on all spa treatments',
            validityRaw: 'From June 2, 2026 to July 31, 2026 ((Valid Monday to Friday | 10:00 AM – 9:00 PM))',
            terms: ['Blackout dates applicable during high occupancy periods'],
        }));

        const [v] = offer!.validityPeriods;
        expect(v.validFrom).toBe('2026-06-02');
        expect(v.validTo).toBe('2026-07-31');
        expect(v.timeWindow).toEqual({ from: '10:00', to: '21:00' });
        expect(v.recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
        expect(offer!.offer.discountPercentage).toBe(25);
        // blackout note lives in description → surfaced as a restriction
        expect(offer!.offer.restrictions).toContain('Exclusions or blackout dates apply');
        // Location repeats merchant name → merchant-name fallback address
        expect(offer!.merchant.addresses).toEqual([
            'Kurundu Wellness By Choice at Cinnamon Life City of Dreams, Sri Lanka',
        ]);
    });

    it('Cargills: Till + every-weekday pattern', () => {
        const offer = parsePeoplesOffer(rawOffer({
            merchantName: 'Cargills Food City',
            discount: '10%',
            validityRaw: 'Till July 31, 2026 ((Every Tuesdays & Thursdays))',
        }));

        const [v] = offer!.validityPeriods;
        expect(v.validTo).toBe('2026-07-31');
        expect(v.recurrenceDays).toEqual(expect.arrayContaining(['tuesday', 'thursday']));
    });

    it('branch-network qualifier stays part of the merchant identity (Toyota Lanka)', () => {
        const offer = parsePeoplesOffer(rawOffer({
            merchantName: 'Toyota Lanka - (Spare Parts Branches)',
            discount: '15%',
            validityRaw: 'Till December 31, 2026',
        }));
        expect(offer!.merchant.name).toBe('Toyota Lanka - (Spare Parts Branches)');
        expect(offer!.validityPeriods[0].validTo).toBe('2026-12-31');
    });

    it('does not treat grocery/item category exclusions as excluded cards', () => {
        const offer = parsePeoplesOffer(rawOffer({
            merchantName: 'Keells Supermarket',
            discount: 'Up to 20%',
            shortDescription: 'Up to 20% off on fresh items. Excluding Categories:-Packed or Packeted: Vegetables, Rice, Sugar, Flour, Milk powder',
            validityRaw: 'Till December 31, 2026',
        }));

        expect(offer!.cardEligibility.excludedCards).toEqual([]);
        expect(offer!.offer.restrictions).toContain('Discount is "up to" the stated percentage, may vary by item/venue');
        expect(offer!.offer.restrictions).toContain('Selected items or categories excluded');
    });

    it('correctly captures legitimate card exclusions', () => {
        const offer = parsePeoplesOffer(rawOffer({
            merchantName: 'Arpico Supercentre',
            discount: '15%',
            shortDescription: '15% discount for credit cards excluding Corporate Cards and Commercial Cards',
            validityRaw: 'Till December 31, 2026',
        }));

        expect(offer!.cardEligibility.excludedCards).toEqual(expect.arrayContaining(['Corporate Cards', 'Commercial Cards']));
    });
});

describe("People's Bank location classification", () => {
    const base = () => ({
        offerId: 'x', merchantName: '', city: null, location: null, address: null,
        addresses: [] as string[], branches: [] as string[], phone: null, promotionDetails: null,
    });

    it('domain-style merchants are ONLINE, never geocoded (BuyMe.lk)', () => {
        const r = classify({ ...base(), merchantName: 'BuyMe.lk', addresses: ['BuyMe.lk, Sri Lanka'] });
        expect(r.type).toBe(LocationType.ONLINE);
    });

    it('www-prefixed merchants are ONLINE (www.findmyfare.com)', () => {
        const r = classify({ ...base(), merchantName: 'www.findmyfare.com' });
        expect(r.type).toBe(LocationType.ONLINE);
    });

    it('card-network campaigns are ONLINE (Visa Concierge Offers 2026)', () => {
        const r = classify({ ...base(), merchantName: 'Visa Concierge Offers 2026', addresses: ['Visa Concierge Offers 2026, Sri Lanka'] });
        expect(r.type).toBe(LocationType.ONLINE);
    });

    it('umbrella venue names still route to Places (Food Studio at OGF)', () => {
        const r = classify({ ...base(), merchantName: 'Food Studio at OGF', addresses: ['Food Studio at OGF, Sri Lanka'] });
        expect(r.type).toBe(LocationType.CHAIN);
        expect(r.chainQuery).toBe('Food Studio at OGF, Sri Lanka');
    });
});
