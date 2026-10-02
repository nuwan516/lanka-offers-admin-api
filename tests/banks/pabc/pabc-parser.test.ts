import { parsePABCOffer } from '@/banks/pabc/pabc-parser';

describe('parsePABCOffer', () => {
  it('normalizes Pan Asia flip-card data into an Offer', () => {
    const offer = parsePABCOffer({
      imageUrl: 'https://www.pabcbank.com/card.jpg',
      imageAlt: 'Cafe Ceylon',
      discount: '15% OFF',
      validityDate: '30/04/2026',
      description:
        '15% OFF at Cafe Ceylon for Pan Asia Credit or Debit Card holders. Minimum spend Rs. 3,000. ' +
        'Offer valid until 30th April 2026.',
      _categoryName: 'Card Offers',
      _categoryId: 1,
      _sourceUrl: 'https://www.pabcbank.com/card-offers/',
    });

    expect(offer).not.toBeNull();
    expect(offer).toMatchObject({
      source: 'pabc',
      category: 'Card Offers',
      categoryId: 1,
    });
    expect(offer?.merchant.name).toBe('Cafe Ceylon');
    expect(offer?.offer.discountPercentage).toBe(15);
    expect(offer?.transactionRange.min).toBe(3000);
    expect(offer?.cardEligibility.cardTypes).toEqual(['Credit Card', 'Debit Card']);
    expect(offer?.validityPeriods[0].validTo).toBe('2026-04-30');
  });

  // Reference scraper's documented finding: the flip-card FRONT date is a
  // "posted" date, not the expiry — using it as validity input silently
  // produced validTo:null on every live PABC offer (confirmed 2026-07-19).
  it('does NOT use the front-card date as validity — real expiry comes from description', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Breeze Bar',
      discount: '30% OFF',
      validityDate: '15-07-2026', // posted date — must be ignored for validity
      description:
        'Enjoy 30% OFF at Breeze Bar, Cheers Pub, Nuga Gama and Chutneys at Cinnamon Grand Colombo ' +
        'with your Pan Asia Bank Credit Card. Offer valid until 31st July 2026. ' +
        'Maximum discount: LKR 5,000/-. T&Cs Apply.',
      _sourceUrl: 'https://www.pabcbank.com/card-offers/',
    });

    expect(offer?.validityPeriods[0].validTo).toBe('2026-07-31');
    // anchored "at X ... with your Pan Asia" match, not the posted date text
    expect(offer?.merchant.name).toBe('Breeze Bar, Cheers Pub, Nuga Gama and Chutneys at Cinnamon Grand Colombo');
    expect(offer?.offer.restrictions).toContain('Maximum discount: LKR 5000');
  });

  it('falls back to open-ended validity when no "valid until/till" phrase exists', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Some Merchant',
      discount: '20% OFF',
      validityDate: '01-01-2026',
      description: '20% OFF at Some Merchant with your Pan Asia Bank Credit Card. T&Cs Apply.',
      _sourceUrl: 'https://www.pabcbank.com/card-offers/',
    });

    expect(offer?.validityPeriods[0].validTo).toBeNull();
  });

  it('extracts the short merchant name from "at X into 0% instalment plans ... using your Pan Asia" (not the whole clause)', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: '',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Convert purchases above Rs. 25,000 at Singhagiri into 0% instalment plans for 12 or 24 months ' +
        'using your Pan Asia Bank Credit Card. Offer valid until 31 December 2026.',
    });
    // Regression: the looser "using your Pan Asia" anchor used to fire first
    // and swallow the whole "into ... instalment ... using" clause.
    expect(offer?.merchant.name).toBe('Singhagiri');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
  });

  it('handles "valid till" phrasing too', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Jade Restaurant',
      discount: '10% OFF',
      validityDate: '20-07-2026',
      description: '10% OFF at Jade Restaurant with your Pan Asia Bank Credit Card. Offer valid till 20th August 2026.',
      _sourceUrl: 'https://www.pabcbank.com/card-offers/',
    });

    expect(offer?.validityPeriods[0].validTo).toBe('2026-08-20');
  });

  // Confirmed live 2026-08-01: every single flip-card's image alt attribute
  // is the literal placeholder "Avatar" — never real content. Using it as a
  // merchant-name fallback let "Avatar" silently win over parsing the
  // description whenever the "at X" patterns failed to match.
  it('never uses the "Avatar" image-alt placeholder as the merchant name fallback', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description: 'Make insurance payments easier with Pan Asia Bank interest-free instalment plans.',
    });
    expect(offer?.merchant.name).not.toBe('Avatar');
  });

  it('handles "at X into a N & M Months 0% Instalment Plan with..." — filler between "into" and "instalment"', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Convert transactions above Rs. 25,000/- at Dinapala into a 12 & 24 Months 0% Instalment Plan ' +
        'with your Pan Asia Bank Credit Card. Offer valid until 31st December 2026.',
    });
    expect(offer?.merchant.name).toBe('Dinapala');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
  });

  it('trims "and enjoy exclusive discounts" filler between the venue name and "with your Pan Asia"', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Plan your next retreat at Oak Ray Elephant Lake, Habarana and enjoy exclusive discounts with your ' +
        'Pan Asia Credit Card. Cardholders can enjoy 35% off Double Full Board (DBL FB) packages and ' +
        '30% off Triple Full Board (TPL FB) packages until 31 October 2026.',
    });
    expect(offer?.merchant.name).toBe('Oak Ray Elephant Lake, Habarana');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-10-31');
  });

  it('stops at "with exclusive ..." filler when "with your Pan Asia" is only in a later sentence', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Experience comfort and convenience at Oak Ray City Hotel Kandy with exclusive cardholder privileges. ' +
        'Enjoy 35% off Double Half Board (DBL HB) packages until 31 October 2026 with your Pan Asia Bank Credit Card.',
    });
    expect(offer?.merchant.name).toBe('Oak Ray City Hotel Kandy');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-10-31');
  });

  it('stops at "on transactions above Rs." qualifier (Lyceum Campus)', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Pan Asia Bank Credit Cardholders can enjoy a convenient 0% installment plan for 12 or 24 months ' +
        'at Lyceum Campus on transactions above Rs. 25,000, making it easier for students and parents. ' +
        'Valid until 31st December 2026.',
    });
    expect(offer?.merchant.name).toBe('Lyceum Campus');
    expect(offer?.validityPeriods[0].validTo).toBe('2026-12-31');
  });

  it('bare "... packages until 31 October 2026" with no "valid" word at all is still parsed', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Make your stay at Liyya Water Villa, Dambulla more rewarding with special discounts for Pan Asia ' +
        'Credit Cardholders. Enjoy 35% OFF Double Full Board (DBL FB) packages until 31 October 2026.',
    });
    expect(offer?.validityPeriods[0].validTo).toBe('2026-10-31');
  });

  it('the "Anything, Anywhere" generic offer with no date at all falls back to open-ended validity', () => {
    const offer = parsePABCOffer({
      imageUrl: '',
      imageAlt: 'Avatar',
      discount: '',
      validityDate: '01-01-2026',
      description:
        'Shop smarter with Pan Asia Bank Credit Cards and convert any purchase above Rs. 25,000 into ' +
        'convenient 12 or 24-month 0% installment plans. Enjoy seamless spending anytime, anywhere. ' +
        'Processing fee applicable. T&Cs Apply.',
    });
    expect(offer?.validityPeriods[0].validTo).toBeNull();
  });
});
