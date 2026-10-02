import { parseDFCCOffer } from '@/banks/dfcc/dfcc-parser';
import { RecurrenceType } from '@/core/types/offers';

describe('parseDFCCOffer', () => {
  // Confirmed live 2026-08-01: every "Read More" link 200s at the HTTP
  // level but client-side-routes to "Page Not Found (404)" — there is no
  // working detail page on this site at all. All real data (including the
  // validity date, which is NOT in the offer sentence) must come from the
  // listing card alone: offerText + the separate .cardOfferValid line +
  // the structured .discount-badgee percentage.
  it('parses a complete offer from listing-only data (detail is always null in practice)', () => {
    const offer = parseDFCCOffer({
      listing: {
        cardType: 'Credit Card',
        offerText: '20% Savings on dine-in at Cinnamon Grand Colombo with DFCC Credit Cards.',
        validityText: 'Monday, Tuesday and Wednesday from 1 July to 29 July 2026',
        discountBadge: '20%',
        imageUrl: 'https://www.dfcc.lk/cinnamon.jpg',
        imageAlt: 'Cinnamon grand colombo',
        detailUrl: 'https://www.dfcc.lk/cards/cards-promotions/cinnamon-grand-colombo',
        _categoryName: 'Dining',
        _categoryId: 2,
      },
      detail: null,
    });

    expect(offer).not.toBeNull();
    expect(offer?.merchant.name).toBe('Cinnamon Grand Colombo');
    expect(offer?.offer.discountPercentage).toBe(20);
    expect(offer?.validityPeriods[0].validFrom).toBe('2026-07-01');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-07-29');
    expect(offer?.validityPeriods[0].recurrenceType).toBe(RecurrenceType.SPECIFIC_WEEKDAYS);
    expect(offer?.validityPeriods[0].recurrenceDays).toEqual(
      expect.arrayContaining(['monday', 'tuesday', 'wednesday']),
    );
  });

  it('falls back to scanning offerText for a date when validityText is empty', () => {
    const offer = parseDFCCOffer({
      listing: {
        cardType: 'Credit Card',
        offerText: '15% off at Some Shop valid until 31st December 2026.',
        validityText: '',
        discountBadge: '',
        imageUrl: '',
        imageAlt: 'Some Shop',
        detailUrl: 'https://www.dfcc.lk/cards/cards-promotions/some-shop',
        _categoryName: 'Other',
        _categoryId: 24,
      },
      detail: null,
    });
    expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
  });
  it('normalizes DFCC listing and detail data into an Offer', () => {
    const offer = parseDFCCOffer({
      listing: {
        cardType: 'Credit Card',
        offerText: '30% off at Urban Kitchen. Minimum Spend: Rs. 7,500.',
        imageUrl: 'https://www.dfcc.lk/listing.jpg',
        imageAlt: 'Urban Kitchen',
        detailUrl: 'https://www.dfcc.lk/promotions/urban-kitchen',
        _categoryName: 'Dining',
        _categoryId: 2,
      },
      detail: {
        title: 'Urban Kitchen DFCC Offer',
        description: 'Valid until 30 April 2026. Subject to availability.',
        image: 'https://www.dfcc.lk/detail.jpg',
        termsAndConditions: ['Minimum Spend: Rs. 7,500'],
        rawText: 'Urban Kitchen DFCC Offer',
      },
    });

    expect(offer).not.toBeNull();
    expect(offer).toMatchObject({
      source: 'dfcc',
      title: 'Urban Kitchen DFCC Offer',
      category: 'Dining',
      categoryId: 2,
    });
    expect(offer?.offer.discountPercentage).toBe(30);
    expect(offer?.merchant.name).toBe('Urban Kitchen');
    expect(offer?.transactionRange.min).toBe(7500);
    expect(offer?.cardEligibility.cardTypes).toContain('Credit Card');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-04-30');
  });

  it('stops live supermarket merchant extraction before bill conditions', () => {
    const offer = parseDFCCOffer({
      listing: {
        cardType: 'Credit Card',
        offerText: '10% Savings on the Total Bill at Laugfs Super for bills over Rs. 5,000/- with DFCC Credit Cards.',
        imageUrl: 'https://www.dfcc.lk/laugfs.png',
        imageAlt: 'Laugfs',
        detailUrl: 'https://www.dfcc.lk/cards/cards-promotions/laugfs-promotion',
        _categoryName: 'Supermarkets',
        _categoryId: 1,
      },
      detail: {
        title: 'Supermarkets',
        description: 'About Us Corporate Information',
        image: '',
        termsAndConditions: ['Investor Reports', 'Valid until 31 December 2026.'],
        rawText: 'About Us Investor Media Center',
      },
    });

    expect(offer?.title).toBe('10% Savings at Laugfs Super');
    expect(offer?.merchant.name).toBe('Laugfs Super');
    expect(offer?.offer.description).not.toContain('About Us');
  });
});
