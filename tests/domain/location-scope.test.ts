import {
  determineLocationScope,
  LocationScope,
} from '@/domain/location-scope';

describe('Location Scope Domain Service', () => {
  it('identifies ONLINE scope from URL, app or web purchase evidence', () => {
    const res = determineLocationScope({
      title: '20% off on Daraz.lk with HNB credit cards',
      description: 'Visit www.daraz.lk or download the mobile app to redeem.',
      location: null,
      merchantName: 'Daraz',
    });
    expect(res.scope).toBe(LocationScope.ONLINE);
    expect(res.isGeocodableToCoordinates).toBe(false);
  });

  it('identifies NATIONWIDE scope for all outlets islandwide', () => {
    const res = determineLocationScope({
      title: 'Enjoy 15% off at all outlets islandwide',
      description: 'Offer valid at all supermarket outlets across Sri Lanka.',
      location: null,
      merchantName: 'Keells',
    });
    expect(res.scope).toBe(LocationScope.NATIONWIDE);
    expect(res.isGeocodableToCoordinates).toBe(false);
  });

  it('identifies SELECTED_OUTLETS and refuses to expand to all branches', () => {
    const res = determineLocationScope({
      title: 'Special discount at selected outlets',
      description: 'Available only at participating merchant outlets. Contact merchant for details.',
      location: 'selected outlets',
      merchantName: 'Pizza Hut',
    });
    expect(res.scope).toBe(LocationScope.SELECTED_OUTLETS);
    expect(res.scope).not.toBe(LocationScope.NATIONWIDE);
    expect(res.scope).not.toBe(LocationScope.EXPLICIT_BRANCH);
    expect(res.isGeocodableToCoordinates).toBe(false);
  });

  it('identifies EXPLICIT_BRANCH when a concrete branch is named', () => {
    const res = determineLocationScope({
      title: 'Valid at Kandy City Centre branch',
      description: 'Level 2, Kandy City Centre, Dalada Veediya, Kandy',
      location: 'Level 2, Kandy City Centre, Kandy',
      merchantName: 'Abans',
    });
    expect(res.scope).toBe(LocationScope.EXPLICIT_BRANCH);
    expect(res.isGeocodableToCoordinates).toBe(true);
  });

  it('identifies MULTIPLE_BRANCHES when several branches are explicitly listed', () => {
    const res = determineLocationScope({
      title: 'Dining discount in Colombo and Kandy',
      description: 'Valid at Colombo 03 branch and Kandy branch.',
      location: null,
      merchantName: 'The Manhattan Fish Market',
    });
    expect(res.scope).toBe(LocationScope.MULTIPLE_BRANCHES);
    expect(res.isGeocodableToCoordinates).toBe(true);
  });

  it('identifies DISTRICT_REGION scope for district-level restrictions', () => {
    const res = determineLocationScope({
      title: 'Exclusive offer for Colombo district',
      description: 'Valid across participating stores in the Colombo district.',
      location: null,
      merchantName: 'Damro',
    });
    expect(res.scope).toBe(LocationScope.DISTRICT_REGION);
    expect(res.region).toBe('Colombo');
    expect(res.isGeocodableToCoordinates).toBe(false);
  });

  it('preserves UNRESOLVED when evidence is insufficient without guessing coordinates', () => {
    const res = determineLocationScope({
      title: 'Enjoy seasonal savings with credit cards',
      description: 'Terms and conditions apply. General card promo.',
      location: null,
      merchantName: 'Promo Partner',
    });
    expect(res.scope).toBe(LocationScope.UNRESOLVED);
  });
});
