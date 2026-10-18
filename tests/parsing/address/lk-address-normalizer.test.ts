import { normalizeSriLankanAddress } from '@/parsing/address/lk-address-normalizer';
import {
  findColomboPostalZone,
  findCommercialHub,
  COLOMBO_POSTAL_ZONES,
  SRI_LANKA_DISTRICTS,
} from '@/core/constants/sri-lanka-geo-catalog';

describe('Sri Lankan Address Normalizer & Geo Catalog', () => {
  describe('Catalog Invariants', () => {
    it('contains all 25 administrative districts of Sri Lanka with trilingual names', () => {
      expect(SRI_LANKA_DISTRICTS).toHaveLength(25);
      for (const d of SRI_LANKA_DISTRICTS) {
        expect(d.name).toBeTruthy();
        expect(d.province).toBeTruthy();
        expect(d.capital).toBeTruthy();
        expect(d.sinhala).toBeTruthy();
        expect(d.tamil).toBeTruthy();
      }
    });

    it('contains all 15 Colombo postal zones (Colombo 01 to 15)', () => {
      expect(COLOMBO_POSTAL_ZONES).toHaveLength(15);
      const zoneIds = COLOMBO_POSTAL_ZONES.map((z) => z.zone);
      for (let i = 1; i <= 15; i++) {
        const padded = `Colombo ${String(i).padStart(2, '0')}`;
        expect(zoneIds).toContain(padded);
      }
    });
  });

  describe('Colombo Postal Zone Disambiguation', () => {
    it('resolves "Colombo 03", "Colombo 3", "Kollupitiya", and "Kolpetty" to the same zone', () => {
      const z1 = findColomboPostalZone('Colombo 03');
      const z2 = findColomboPostalZone('Colombo 3');
      const z3 = findColomboPostalZone('Kollupitiya');
      const z4 = findColomboPostalZone('Kolpetty');

      expect(z1).not.toBeNull();
      expect(z1?.zone).toBe('Colombo 03');
      expect(z2?.zone).toBe('Colombo 03');
      expect(z3?.zone).toBe('Colombo 03');
      expect(z4?.zone).toBe('Colombo 03');
      expect(z1?.primaryName).toBe('Kollupitiya');
    });

    it('resolves Bambalapitiya to Colombo 04', () => {
      const z = findColomboPostalZone('Bambalapitiya');
      expect(z?.zone).toBe('Colombo 04');
      expect(z?.primaryName).toBe('Bambalapitiya');
    });

    it('resolves Cinnamon Gardens to Colombo 07', () => {
      const z = findColomboPostalZone('Cinnamon Gardens');
      expect(z?.zone).toBe('Colombo 07');
    });
  });

  describe('Commercial Hubs & Multi-branch Disambiguation', () => {
    it('identifies Nugegoda and Nugegoda Junction without merging distinct locations', () => {
      const resNormal = normalizeSriLankanAddress('Nugegoda');
      expect(resNormal.city).toBe('Nugegoda');
      expect(resNormal.district).toBe('Colombo');
      expect(resNormal.isJunction).toBe(false);
      expect(resNormal.precision).toBe('APPROXIMATE_CITY');

      const resJct = normalizeSriLankanAddress('Nugegoda Junction');
      expect(resJct.city).toBe('Nugegoda');
      expect(resJct.isJunction).toBe(true);
    });

    it('distinguishes Kandy, Peradeniya, and Katugastota within Kandy district', () => {
      const kandy = normalizeSriLankanAddress('Kandy');
      const peradeniya = normalizeSriLankanAddress('Peradeniya');
      const katugastota = normalizeSriLankanAddress('Katugastota');

      expect(kandy.district).toBe('Kandy');
      expect(kandy.city).toBe('Kandy');

      expect(peradeniya.district).toBe('Kandy');
      expect(peradeniya.city).toBe('Peradeniya');

      expect(katugastota.district).toBe('Kandy');
      expect(katugastota.city).toBe('Katugastota');
    });
  });

  describe('Road and Street Name Expansions', () => {
    it('expands Rd, Mw, St, Jct to full words', () => {
      const res = normalizeSriLankanAddress('No. 120, Galle Rd, Colombo 03');
      expect(res.normalizedAddress).toContain('Galle Road');
      expect(res.precision).toBe('EXACT_BRANCH');
      expect(res.postalZone).toBe('Colombo 03');
      expect(res.district).toBe('Colombo');
    });

    it('expands Mawatha from mw', () => {
      const res = normalizeSriLankanAddress('No 45, Dharmapala Mw, Colombo 07');
      expect(res.normalizedAddress).toContain('Dharmapala Mawatha');
      expect(res.precision).toBe('EXACT_BRANCH');
    });
  });

  describe('Geographic Precision Classification', () => {
    it('classifies addresses with house/lot/building numbers as EXACT_BRANCH', () => {
      const res1 = normalizeSriLankanAddress('No 5, Galle Road, Colombo 03');
      expect(res1.precision).toBe('EXACT_BRANCH');
      expect(res1.confidence).toBeGreaterThanOrEqual(0.9);

      const res2 = normalizeSriLankanAddress('45/2, Peradeniya Road, Kandy');
      expect(res2.precision).toBe('EXACT_BRANCH');
      expect(res2.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('classifies premier shopping malls as EXACT_BRANCH with landmark identified', () => {
      const res1 = normalizeSriLankanAddress('One Galle Face Mall, Level 3, Colombo');
      expect(res1.precision).toBe('EXACT_BRANCH');
      expect(res1.landmarkOrMall).toBe('One Galle Face');

      const res2 = normalizeSriLankanAddress('Colombo City Centre, Food Studio');
      expect(res2.precision).toBe('EXACT_BRANCH');
      expect(res2.landmarkOrMall).toBe('Colombo City Centre');
    });

    it('classifies bare city or postal zone without street address as APPROXIMATE_CITY', () => {
      const res = normalizeSriLankanAddress('Kollupitiya');
      expect(res.precision).toBe('APPROXIMATE_CITY');
      expect(res.city).toBe('Kollupitiya');
      expect(res.postalZone).toBe('Colombo 03');
    });

    it('classifies bare district as DISTRICT', () => {
      const res = normalizeSriLankanAddress('Galle District');
      expect(res.precision).toBe('DISTRICT');
      expect(res.district).toBe('Galle');
    });

    it('classifies empty or unresolvable strings as UNRESOLVED', () => {
      const empty = normalizeSriLankanAddress('');
      expect(empty.precision).toBe('UNRESOLVED');
      expect(empty.confidence).toBe(0);

      const unresolvable = normalizeSriLankanAddress('Random Nonsense XYZ 9999');
      expect(unresolvable.precision).toBe('UNRESOLVED');
    });
  });

  describe('Sinhala and Tamil Place Name Support', () => {
    it('resolves Sinhala district names', () => {
      const sinhalaKandy = normalizeSriLankanAddress('මහනුවර');
      expect(sinhalaKandy.district).toBe('Kandy');

      const sinhalaColombo = normalizeSriLankanAddress('කොළඹ');
      expect(sinhalaColombo.district).toBe('Colombo');
    });

    it('resolves Tamil district names', () => {
      const tamilJaffna = normalizeSriLankanAddress('யாழ்ப்பாணம்');
      expect(tamilJaffna.district).toBe('Jaffna');

      const tamilKandy = normalizeSriLankanAddress('கண்டி');
      expect(tamilKandy.district).toBe('Kandy');
    });
  });
});
