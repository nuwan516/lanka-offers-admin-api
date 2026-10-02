import { parseComBankOffer, ComBankRawOffer } from '@/banks/combank/combank-parser';
import { PeriodType } from '@/core/types/offers';

function rawOffer(overrides: Partial<ComBankRawOffer['listing']> = {}, detail: ComBankRawOffer['detail'] | null = {
  mainImageUrl: 'https://cdn.combank.lk/detail.jpg',
  sections: {
    'Offer terms and conditions': [
      { type: 'item', text: 'Offer – 20% for Credit Cards and 10% for Debit Cards' },
      { type: 'item', text: 'Offer valid on every Wednesdays till 26th August 2026' },
      { type: 'item', text: 'The minimum bill value at Delifrance is Rs.2,500' },
    ],
    'Terms and conditions': [
      { type: 'item', text: 'The promotion is open to all Credit and Debit Cards issued by Commercial Bank' },
    ],
  },
}): ComBankRawOffer {
  return {
    listing: {
      title: 'Enjoy the art of dining at your favourite Softlogic Restaurants with ComBank Credit and Debit Cards',
      categoryLabel: 'Food & Restaurants',
      discountText: 'Up to 20% Off',
      discountPercentage: 20,
      isUpTo: true,
      validityRaw: 'Offer valid on every Wednesday from 01st July to 26th August 2026',
      imageUrl: 'https://cdn.combank.lk/thumb.jpg',
      detailUrl: 'https://www.combank.lk/rewards-promotion/food-restaurants/softlogic-restaurants',
      _categoryId: 1,
      ...overrides,
    },
    detail,
  };
}

describe('parseComBankOffer', () => {
  it('normalizes a real ComBank listing+detail page into an Offer', () => {
    const offer = parseComBankOffer(rawOffer());

    expect(offer).not.toBeNull();
    expect(offer?.source).toBe('combank');
    expect(offer?.category).toBe('Food & Restaurants');
    expect(offer?.merchant.name).toBe('Softlogic Restaurants');
    expect(offer?.offer.discountPercentage).toBe(20);
    expect(offer?.cardEligibility.cardTypes).toEqual(['Credit Card', 'Debit Card']);
    expect(offer?.validityPeriods[0].validFrom).toBe('2026-07-01');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-08-26');
    expect(offer?.validityPeriods[0].recurrenceDays).toEqual(['wednesday']);
    expect(offer?.transactionRange.min).toBe(2500);
  });

  it('excludes the generic "Terms and conditions" boilerplate section from description/terms', () => {
    const offer = parseComBankOffer(rawOffer());
    expect(offer?.offer.description).not.toContain('open to all Credit and Debit Cards issued by Commercial Bank');
    expect(offer?.offer.generalTerms.some((t) => t.includes('open to all Credit'))).toBe(false);
  });

  it('flags "up to" discounts as a restriction (rate may vary by item/venue)', () => {
    const offer = parseComBankOffer(rawOffer());
    expect(offer?.offer.restrictions.some((r) => /up to.*may vary/i.test(r))).toBe(true);
  });

  it('works with no detail page (listing data only)', () => {
    const offer = parseComBankOffer(rawOffer({}, null));
    expect(offer).not.toBeNull();
    expect(offer?.validityPeriods[0].validFrom).toBe('2026-07-01');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-08-26');
  });

  it('extracts a plain merchant name when title has no "at X with ComBank" phrasing', () => {
    const offer = parseComBankOffer(rawOffer({ title: 'Get 15% off at Cafe Kumbuk for all ComBank cardholders' }));
    expect(offer?.merchant.name).toBe('Cafe Kumbuk');
  });

  it('extracts merchant from "via X with ComBank" phrasing', () => {
    const offer = parseComBankOffer(rawOffer({
      title: 'Unlock great deals on online purchases via Cargills Online with ComBank Credit Cards',
    }));
    expect(offer?.merchant.name).toBe('Cargills Online');
  });

  it('extracts a bare domain named directly in the title', () => {
    const offer = parseComBankOffer(rawOffer({
      title: 'Great online deals with tudo.lk using ComBank Credit and Debit Cards',
    }));
    expect(offer?.merchant.name).toBe('tudo.lk');
  });

  it('falls back to the full title when "at X" only captures a generic placeholder noun', () => {
    const offer = parseComBankOffer(rawOffer({
      title: 'Enjoy the art of dining at your favourite restaurant with ComBank Credit and Debit Cards',
    }));
    expect(offer?.merchant.name).toBe('Enjoy the art of dining at your favourite restaurant with ComBank Credit and Debit Cards');

    const offer2 = parseComBankOffer(rawOffer({
      title: 'Relax at your favourite holiday destination with ComBank Credit and Debit Cards',
    }));
    expect(offer2?.merchant.name).toBe('Relax at your favourite holiday destination with ComBank Credit and Debit Cards');
  });

  it('returns null for an offer with no title', () => {
    const offer = parseComBankOffer(rawOffer({ title: '' }));
    expect(offer).toBeNull();
  });

  // Confirmed live 2026-08-01: two "Embark on a journey to Singapore" tiles
  // resolve to the identical detail URL but carry different badge/validity
  // metadata. A URL-only uniqueId would collide and the global dedupe step
  // would silently drop one entry.
  it('two listing tiles sharing the same detail URL but different metadata get distinct uniqueIds', () => {
    const url = 'https://www.combank.lk/rewards-promotion/travel/singapore';
    const offerA = parseComBankOffer(rawOffer({
      title: 'Embark on a journey to Singapore with ComBank Visa Cards',
      discountText: 'Up to 52% Off',
      discountPercentage: 52,
      validityRaw: 'Offer valid till 31st August 2027',
      detailUrl: url,
    }));
    const offerB = parseComBankOffer(rawOffer({
      title: 'Embark on a journey to Singapore with ComBank Visa Cards',
      discountText: 'Best Offer',
      discountPercentage: null,
      isUpTo: false,
      validityRaw: 'Offer valid till 31st December 2026',
      detailUrl: url,
    }));

    expect(offerA?.uniqueId).not.toBe(offerB?.uniqueId);
    expect(offerA?.validityPeriods[0].validTo).toBe('2027-08-31');
    expect(offerB?.validityPeriods[0].validTo).toBe('2026-12-31');
  });

  it('decimal percentage badge (7.5%) is captured', () => {
    const offer = parseComBankOffer(rawOffer({ discountText: '7.5% Off', discountPercentage: 7.5 }));
    expect(offer?.offer.discountPercentage).toBe(7.5);
  });

  it('"Best Offer" non-numeric badge yields null discount, not a crash', () => {
    const offer = parseComBankOffer(rawOffer(
      { discountText: 'Best Offer', discountPercentage: null, isUpTo: false },
      { mainImageUrl: null, sections: { 'Offer terms and conditions': [{ type: 'item', text: 'Enjoy exclusive rates' }] } },
    ));
    expect(offer?.offer.discountPercentage).toBeNull();
  });

  it('offer with zero terms content (Travel Insurance: title + validity + link only)', () => {
    const offer = parseComBankOffer(rawOffer(
      { title: 'Travel Insurance for ComBank Cardholders', validityRaw: 'Offer valid till 31st December 2026' },
      null,
    ));
    expect(offer).not.toBeNull();
    expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
    expect(offer?.offer.generalTerms).toEqual([]);
  });

  it('offers with only a bare "Terms and conditions" section keep it as offer-specific content (not excluded as boilerplate)', () => {
    // ~1/3 of live offers (LankaPay cashback, ABS facility, AICPA/CIMA, Q+
    // toll) skip the "Offer terms..." heading entirely — the discount/date
    // info lives ONLY inside a section literally named "Terms and conditions".
    const offer = parseComBankOffer(rawOffer(
      { title: 'LankaPay Cashback for ComBank Cardholders', validityRaw: '' },
      {
        mainImageUrl: null,
        sections: {
          'Terms and conditions': [
            { type: 'item', text: '5% cashback for LankaPay QR transactions' },
            { type: 'item', text: 'Offer valid till 30th September 2026' },
          ],
        },
      },
    ));
    expect(offer?.offer.description).toContain('5% cashback');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-09-30');
  });

  it('"Offer Terms and conditions" (capitalized) and "Call and Convert - Terms and conditions" headings are both treated as offer-specific', () => {
    const offer1 = parseComBankOffer(rawOffer({ validityRaw: '' }, {
      mainImageUrl: null,
      sections: {
        'Offer Terms and conditions': [{ type: 'item', text: 'Offer valid till 30th November 2026' }],
        'Terms and conditions': [{ type: 'item', text: 'Generic boilerplate' }],
      },
    }));
    expect(offer1?.validityPeriods[0].validTo).toBe('2026-11-30');
    expect(offer1?.offer.description).not.toContain('Generic boilerplate');

    const offer2 = parseComBankOffer(rawOffer({ validityRaw: '' }, {
      mainImageUrl: null,
      sections: {
        'Call and Convert - Terms and conditions': [{ type: 'item', text: 'Offer valid till 31st October 2026' }],
      },
    }));
    expect(offer2?.validityPeriods[0].validTo).toBe('2026-10-31');
  });

  it('secondary "Stay Period" bullet distinct from the headline offer date produces an additional validity entry', () => {
    const offer = parseComBankOffer(rawOffer(
      { title: 'Hunas Falls Resort Offer', validityRaw: 'Offer valid till 31st October 2026' },
      {
        mainImageUrl: null,
        sections: {
          'Offer terms and conditions': [
            { type: 'item', text: '20% off on room rates' },
            { type: 'item', text: 'Stay Period – Till 30th September 2026' },
          ],
        },
      },
    ));

    expect(offer?.validityPeriods).toHaveLength(2);
    expect(offer?.validityPeriods[0].validTo).toBe('2026-10-31'); // headline (Offer)
    expect(offer?.validityPeriods[1].periodType).toBe(PeriodType.STAY);
    expect(offer?.validityPeriods[1].validTo).toBe('2026-09-30');
  });

  it('a table embedded in the detail content (DHL/NCG-style) is captured as row text, not silently dropped', () => {
    const offer = parseComBankOffer(rawOffer({ validityRaw: 'Offer valid till 31st December 2026' }, {
      mainImageUrl: null,
      sections: {
        'Offer terms and conditions': [
          { type: 'item', text: 'Colombo 03 | 011 2 345 678 | No 10, Galle Road' },
        ],
      },
    }));
    expect(offer?.offer.generalTerms.some((t) => t.includes('Galle Road'))).toBe(true);
  });

  describe('extractMerchantName regression patterns', () => {
    it('extracts merchant with "with <Merchant> using ComBank"', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Travel to your favourite destination with Sri Lankan Airlines using ComBank Credit Cards',
      }));
      expect(offer?.merchant.name).toBe('Sri Lankan Airlines');
    });

    it('extracts merchant with "with <Merchant> and ComBank"', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Visit your favourite holiday destination with FitsAir and ComBank Debit Cards',
      }));
      expect(offer?.merchant.name).toBe('FitsAir');
    });

    it('extracts merchant with "from <Merchant> with ComBank"', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Enjoy Super Sized Discounts from Abans with ComBank Credit and Debit Cards',
      }));
      expect(offer?.merchant.name).toBe('Abans');
    });

    it('extracts merchant with "on <Merchant> with ComBank"', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Fuel your journey with savings on Mobil Engine Oil with ComBank Credit and Debit Cards',
      }));
      expect(offer?.merchant.name).toBe('Mobil Engine Oil');
    });

    it('extracts partner organization from "for the Student and Members of <Org>"', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Special Credit Card Easy Payment Plans for the Student and Members of AICPA and CIMA',
      }));
      expect(offer?.merchant.name).toBe('AICPA and CIMA');
    });

    it('resolves bank utility offers to Commercial Bank', () => {
      const offer = parseComBankOffer(rawOffer({
        title: 'Pay for your Education with ComBank Credit Cards',
      }));
      expect(offer?.merchant.name).toBe('Commercial Bank');
    });
  });
});
