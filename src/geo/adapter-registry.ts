import { IGeoAdapter } from './adapters/geo-adapter.interface';
import { HNBGeoAdapter } from './adapters/hnb-geo-adapter';
import { SampathGeoAdapter } from './adapters/sampath-geo-adapter';
import { BOCGeoAdapter } from './adapters/boc-geo-adapter';
import { PeoplesGeoAdapter } from './adapters/peoples-geo-adapter';
import { SeylanGeoAdapter } from './adapters/seylan-geo-adapter';
import { NDBGeoAdapter } from './adapters/ndb-geo-adapter';
import { NSBGeoAdapter } from './adapters/nsb-geo-adapter';
import { ComBankGeoAdapter } from './adapters/combank-geo-adapter';
import { listBanksByCapability } from '@/config/banks';

// ─── Registry ─────────────────────────────────────────────────────────────────

const ADAPTERS: Record<string, IGeoAdapter> = {
  hnb: new HNBGeoAdapter(),
  sampath: new SampathGeoAdapter(),
  boc: new BOCGeoAdapter(),
  peoples: new PeoplesGeoAdapter(),
  seylan: new SeylanGeoAdapter(),
  ndb: new NDBGeoAdapter(),
  nsb: new NSBGeoAdapter(),
  combank: new ComBankGeoAdapter(),
};

/**
 * Get the geo adapter for a specific bank.
 * @throws if the bank is not registered.
 */
export function getGeoAdapter(bankName: string): IGeoAdapter {
  const adapter = ADAPTERS[bankName.toLowerCase()];
  if (!adapter) {
    throw new Error(
      `No geo adapter registered for bank: "${bankName}". Available: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return adapter;
}

/** List all registered bank names. */
export function listSupportedBanks(): string[] {
  return listBanksByCapability('geocode').filter((bank) => ADAPTERS[bank]);
}
