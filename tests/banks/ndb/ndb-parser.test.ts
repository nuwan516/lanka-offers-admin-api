import { parseNDBOffer } from '@/banks/ndb/ndb-parser';

describe('parseNDBOffer', () => {
  it('normalizes rendered NDB card data into an Offer', () => {
    const offer = parseNDBOffer({
      merchantName: 'Hotel Blue',
      location: 'No. 20, Beach Road, Colombo',
      phoneNumbers: ['011 2223333'],
      offerDetails: '20% off for NDB Visa Credit Cards. Minimum bill Rs. 10,000.',
      validity: 'Until 28th February 2026',
      cardType: 'Credit Cards',
      coverImage: 'https://www.ndbbank.com/cover.jpg',
      merchantLogo: 'https://www.ndbbank.com/logo.jpg',
      detailUrl: 'https://www.ndbbank.com/cards/card-offers/offer-details/hotel-blue',
      _categoryName: 'Hotels & Villas',
      _categoryId: 7,
    });

    expect(offer).not.toBeNull();
    expect(offer).toMatchObject({
      source: 'ndb',
      title: '20% off for NDB Visa Credit Cards. Minimum bill Rs. 10,000.',
      category: 'Hotels & Villas',
      categoryId: 7,
    });
    expect(offer?.merchant.addresses[0]).toContain('Beach Road');
    expect(offer?.offer.discountPercentage).toBe(20);
    expect(offer?.transactionRange.min).toBe(10000);
    expect(offer?.cardEligibility.networks).toContain('Visa');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-02-28');
  });

  it('strictly separates minimum bill from maximum discount cap without setting max spend', () => {
    const offer = parseNDBOffer({
      merchantName: 'Pizza Haven',
      offerDetails: '25% off on food. Minimum bill Rs. 2,500. Maximum discount Rs. 750.',
      validity: 'Valid till 31st December 2026',
      cardType: 'Credit Cards',
      _categoryName: 'Dining',
    });

    expect(offer).not.toBeNull();
    expect(offer?.transactionRange.min).toBe(2500);
    expect(offer?.transactionRange.max).toBeNull(); // Must NOT be 750!
    expect(offer?.offer.discountPercentage).toBe(25);
  });
});
