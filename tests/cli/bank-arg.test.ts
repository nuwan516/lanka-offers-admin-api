import { parseBankList } from '@/cli/bank-arg';
import { listSupportedBanks } from '@/geo/adapter-registry';

describe('parseBankList', () => {
  it('resolves a single bank', () => {
    expect(parseBankList('hnb')).toEqual(['hnb']);
  });

  it('resolves a comma-separated bank list in order without duplicates', () => {
    expect(parseBankList('boc,hnb,boc')).toEqual(['boc', 'hnb']);
  });

  it('expands all to geocode-capable banks when capability=geocode', () => {
    const banks = parseBankList('all', {
      capability: 'geocode',
      available: listSupportedBanks(),
    });
    expect(banks.length).toBeGreaterThan(1);
    expect(banks).toEqual(expect.arrayContaining(['hnb', 'boc']));
    expect(banks.every((b) => listSupportedBanks().includes(b))).toBe(true);
  });

  it('rejects unknown bank names', () => {
    expect(() => parseBankList('notabank')).toThrow(/Unknown bank/);
  });

  it('keeps single-bank scripts compatible via fallback', () => {
    expect(parseBankList(undefined, { fallback: 'boc' })).toEqual(['boc']);
  });
});
