import { DFCCGeoAdapter } from '@/geo/adapters/dfcc-geo-adapter';
import { PABCGeoAdapter } from '@/geo/adapters/pabc-geo-adapter';
import { Offer } from '@/core/types/offers';

function offer(category: string, addresses: string[]): Offer {
  return {
    uniqueId: 'x',
    category,
    merchant: {
      name: 'Spa Ceylon',
      location: null,
      addresses,
      phone: [],
      email: [],
      website: null,
      logo: null,
    },
    offer: { description: '' },
  } as unknown as Offer;
}

describe('online category keeps a real street address', () => {
  it.each([
    ['dfcc', new DFCCGeoAdapter()],
    ['pabc', new PABCGeoAdapter()],
  ])('%s does not drop No. 15, Flower Road when the category says Online', (_bank, adapter) => {
    const data = adapter.extractLocationData(
      offer('Online', ['No. 15, Flower Road, Colombo 07']),
    );
    expect(data.addresses).toEqual(['Spa Ceylon, No. 15, Flower Road, Colombo 07']);
  });
});
