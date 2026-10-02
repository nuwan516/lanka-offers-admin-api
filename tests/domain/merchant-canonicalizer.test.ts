import {
  resolveCanonicalMerchant,
  areMerchantAliases,
  getAliasesForCanonical,
} from '@/domain/merchant-canonicalizer';

describe('Merchant Canonicalizer', () => {
  describe('resolveCanonicalMerchant', () => {
    it('resolves exact canonical names', () => {
      const keells = resolveCanonicalMerchant('Keells');
      expect(keells.canonicalName).toBe('Keells');
      expect(keells.isCanonical).toBe(true);

      const pizzaHut = resolveCanonicalMerchant('Pizza Hut');
      expect(pizzaHut.canonicalName).toBe('Pizza Hut');
      expect(pizzaHut.isCanonical).toBe(true);

      const cargills = resolveCanonicalMerchant('Cargills Food City');
      expect(cargills.canonicalName).toBe('Cargills Food City');
      expect(cargills.isCanonical).toBe(true);
    });

    it('resolves verified aliases to canonical identity', () => {
      const keellsSuper = resolveCanonicalMerchant('Keells Super');
      expect(keellsSuper.canonicalName).toBe('Keells');
      expect(keellsSuper.isCanonical).toBe(false);
      expect(keellsSuper.matchedAlias).toBe('Keells Super');

      const pizzaHutJoined = resolveCanonicalMerchant('PizzaHut');
      expect(pizzaHutJoined.canonicalName).toBe('Pizza Hut');

      const glomark = resolveCanonicalMerchant('Glomark');
      expect(glomark.canonicalName).toBe('Softlogic Glomark');

      const sparLk = resolveCanonicalMerchant('SPAR Sri Lanka');
      expect(sparLk.canonicalName).toBe('SPAR Supermarket');

      const abansPlc = resolveCanonicalMerchant('Abans PLC');
      expect(abansPlc.canonicalName).toBe('Abans');

      const cinnamonGrand = resolveCanonicalMerchant('Cinnamon Grand');
      expect(cinnamonGrand.canonicalName).toBe('Cinnamon Grand Colombo');
      expect(cinnamonGrand.isCanonical).toBe(false);
    });

    it('normalizes corporate suffixes and casing gracefully', () => {
      const res = resolveCanonicalMerchant('  SINGER SRI LANKA PLC  ');
      expect(res.canonicalName).toBe('Singer');
    });

    it('does not merge unrelated businesses or invent identities for unknown merchants', () => {
      const unknown = resolveCanonicalMerchant('Random Colombo Boutique');
      expect(unknown.canonicalName).toBeNull();
      expect(unknown.isCanonical).toBe(false);
    });

    it('handles empty or whitespace strings safely', () => {
      expect(resolveCanonicalMerchant('').canonicalName).toBeNull();
      expect(resolveCanonicalMerchant('   ').canonicalName).toBeNull();
    });
  });

  describe('areMerchantAliases', () => {
    it('returns true for known variations of the same merchant', () => {
      expect(areMerchantAliases('Keells', 'Keells Super')).toBe(true);
      expect(areMerchantAliases('Pizza Hut', 'PizzaHut')).toBe(true);
      expect(areMerchantAliases('Glomark', 'Softlogic Glomark Supermarket')).toBe(true);
    });

    it('returns false for distinct merchants', () => {
      expect(areMerchantAliases('Keells', 'Cargills Food City')).toBe(false);
      expect(areMerchantAliases('Pizza Hut', 'Domino\'s Pizza')).toBe(false);
      expect(areMerchantAliases('Singer', 'Abans')).toBe(false);
    });
  });

  describe('getAliasesForCanonical', () => {
    it('returns known aliases list', () => {
      const aliases = getAliasesForCanonical('Keells');
      expect(aliases).toContain('keells super');
      expect(aliases).toContain('keells supermarket');
    });

    it('returns empty array for unknown merchant', () => {
      expect(getAliasesForCanonical('Nonexistent Brand')).toEqual([]);
    });
  });
});
