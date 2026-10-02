import {
  parseOutletList,
  parseAsteriskList,
  parseConcatenatedBranches,
  extractCityFromName,
  buildAddress,
} from '@/parsing/geo/branch-parser';

describe('parseOutletList()', () => {
  it('splits comma-separated outlets', () => {
    const result = parseOutletList('Rajagiriya, Mount Lavinia, Nugegoda', 'Jucies');
    expect(result).toHaveLength(3);
    expect(result[0]).toContain('Rajagiriya');
  });

  it('splits ampersand-separated outlets', () => {
    const result = parseOutletList('Colombo 03 & Kandy', 'Java Lounge');
    expect(result).toHaveLength(2);
  });

  it('strips "Participating Outlets:" prefix', () => {
    const result = parseOutletList(
      'Participating Outlets: Rajagiriya, Mount Lavinia & Nugegoda',
      'Jucies',
    );
    expect(result.some((r) => r.includes('Rajagiriya'))).toBe(true);
  });

  it('prepends merchant name when branch does not contain it', () => {
    const result = parseOutletList('Colombo 03', 'MyMerchant');
    expect(result[0]).toContain('MyMerchant');
  });

  it('does not duplicate merchant name when already included', () => {
    const result = parseOutletList('MyMerchant Colombo 03', 'MyMerchant');
    expect(result[0]).not.toMatch(/MyMerchant.*MyMerchant/);
  });
});

describe('parseAsteriskList()', () => {
  it('splits asterisk-separated items', () => {
    const result = parseAsteriskList('* Solar Crab, Pamunugama* The Walden, Nuwara Eliya');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('Solar Crab');
    expect(result[1]).toContain('The Walden');
  });

  it('filters short fragments', () => {
    const result = parseAsteriskList('*A*B*Valid Entry, Colombo*');
    expect(result.every((r) => r.length > 3)).toBe(true);
  });
});

describe('parseConcatenatedBranches()', () => {
  it('splits at lowercase→uppercase boundary', () => {
    const result = parseConcatenatedBranches(
      'Solar Crab, PamunugamaThe Walden, Nuwara Eliya',
    );
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toContain('Solar Crab');
  });

  it('handles normal single string with no split needed', () => {
    const result = parseConcatenatedBranches('The Wallawwa, Ja-Ela');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Wallawwa');
  });
});

describe('extractCityFromName()', () => {
  it('extracts city after a dash separator', () => {
    const result = extractCityFromName('Amaara Sky Hotel - Kandy');
    expect(result?.name).toBe('Amaara Sky Hotel');
    expect(result?.city).toBe('Kandy');
  });

  it('returns null when no dash separator', () => {
    const result = extractCityFromName('Hotel Colombo');
    expect(result).toBeNull();
  });

  it('handles em-dash and en-dash', () => {
    expect(extractCityFromName('Hotel A – Galle')?.city).toBe('Galle');
    expect(extractCityFromName('Hotel B — Matara')?.city).toBe('Matara');
  });
});

describe('buildAddress()', () => {
  it('builds from address + city', () => {
    const result = buildAddress({ address: '35 Main St', city: 'Colombo 03' });
    expect(result).toContain('35 Main St');
    expect(result).toContain('Colombo 03');
  });

  it('builds from merchantName + city', () => {
    const result = buildAddress({ merchantName: 'The Wallawwa', city: 'Ja-Ela' });
    expect(result).toContain('The Wallawwa');
    expect(result).toContain('Ja-Ela');
  });

  it('skips "All Outlets" as a location', () => {
    const result = buildAddress({ merchantName: 'SPAR', location: 'All Outlets Island Wide' });
    expect(result).not.toContain('All Outlets');
  });

  it('returns null when nothing useful is provided', () => {
    const result = buildAddress({ merchantName: '', city: null, address: null });
    expect(result).toBeNull();
  });
});
