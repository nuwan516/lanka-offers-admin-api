/**
 * NDB address/hotline structures from the July 2026 survey (105 offers):
 * dominated by bare city names; "Address" is sometimes a domain/URL
 * (online stores) or a "." placeholder.
 */
import { parseNDBOffer, NDBRawOffer } from '@/banks/ndb/ndb-parser';
import { parseNDBDetailHtml } from '@/banks/ndb/ndb-fetcher';

function rawOffer(overrides: Partial<NDBRawOffer> = {}): NDBRawOffer {
    return {
        merchantName: 'Test Merchant',
        offerDetails: '20% off for NDB Credit Cards',
        validity: 'Until 31st July 2026',
        detailUrl: 'https://www.ndbbank.com/cards/card-offers/offer-details/400',
        _categoryName: 'Restaurants & Pubs',
        _categoryId: 3,
        ...overrides,
    };
}

describe('parseNDBOffer — survey address shapes', () => {
    it('city-only address (51/105): "Kalutara"', () => {
        const offer = parseNDBOffer(rawOffer({ location: 'Kalutara' }));
        expect(offer!.merchant.addresses).toEqual(['Kalutara, Sri Lanka']);
    });

    it('city + district code (13/105): "Colombo 03"', () => {
        const offer = parseNDBOffer(rawOffer({ location: 'Colombo 03' }));
        expect(offer!.merchant.addresses).toEqual(['Colombo 03, Sri Lanka']);
    });

    it('"All Outlets" / "All Locations" fall back to merchant name', () => {
        for (const loc of ['All Outlets', 'All outlets', 'All Locations']) {
            const offer = parseNDBOffer(rawOffer({ merchantName: 'Keells', location: loc }));
            expect(offer!.merchant.addresses).toEqual(['Keells, Sri Lanka']);
        }
    });

    it('"." placeholder address falls back to merchant name', () => {
        const offer = parseNDBOffer(rawOffer({ merchantName: 'Hunters', location: '.' }));
        expect(offer!.merchant.addresses).toEqual(['Hunters, Sri Lanka']);
    });

    it('domain-as-address (data-entry error, 6/105) is not geocoded as a place', () => {
        const offer = parseNDBOffer(rawOffer({ merchantName: 'BigDeals', location: 'BigDeals.lk' }));
        expect(offer!.merchant.addresses).toEqual(['BigDeals, Sri Lanka']);
        const offer2 = parseNDBOffer(rawOffer({ merchantName: 'PickMe', location: 'https://pickme.lk' }));
        expect(offer2!.merchant.addresses).toEqual(['PickMe, Sri Lanka']);
    });

    it('street + city (5/105): "Templers Rd, Mt. Lavinia"', () => {
        const offer = parseNDBOffer(rawOffer({ location: 'Templers Rd, Mt. Lavinia' }));
        expect(offer!.merchant.addresses).toEqual(['Templers Rd, Mt. Lavinia, Sri Lanka']);
    });
});

describe('parseNDBDetailHtml — server-rendered detail page', () => {
    // Mirrors the real markup of /cards/card-offers/offer-details/{id}
    const html = `
      <main>
        <p><strong>Type:</strong> Credit Cards</p>
        <h5 class="mt-3">Special Conditions</h5>
        <div><p>Reserve Via - <a href="mailto:reservations@zenethlabs.ca">reservations@zenethlabs.ca</a></p></div>
        <p>Offer valid period : Booking &amp; Stay Period - Until 30th November 2026</p>
        <div class="col-md-4">
          <div class="card bg-light-subtle p-3">
            <h3>Kixi Beach Villa – Talpe</h3>
            <h5>Address</h5><p>Talpe</p>
            <h5>Hotline</h5><p>077 344 3544 / 011 244 8888</p>
            <h5>Website</h5><p><a href="http://www.zenethcollection.lk/">http://www.zenethcollection.lk/</a></p>
          </div>
        </div>
      </main>`;

    it('extracts address, hotline list, website, type, and period', () => {
        const d = parseNDBDetailHtml(html, rawOffer({ location: undefined, phoneNumbers: [], validity: '' }));
        expect(d.location).toBe('Talpe');
        expect(d.phoneNumbers).toEqual(['077 344 3544', '011 244 8888']);
        expect(d.website).toBe('http://www.zenethcollection.lk/');
        expect(d.cardType).toBe('Credit Cards');
        expect(d.validity).toBe('Booking & Stay Period - Until 30th November 2026');
    });

    it('"." placeholder address keeps the listing value', () => {
        const dotHtml = html.replace('<h5>Address</h5><p>Talpe</p>', '<h5>Address</h5><p>.</p>');
        const d = parseNDBDetailHtml(dotHtml, rawOffer({ location: 'Kalutara' }));
        expect(d.location).toBe('Kalutara');
    });
});

describe('parseNDBOffer — hotline placeholders', () => {
    it('"." placeholder hotline yields no phone entries', () => {
        const offer = parseNDBOffer(rawOffer({ phoneNumbers: ['.'], phone: '-' }));
        expect(offer!.merchant.phone).toEqual([]);
    });

    it('"/"-separated hotline numbers are kept', () => {
        const offer = parseNDBOffer(rawOffer({ phoneNumbers: ['011 244 8888', '077 123 4567'] }));
        expect(offer!.merchant.phone).toEqual(['011 244 8888', '077 123 4567']);
    });
});
