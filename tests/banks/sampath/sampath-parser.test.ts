/**
 * Sampath parser + fetcher label-zoo tests (July 2026 survey: labels are
 * manually entered — 15 address-label variants including misspellings).
 */
import { parseSampathOffer, SampathListItem, SampathDetailPage } from '@/banks/sampath/sampath-parser';
import { SampathFetcher } from '@/banks/sampath/sampath-fetcher';
import { HttpClient } from '@/infrastructure/http/http-client';
import { PeriodType } from '@/core/types/offers';

function listItem(overrides: Partial<SampathListItem> = {}): SampathListItem {
    return {
        id: 2150,
        title: 'Test Offer',
        company_name: 'Test Merchant',
        detail_url: '/sampath-cards/credit-card-offer/2150',
        _categoryName: 'Hotels',
        _categoryId: 1,
        ...overrides,
    };
}

function detailPage(overrides: Partial<SampathDetailPage> = {}): SampathDetailPage {
    return {
        sourceUrl: 'https://www.sampath.lk/sampath-cards/credit-card-offer/2150',
        images: [],
        partner: 'Test Merchant',
        location: null,
        fullAddress: null,
        promotionPeriod: null,
        eligibleCards: 'Sampath Bank Credit Cards',
        reservationNumber: null,
        reservationEmail: null,
        promotionDetailsText: null,
        termsArray: [],
        ...overrides,
    };
}

/** Build a detail page in Sampath's real info-box markup. */
function detailHtml(boxes: Array<[string, string]>): string {
    const boxHtml = boxes
        .map(([h, c]) => `<div class="aliya-resort-and-spa-box"><div class="box-heading">${h}</div><div class="box-txt">${c}</div></div>`)
        .join('');
    return `<html><body>${boxHtml}</body></html>`;
}

function fetcherFor(html: string): SampathFetcher {
    const http = { getHTML: async () => ({ data: html, fromCache: false, status: 200 }) } as unknown as HttpClient;
    return new SampathFetcher(http);
}

describe('SampathFetcher — info-box label zoo', () => {
    const cases: Array<[string, string]> = [
        ['Location', 'No.746, Galle Road, Colombo 04'],
        ['Loacation', 'No.746, Galle Road, Colombo 04'],       // misspelled
        ['Partner Outlets', 'No.746, Galle Road, Colombo 04'],
        ['Partnering Outlet', 'No.746, Galle Road, Colombo 04'],
        ['Participating Hotel', 'No.746, Galle Road, Colombo 04'],
        ['Participating Properties', 'No.746, Galle Road, Colombo 04'],
        ['Paticipating Property', 'No.746, Galle Road, Colombo 04'],  // misspelled
        ['Paricipating Properties', 'No.746, Galle Road, Colombo 04'], // misspelled
        ['Participating Restuarants', 'No.746, Galle Road, Colombo 04'], // misspelled
        ['Participating partners', 'No.746, Galle Road, Colombo 04'],
    ];

    for (const [label, value] of cases) {
        it(`captures address under "${label}"`, async () => {
            const fetcher = fetcherFor(detailHtml([['Partner', 'X'], [label, value]]));
            const detail = await fetcher.fetchDetail(listItem());
            expect(detail!.fullAddress).toBe(value);
        });
    }

    it('"Partner" label does not swallow "Partner Outlets"', async () => {
        const fetcher = fetcherFor(detailHtml([
            ['Partner', 'Cargills Ceylon'],
            ['Partner Outlets', 'All Cargills Outlets'],
        ]));
        const detail = await fetcher.fetchDetail(listItem());
        expect(detail!.partner).toBe('Cargills Ceylon');
        expect(detail!.fullAddress).toBe('All Cargills Outlets');
    });

    it('captures Booking + Stay dual periods with label prefixes', async () => {
        const fetcher = fetcherFor(detailHtml([
            ['Booking Period', 'Valid till 31st July 2026'],
            ['Stay Period', '1st August to 31st October 2026'],
        ]));
        const detail = await fetcher.fetchDetail(listItem());
        expect(detail!.promotionPeriod).toBe(
            'Booking Period: Valid till 31st July 2026 Stay Period: 1st August to 31st October 2026'
        );
    });

    it('lone "Promotion Period" stays bare', async () => {
        const fetcher = fetcherFor(detailHtml([['Promotion Period', 'Valid till 20th July 2026']]));
        const detail = await fetcher.fetchDetail(listItem());
        expect(detail!.promotionPeriod).toBe('Valid till 20th July 2026');
    });

    it('captures contact variants: Reservation Numbers / Inquiry / Reservation E-mail', async () => {
        const fetcher = fetcherFor(detailHtml([
            ['Reservation Numbers', '011 234 5678 / 011 234 5679'],
            ['Reservation E-mail', 'book@hotel.lk'],
        ]));
        const detail = await fetcher.fetchDetail(listItem());
        expect(detail!.reservationNumber).toBe('011 234 5678 / 011 234 5679');
        expect(detail!.reservationEmail).toBe('book@hotel.lk');
    });
});

describe('parseSampathOffer — period source priority', () => {
    it('labeled period field wins over promotion-details prose', () => {
        const offer = parseSampathOffer(
            listItem({ promotion_period: 'Valid till 20th July 2026' }),
            detailPage({ promotionDetailsText: 'Enjoy 20% off until further notice from 1st January 2020' }),
        );
        expect(offer!.validityPeriods[0].validTo).toBe('2026-07-20');
    });

    it('placeholder period field ("Offer Details") falls back to prose, then API expiry', () => {
        const offer = parseSampathOffer(
            listItem({ promotion_period: 'Offer Details', expire_ts: '2026-09-30' }),
            detailPage({ promotionDetailsText: '20% off on all bookings. Valid till 15th September 2026.' }),
        );
        expect(offer!.validityPeriods[0].validTo).toBe('2026-09-15');

        const offer2 = parseSampathOffer(
            listItem({ promotion_period: 'Offer Details', expire_ts: '2026-09-30' }),
            detailPage({ promotionDetailsText: 'Great savings on selected items.' }),
        );
        expect(offer2!.validityPeriods[0].validTo).toBe('2026-09-30');
    });

    it('dual Booking/Stay periods produce typed validity rows', () => {
        const offer = parseSampathOffer(
            listItem({ promotion_period: 'Booking Period: Valid till 31st July 2026 Stay Period: 1st August to 31st October 2026' }),
            null,
        );
        expect(offer!.validityPeriods.map((p) => p.periodType)).toEqual([PeriodType.BOOKING, PeriodType.STAY]);
    });
});

describe('parseSampathOffer — live API field realities', () => {
    it('expire_on/display_on epoch-ms strings become the validity fallback', () => {
        // 1793471340000 → 2026-10-31 23:59 SL; 1784140200000 → 2026-07-16 00:00 SL
        const offer = parseSampathOffer(
            listItem({ expire_on: '1793471340000', display_on: '1784140200000', promotion_period: '' }),
            null,
        );
        expect(offer!.validityPeriods[0].validFrom).toBe('2026-07-16');
        expect(offer!.validityPeriods[0].validTo).toBe('2026-10-31');
    });

    it('eligible_card_categories string feeds applicable cards', () => {
        const offer = parseSampathOffer(
            listItem({ eligible_card_categories: 'Sampath Bank Credit & Debit Cards' }),
            null,
        );
        expect(offer!.offer.applicableCards).toEqual(['Credit Card', 'Debit Card']);
    });

    it('HTML in short_discount is stripped from the description', () => {
        const offer = parseSampathOffer(
            listItem({ short_discount: '<p>Special Rates</p>' }),
            null,
        );
        expect(offer!.offer.description).toBe('Special Rates');
    });
});

describe('SampathFetcher — pagination via total/size', () => {
    it('fetches all pages when API paginates with {total, size}', async () => {
        const page = (ids: number[]) => ({
            data: ids.map((id) => ({ id, title: `Offer ${id}`, company_name: `M${id}` })),
            total: 25, size: 10, page_number: 1,
        });
        const urls: string[] = [];
        const http = {
            getJSON: async (url: string) => {
                urls.push(url);
                const p = Number(url.match(/page=(\d+)/)?.[1] ?? 1);
                return { data: page([p * 10, p * 10 + 1]), fromCache: false, status: 200 };
            },
        } as unknown as HttpClient;

        const fetcher = new SampathFetcher(http, true);
        const items = await fetcher.fetchList({
            id: 1, name: 'Hotels', slug: 'hotels',
            url: 'https://www.sampath.lk/api/card-promotions?category=hotels&page={page}',
        });
        expect(urls).toHaveLength(3); // 25 total / 10 per page
        expect(items).toHaveLength(6);
    });
});

describe('parseSampathOffer — address shapes', () => {
    it('bulleted multi-location list splits per bullet (Sueen Nature Resort)', () => {
        const offer = parseSampathOffer(
            listItem(),
            detailPage({ fullAddress: '• No 10, Temple Road, Kandy • No 22, Lake Road, Nuwara Eliya' }),
        );
        expect(offer!.merchant.addresses).toEqual([
            'No 10, Temple Road, Kandy',
            'No 22, Lake Road, Nuwara Eliya',
        ]);
    });

    it('single street address gains the city tag', () => {
        const offer = parseSampathOffer(
            listItem({ city: 'Colombo 04' }),
            detailPage({ fullAddress: 'No.746, Galle Road', location: 'No.746, Galle Road' }),
        );
        expect(offer!.merchant.addresses).toEqual(['No.746, Galle Road, Colombo 04']);
    });

    it('reservation email lands on the merchant', () => {
        const offer = parseSampathOffer(
            listItem(),
            detailPage({ reservationEmail: 'book@hotel.lk' }),
        );
        expect(offer!.merchant.email).toEqual(['book@hotel.lk']);
    });
});
