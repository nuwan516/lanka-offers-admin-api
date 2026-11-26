/**
 * Shared --bank= argument parsing for CLI tools.
 *
 * Accepts:
 *   --bank=hnb
 *   --bank=all
 *   --bank=hnb,boc,sampath
 *
 * Single-bank npm scripts (geo:hnb, llm:revalidate:boc) keep working unchanged.
 */
import { type BankCapability, type BankName, isBankName, listBanks, listBanksByCapability } from '@/config/banks';

export function parseBankList(
  raw: string | undefined,
  options: {
    /** When set, `all` expands to banks with this capability. */
    capability?: BankCapability;
    /** Explicit allow-list (e.g. geo adapters). Defaults to all known banks. */
    available?: readonly string[];
    fallback?: string;
  } = {}
): string[] {
  const available = (options.available ?? listBanks()).map((b) => b.toLowerCase());
  const availableSet = new Set(available);
  const value = (raw ?? options.fallback ?? 'hnb').trim().toLowerCase();

  if (!value) {
    throw new Error(`Empty --bank value. Use a bank name, a comma list, or all.`);
  }

  if (value === 'all') {
    if (options.capability) {
      return listBanksByCapability(options.capability).filter((b) => availableSet.has(b));
    }
    return [...available];
  }

  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid --bank=${raw}. Use a bank name, a comma list, or all.`);
  }

  const unknown = parts.filter((p) => !availableSet.has(p) && !isBankName(p));
  const unsupported = parts.filter((p) => isBankName(p) && !availableSet.has(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown bank(s): ${unknown.join(', ')}. Available: ${available.join(', ')} or all`
    );
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Bank(s) not supported for this command: ${unsupported.join(', ')}. Available: ${available.join(', ')}`
    );
  }

  // Preserve order, drop duplicates.
  return [...new Set(parts)];
}

export function resolveBankArgFromArgv(
  argv: string[] = process.argv.slice(2),
  options?: Parameters<typeof parseBankList>[1]
): string[] {
  const hit = argv.find((a) => a.startsWith('--bank='));
  const raw = hit ? hit.slice('--bank='.length) : options?.fallback;
  return parseBankList(raw, options);
}

export type { BankName };
