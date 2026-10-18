import { normalizeNuxtPromoItem } from '@/banks/sampath/sampath-fetcher';
import { parseSampathOffer } from '@/banks/sampath/sampath-parser';

describe('Sampath Nuxt Adapter & Hydration State Resilience (Phase 5)', () => {
  const sanitizedRealNuxtFixtures = [
    {
      id: 101,
      title: 'Amaya Hills Kandy',
      merchant_name: 'Amaya Hills Kandy',
      discount: '38% Discount',
      category: 'hotels',
      valid_from: '2026-01-01',
      valid_to: '2026-12-31',
      cards: ['Mastercard', 'Visa'],
      description: 'Enjoy 38% savings at Amaya Hills Kandy with your Sampath Credit Cards.',
      image: '/api/uploads/amaya_hills.jpg',
      slug: 'amaya-hills-kandy-101',
    },
    {
      // Missing title and merchant_name, but partner present
      id: 102,
      partner: 'Jetwing Vil Uyana',
      short_discount: '20% off',
      category: 'Hotels',
      display_on: 1784140200000, // epoch ms
      expire_on: 1793471340000,
      eligible_card_categories: 'Sampath Bank Credit Cards',
      promotion_details: 'Minimum bill Rs. 5,000. Maximum discount Rs. 2,000.',
    },
    {
      // Reordered fields, missing discount percentage, installment wording
      id: 'inst_303',
      title: 'Nisaco Home Appliances',
      category: 'Electronics_and_Furniture',
      short_description: '06, 12, 20 & 24 months 0% Instalments for all Sampath Mastercard & Visa Credit Cardholders',
      contact_no: '011 234 5678',
      location: 'No. 12, Galle Road, Colombo',
    },
    {
      // Missing dates, missing merchant, title only
      id: 'bare_404',
      title: 'Uber Eats Sri Lanka',
      short_discount: 'Up to 65% Discount',
    },
  ];

  it('normalizes sanitized real-source Nuxt promo objects with complete fields', () => {
    const raw = sanitizedRealNuxtFixtures[0];
    const normalized = normalizeNuxtPromoItem(raw);

    expect(normalized.id).toBe(101);
    expect(normalized.title).toBe('Amaya Hills Kandy');
    expect(normalized.company_name).toBe('Amaya Hills Kandy');
    expect(normalized.discount).toBe('38% Discount');
    expect(normalized.eligible_cards).toEqual(['Mastercard', 'Visa']);
    expect(normalized.image_url).toBe('https://www.sampath.lk/api/uploads/amaya_hills.jpg');
    expect(normalized.detail_url).toBe('/sampath-cards/credit-card-offer/amaya-hills-kandy-101');

    const offer = parseSampathOffer(normalized, null);
    expect(offer).not.toBeNull();
    expect(offer!.uniqueId).toBe('sampath_101');
    expect(offer!.offer.discountPercentage).toBe(38);
    expect(offer!.validityPeriods[0].validTo).toBe('2026-12-31');
  });

  it('handles missing merchant and title gracefully by falling back to partner', () => {
    const raw = sanitizedRealNuxtFixtures[1];
    const normalized = normalizeNuxtPromoItem(raw);

    expect(normalized.company_name).toBe('Jetwing Vil Uyana');
    expect(normalized.title).toBe('Jetwing Vil Uyana');

    const offer = parseSampathOffer(normalized, null);
    expect(offer).not.toBeNull();
    expect(offer!.merchant.name).toBe('Jetwing Vil Uyana');
    expect(offer!.offer.discountPercentage).toBe(20);
    expect(offer!.transactionRange.min).toBe(5000);
    expect(offer!.transactionRange.max).toBeNull(); // Max discount 2,000 must NOT become max spend!
  });

  it('handles installment-only promotions with reordered keys without failure', () => {
    const raw = sanitizedRealNuxtFixtures[2];
    const normalized = normalizeNuxtPromoItem(raw);

    expect(normalized.title).toBe('Nisaco Home Appliances');
    expect(normalized.contact_no).toBe('011 234 5678');

    const offer = parseSampathOffer(normalized, null);
    expect(offer).not.toBeNull();
    expect(offer!.merchant.name).toBe('Nisaco Home Appliances');
    expect(offer!.merchant.phone).toContain('011 234 5678');
    expect(offer!.installmentPlans.length).toBeGreaterThan(0);
  });

  it('handles bare items with missing optional fields without throwing', () => {
    const raw = sanitizedRealNuxtFixtures[3];
    const normalized = normalizeNuxtPromoItem(raw);

    expect(normalized.title).toBe('Uber Eats Sri Lanka');
    const offer = parseSampathOffer(normalized, null);
    expect(offer).not.toBeNull();
    expect(offer!.merchant.name).toBe('Uber Eats Sri Lanka');
    expect(offer!.offer.discountPercentage).toBe(65);
  });
});
