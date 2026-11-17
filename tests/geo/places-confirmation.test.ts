import { confirmPlacesApiResponse } from '@/geo/places-confirmation';
import saved from './fixtures/places-cinnamon-grand.json';

describe('Places confirmation from a saved response', () => {
  it('confirms the named Colombo hotel and rejects the wrong place, duplicate, and missing pin', () => {
    const decisions = confirmPlacesApiResponse(saved.textQuery, saved);
    const confirmed = decisions.filter((d) => d.confirmed);

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].placeId).toBe('place-grand');
    expect(confirmed[0].latitude).toBe(6.917);
    expect(confirmed[0].longitude).toBe(79.848);

    const rejected = decisions.filter((d) => !d.confirmed);
    expect(rejected.map((d) => d.placeId)).toEqual([
      'place-lakeside',
      'place-grand',
      'place-india',
      'place-kandy',
      'place-missing',
    ]);
    expect(rejected.every((d) => d.latitude == null && d.longitude == null)).toBe(true);
  });
});
