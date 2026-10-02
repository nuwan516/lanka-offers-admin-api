import { computeThreeWayDiff } from '@/domain/offer-diff';
import { computeEffectiveOffer } from '@/domain/effective-offer';
import type { Offer } from '@/core/types/offers';
import { PeriodType, RecurrenceType } from '@/core/types/offers';

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    uniqueId: 'hnb_001', source: 'hnb', sourceId: '001', sourceUrl: 'https://bank.example/1',
    title: 'Offer', category: 'Dining', categoryId: 1, cardType: 'Gold',
    scrapedAt: '2026-01-01T00:00:00.000Z',
    merchant: { name: 'Merchant', location: 'Colombo', addresses: [], phone: [], email: [], website: null, logo: null },
    offer: { description: '', discountPercentage: 20, applicableCards: [], bookingRequired: false, restrictions: [], specialConditions: [], generalTerms: [] },
    installmentPlans: [],
    transactionRange: { min: null, max: null, currency: 'LKR' },
    cardEligibility: { includedCards: [], excludedCards: [], cardTypes: ['Gold'], networks: [], restrictions: [] },
    images: { logo: null, gallery: [], images: [] },
    validityPeriods: [{
      validFrom: '2026-01-01', validTo: '2026-09-30', periodType: PeriodType.OFFER, recurrenceType: RecurrenceType.DAILY,
      recurrenceDays: null, timeWindow: null, exclusionDays: null, blackoutPeriods: null, exclusionNotes: null, rawPeriodText: '',
    }],
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('computeThreeWayDiff', () => {
  it('detects a scraper-driven change between published and candidate', () => {
    const published = makeOffer({ offer: { ...makeOffer().offer, discountPercentage: 20 } });
    const candidate = makeOffer({ offer: { ...makeOffer().offer, discountPercentage: 25 } });
    const effective = computeEffectiveOffer(candidate, null);

    const diff = computeThreeWayDiff(published, candidate, effective, null, ['offer.discountPercentage']);
    const entry = diff.find((d) => d.field === 'offer.discountPercentage')!;

    expect(entry.publishedValue).toBe(20);
    expect(entry.candidateValue).toBe(25);
    expect(entry.finalValue).toBe(25);
    expect(entry.candidateChanged).toBe(true);
    expect(entry.manuallyOverridden).toBe(false);
  });

  it('detects a manual override distinct from a scraper change', () => {
    const published = makeOffer();
    const candidate = makeOffer(); // scraper produced the same value again
    const override = { 'cardType': 'Platinum' };
    const effective = computeEffectiveOffer(candidate, override);

    const diff = computeThreeWayDiff(published, candidate, effective, override, ['cardType']);
    const entry = diff.find((d) => d.field === 'cardType')!;

    expect(entry.candidateChanged).toBe(false); // scraper value unchanged from published
    expect(entry.manuallyOverridden).toBe(true);
    expect(entry.finalValue).toBe('Platinum');
    expect(entry.candidateValue).toBe(published.cardType);
  });

  it('the final value always comes from the authoritative computeEffectiveOffer merge, not ad-hoc logic', () => {
    const published = makeOffer();
    const candidate = makeOffer({ title: 'New scraped title' });
    const override = { title: 'Admin final title' };
    const effective = computeEffectiveOffer(candidate, override);

    const diff = computeThreeWayDiff(published, candidate, effective, override, ['title']);
    const entry = diff.find((d) => d.field === 'title')!;

    expect(entry.finalValue).toBe(effective.title);
    expect(entry.finalValue).toBe('Admin final title');
  });

  it('has no published value (and no candidateChanged) for a brand-new, never-published offer', () => {
    const candidate = makeOffer();
    const effective = computeEffectiveOffer(candidate, null);
    const diff = computeThreeWayDiff(null, candidate, effective, null, ['title']);
    expect(diff[0].publishedValue).toBeNull();
    expect(diff[0].candidateChanged).toBe(false);
  });

  it('onlyChanged filters out untouched fields', () => {
    const published = makeOffer();
    const candidate = makeOffer({ offer: { ...makeOffer().offer, discountPercentage: 30 } });
    const effective = computeEffectiveOffer(candidate, null);
    const diff = computeThreeWayDiff(published, candidate, effective, null, ['title', 'offer.discountPercentage'], true);
    expect(diff.map((d) => d.field)).toEqual(['offer.discountPercentage']);
  });
});
