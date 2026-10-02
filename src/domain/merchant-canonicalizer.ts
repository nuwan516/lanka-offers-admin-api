/**
 * Canonical Merchant Identity & Alias Resolver for Lanka Offers.
 *
 * Guarantees:
 * - Never merge distinct businesses simply because strings share tokens.
 * - Associating source variations with a canonical merchant identity ONLY when genuinely established.
 * - Preserves the original raw source merchant name in all cases.
 */

import { normalizeMerchantName, normalizeWhitespace } from '@/parsing/normalization/offer-normalizer';

export interface CanonicalMerchantEntry {
  canonicalName: string;
  category: string;
  aliases: string[];
  website?: string;
  notes?: string;
}

export interface CanonicalResolutionResult {
  canonicalName: string | null;
  originalName: string;
  isCanonical: boolean;
  matchedAlias?: string | null;
  category?: string;
}

/**
 * Verified canonical merchant registry for Sri Lanka.
 * Only merchants with unambiguous identity and clear source variations are cataloged here.
 */
export const CANONICAL_MERCHANT_CATALOG: readonly CanonicalMerchantEntry[] = [
  {
    canonicalName: 'Keells',
    category: 'Supermarket',
    aliases: [
      'keells super',
      'keells supermarket',
      'keells supermarkets',
      'keells food city',
      'john keells supermarkets',
      'keells outlets',
    ],
    website: 'https://keells.com',
  },
  {
    canonicalName: 'Cargills Food City',
    category: 'Supermarket',
    aliases: [
      'cargills',
      'food city',
      'cargills foodcity',
      'cargills food city supermarket',
      'cargills outlets',
    ],
    website: 'https://cargillsceylon.com',
  },
  {
    canonicalName: 'Softlogic Glomark',
    category: 'Supermarket',
    aliases: [
      'glomark',
      'softlogic glomark supermarket',
      'glomark - softlogic supermarkets',
      'glomark supermarkets',
      'softlogic supermarket',
      'softlogic supermarkets',
      'www.glomark.lk',
    ],
    website: 'https://glomark.lk',
  },
  {
    canonicalName: 'Arpico Supercentre',
    category: 'Supermarket',
    aliases: [
      'arpico',
      'arpico supercenter',
      'arpico super center',
      'richard pieris arpico',
      'arpico outlets',
    ],
    website: 'https://arpico.com',
  },
  {
    canonicalName: 'SPAR Supermarket',
    category: 'Supermarket',
    aliases: [
      'spar',
      'spar sri lanka',
      'spar supermarkets',
    ],
    website: 'https://spar.lk',
  },
  {
    canonicalName: 'Laugfs Supermarket',
    category: 'Supermarket',
    aliases: [
      'laugfs',
      'laugfs super',
      'laugfs supermarkets',
    ],
    website: 'https://laugfs.lk',
  },
  {
    canonicalName: 'Pizza Hut',
    category: 'Dining',
    aliases: [
      'pizzahut',
      'pizza hut lanka',
      'pizza hut sri lanka',
      'pizza hut delivery',
    ],
    website: 'https://pizzahut.lk',
  },
  {
    canonicalName: 'Burger King',
    category: 'Dining',
    aliases: [
      'bk',
      'burger king lanka',
      'burger king sri lanka',
      'burger king outlets',
    ],
    website: 'https://burgerking.lk',
  },
  {
    canonicalName: 'KFC',
    category: 'Dining',
    aliases: [
      'kentucky fried chicken',
      'kfc lanka',
      'kfc sri lanka',
      'kfc outlets',
    ],
    website: 'https://kfclanka.com',
  },
  {
    canonicalName: "McDonald's",
    category: 'Dining',
    aliases: [
      'mcdonalds',
      'mcdonalds sri lanka',
      "mcdonald's sri lanka",
    ],
    website: 'https://mcdelivery.lk',
  },
  {
    canonicalName: "Domino's Pizza",
    category: 'Dining',
    aliases: [
      'dominos',
      'domino',
      "domino's",
      'dominos pizza',
    ],
    website: 'https://dominos.lk',
  },
  {
    canonicalName: 'Subway',
    category: 'Dining',
    aliases: ['subway sri lanka', 'subway restaurant'],
  },
  {
    canonicalName: 'Barista',
    category: 'Cafe',
    aliases: ['barista coffee', 'barista sri lanka', 'barista outlets'],
  },
  {
    canonicalName: 'Abans',
    category: 'Electronics',
    aliases: [
      'abans plc',
      'abans showrooms',
      'buyabans',
      'buyabans.com',
      'abans & buyabans.com',
    ],
    website: 'https://buyabans.com',
  },
  {
    canonicalName: 'Singer',
    category: 'Electronics',
    aliases: [
      'singer sri lanka',
      'singer showroom',
      'singer showrooms',
      'singer mega',
      'singer.lk',
      'singer showroom & singer.lk',
    ],
    website: 'https://singer.lk',
  },
  {
    canonicalName: 'Damro',
    category: 'Furniture & Electronics',
    aliases: [
      'damro sri lanka',
      'damro showrooms',
      'damro showroom',
    ],
    website: 'https://damro.lk',
  },
  {
    canonicalName: 'Daraz',
    category: 'Online Shopping',
    aliases: [
      'daraz.lk',
      'daraz lanka',
      'daraz online shopping',
      'www.daraz.lk',
    ],
    website: 'https://daraz.lk',
  },
  {
    canonicalName: 'PickMe',
    category: 'Transport & Delivery',
    aliases: [
      'pickme lanka',
      'pickme food',
      'pickme ride',
      'pickme events',
    ],
    website: 'https://pickme.lk',
  },
  {
    canonicalName: 'Uber',
    category: 'Transport & Delivery',
    aliases: [
      'uber eats',
      'uber sri lanka',
      'uber rides',
    ],
  },
  {
    canonicalName: 'Tiesh',
    category: 'Jewellery',
    aliases: [
      'tiesh jewellers',
      'tiesh jewellery',
      'tiesh colombo',
    ],
  },
  {
    canonicalName: 'Vogue Jewellers',
    category: 'Jewellery',
    aliases: [
      'vogue jeweller',
      'vogue jewellery',
    ],
  },
  {
    canonicalName: 'Raja Jewellers',
    category: 'Jewellery',
    aliases: [
      'raja jeweller',
      'raja jewellery',
    ],
  },
  {
    canonicalName: 'Swarna Mahal',
    category: 'Jewellery',
    aliases: [
      'swarna mahal jewellers',
      'swarnamahal',
    ],
  },
  {
    canonicalName: 'Spring & Summer',
    category: 'Clothing',
    aliases: [
      'spring and summer',
      'spring & summer fashion',
    ],
  },
  {
    canonicalName: 'Odel',
    category: 'Clothing',
    aliases: [
      'odel department store',
      'odel lanka',
      'odel plc',
    ],
  },
  {
    canonicalName: 'Nolimit',
    category: 'Clothing',
    aliases: [
      'no limit',
      'nolimit fashion',
      'no limit clothing',
    ],
  },
  {
    canonicalName: 'Cotton Collection',
    category: 'Clothing',
    aliases: [
      'cotton collection sri lanka',
    ],
  },
  {
    canonicalName: 'Fashion Bug',
    category: 'Clothing',
    aliases: [
      'fashion bug sri lanka',
      'fashion bug outlets',
    ],
  },
  {
    canonicalName: 'Cool Planet',
    category: 'Clothing',
    aliases: [
      'cool planet clothing',
      'cool planet outlets',
    ],
  },
  {
    canonicalName: 'DSI',
    category: 'Footwear',
    aliases: [
      'dsi premier',
      'dsi showrooms',
      'dsifootcandy.lk',
      'www.dsifootcandy.lk',
    ],
  },
  {
    canonicalName: 'Kapruka',
    category: 'Online Shopping',
    aliases: [
      'kapruka.com',
      'www.kapruka.com',
    ],
    website: 'https://kapruka.com',
  },
  {
    canonicalName: 'National Savings Bank',
    category: 'Bank Facility',
    aliases: [
      'nsb',
    ],
  },
  // ── Specific Hotel Properties (Preserved as distinct entities) ──────────────
  {
    canonicalName: 'Cinnamon Grand Colombo',
    category: 'Hotels',
    aliases: ['cinnamon grand', 'cinnamon grand hotel'],
  },
  {
    canonicalName: 'Cinnamon Lakeside Colombo',
    category: 'Hotels',
    aliases: ['cinnamon lakeside', 'cinnamon lakeside hotel'],
  },
  {
    canonicalName: 'Cinnamon Red Colombo',
    category: 'Hotels',
    aliases: ['cinnamon red', 'cinnamon red hotel'],
  },
  {
    canonicalName: 'Hilton Colombo',
    category: 'Hotels',
    aliases: ['hilton hotel colombo', 'hilton colombo residence'],
  },
];

// Precompute index maps for fast lookup
const aliasToCanonical = new Map<string, CanonicalMerchantEntry>();
for (const entry of CANONICAL_MERCHANT_CATALOG) {
  const normCanonical = normalizeMerchantForIndex(entry.canonicalName);
  aliasToCanonical.set(normCanonical, entry);
  for (const alias of entry.aliases) {
    aliasToCanonical.set(normalizeMerchantForIndex(alias), entry);
  }
}

function normalizeMerchantForIndex(name: string): string {
  return normalizeWhitespace(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a merchant string to its canonical identity if an unambiguous mapping exists.
 * Preserves the original string when no canonical entry is established.
 */
export function resolveCanonicalMerchant(rawName: string | null | undefined): CanonicalResolutionResult {
  const original = (rawName ?? '').trim();
  if (!original) {
    return {
      canonicalName: null,
      originalName: '',
      isCanonical: false,
    };
  }

  // 1. Direct normalizer
  const normalized = normalizeMerchantName(original);
  const indexKey = normalizeMerchantForIndex(normalized);

  const matched = aliasToCanonical.get(indexKey);
  if (matched) {
    return {
      canonicalName: matched.canonicalName,
      originalName: original,
      isCanonical: matched.canonicalName.toLowerCase() === original.toLowerCase(),
      matchedAlias: original,
      category: matched.category,
    };
  }

  // 2. Fallback check without punctuation / legal suffixes
  const strippedKey = normalizeMerchantForIndex(original);
  const matchedStripped = aliasToCanonical.get(strippedKey);
  if (matchedStripped) {
    return {
      canonicalName: matchedStripped.canonicalName,
      originalName: original,
      isCanonical: matchedStripped.canonicalName.toLowerCase() === original.toLowerCase(),
      matchedAlias: original,
      category: matchedStripped.category,
    };
  }

  // Unmatched: no canonical merchant identity established
  return {
    canonicalName: null,
    originalName: original,
    isCanonical: false,
  };
}

/**
 * Checks whether two merchant names represent aliases of the same canonical business.
 */
export function areMerchantAliases(nameA: string | null | undefined, nameB: string | null | undefined): boolean {
  if (!nameA || !nameB) return false;
  const resA = resolveCanonicalMerchant(nameA);
  const resB = resolveCanonicalMerchant(nameB);
  if (resA.canonicalName && resB.canonicalName) {
    return resA.canonicalName.toLowerCase() === resB.canonicalName.toLowerCase();
  }
  return false;
}

/**
 * Return all known aliases for a given canonical merchant.
 */
export function getAliasesForCanonical(canonicalName: string): string[] {
  const entry = CANONICAL_MERCHANT_CATALOG.find(
    (c) => c.canonicalName.toLowerCase() === canonicalName.toLowerCase(),
  );
  return entry ? [...entry.aliases] : [];
}
