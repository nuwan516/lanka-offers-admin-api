import { parseNSBOffer, NSBRawOffer } from '@/banks/nsb/nsb-parser';

function rawOffer(overrides: Partial<NSBRawOffer['listing']> = {}, detail: Partial<NSBRawOffer['detail']> | null = {}): NSBRawOffer {
  return {
    listing: {
      title: 'Spend and Win with your NSB Mastercard Debit Card!',
      excerpt: '',
      thumbnailUrl: 'https://www.nsb.lk/wp-content/uploads/2023/01/offer.jpg',
      detailUrl: 'https://www.nsb.lk/spend-and-win-with-your-nsb-mastercard-debit-card/',
      _categoryName: 'Card Offers',
      _categoryId: 1,
      ...overrides,
    },
    detail: detail === null ? null : {
      title: 'Spend and Win with your NSB Mastercard Debit Card!',
      paragraphs: ['Spend and Win, merchant vouchers worth Rs. 1 million', '100 winners, each Rs. 10,000 LKR voucher'],
      listItems: ['Promo period – 10th to 31st December 2025', 'Only for Uber rides'],
      images: ['https://www.nsb.lk/wp-content/uploads/2023/01/offer.jpg'],
      promoPeriod: '10th to 31st December 2025',
      fullText: 'Spend and Win, merchant vouchers worth Rs. 1 million Promo period – 10th to 31st December 2025',
      ...detail,
    },
  };
}

describe('parseNSBOffer', () => {
  it('normalizes a real NSB listing+detail page into an Offer', () => {
    const offer = parseNSBOffer(rawOffer());

    expect(offer).not.toBeNull();
    expect(offer?.source).toBe('nsb');
    expect(offer?.title).toBe('Spend and Win with your NSB Mastercard Debit Card!');
    expect(offer?.cardEligibility.cardTypes).toContain('Debit Card');
    expect(offer?.validityPeriods[0].validFrom).toBe('2025-12-10');
    expect(offer?.validityPeriods[0].validTo).toBe('2025-12-31');
  });

  it('falls back to title-derived merchant when no "at X" phrase exists', () => {
    const offer = parseNSBOffer(rawOffer(
      { title: 'iPhone 13 Series Offer' },
      { title: 'iPhone 13 Series Offer', paragraphs: [], listItems: [], promoPeriod: null, fullText: '' },
    ));
    expect(offer?.merchant.name).toBe('iPhone 13 Series Offer');
  });

  it('extracts a specific merchant when the prose names one', () => {
    const offer = parseNSBOffer(rawOffer(
      {},
      {
        paragraphs: ['Get 20% off at Cafe Kumbuk with your NSB Credit Card.'],
        listItems: [],
        promoPeriod: null,
        fullText: 'Get 20% off at Cafe Kumbuk with your NSB Credit Card.',
      },
    ));
    expect(offer?.merchant.name).toBe('Cafe Kumbuk');
  });

  it('extracts merchant when preceded by @ in marketing headline', () => {
    const offer = parseNSBOffer(rawOffer(
      { title: 'Enjoy 10% off @ CIB Fashion with NSB Debit Card' },
      { title: 'Enjoy 10% off @ CIB Fashion with NSB Debit Card', paragraphs: [], listItems: [], promoPeriod: null, fullText: '' }
    ));
    expect(offer?.merchant.name).toBe('CIB Fashion');
  });

  it('resolves bank-direct cashback/promos to National Savings Bank', () => {
    const offer = parseNSBOffer(rawOffer(
      { title: '20% Cashback Exclusively for NSB Sthree Account Holders' },
      { title: '20% Cashback Exclusively for NSB Sthree Account Holders', paragraphs: [], listItems: [], promoPeriod: null, fullText: '' }
    ));
    expect(offer?.merchant.name).toBe('National Savings Bank');
  });

  it('returns null when there is no title and no description at all', () => {
    const offer = parseNSBOffer(rawOffer({ title: '', excerpt: '' }, { title: '', paragraphs: [], listItems: [], fullText: '' }));
    expect(offer).toBeNull();
  });

  it('handles a detail-less offer (listing only) without crashing', () => {
    const offer = parseNSBOffer(rawOffer({ excerpt: '15% off on selected items.' }, null));
    expect(offer).not.toBeNull();
    expect(offer?.offer.description).toContain('15% off');
  });

  it('extracts merchant, upto discount, and records upto restriction from marketing title', () => {
    const offer = parseNSBOffer(rawOffer(
      { title: 'Enjoy upto 30% off at Hayleys hotels with your NSB Mastercard Debit Card!' },
      {
        title: 'Enjoy upto 30% off at Hayleys hotels with your NSB Mastercard Debit Card!',
        paragraphs: ['Special conditions apply. Valid until 20th December 2025.'],
        listItems: [],
        promoPeriod: 'Until 20th December 2025',
        fullText: 'Enjoy upto 30% off at Hayleys hotels with your NSB Mastercard Debit Card! Special conditions apply. Valid until 20th December 2025.',
      }
    ));
    expect(offer).not.toBeNull();
    expect(offer?.merchant.name).toBe('Hayleys hotels');
    expect(offer?.offer.discountPercentage).toBe(30);
    expect(offer?.offer.restrictions).toContain('Discount is "up to" the stated percentage, may vary by item/venue');
    expect(offer?.validityPeriods[0].validTo).toBe('2025-12-20');
  });
});
