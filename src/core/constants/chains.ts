import { ChainConfig } from '@/core/types/geo';

// ─── Known Sri Lankan Chain Merchants ────────────────────────────────────────
//
// Maps lowercase merchant name substrings → { query, type }.
// When a merchant name contains any key (case-insensitive), the classifier
// treats it as a CHAIN and uses the Places Text Search API to find all branches.
//
// query: exact string passed to Places "textQuery" field
// type:  Google Places type hint (informational only)

export const KNOWN_CHAINS: Readonly<Record<string, ChainConfig>> = {
  // ── Supermarkets ───────────────────────────────────────────────────────────
  'spar': { query: 'SPAR supermarket Sri Lanka', type: 'supermarket' },
  'keells': { query: 'Keells Food City Sri Lanka', type: 'supermarket' },
  'cargills': { query: 'Cargills Food City Sri Lanka', type: 'supermarket' },
  'arpico': { query: 'Arpico Supercenter Sri Lanka', type: 'supermarket' },
  'lanka sathosa': { query: 'Lanka Sathosa Sri Lanka', type: 'supermarket' },
  'laugfs': { query: 'LAUGFS Supermarket Sri Lanka', type: 'supermarket' },
  'glomark': { query: 'Glomark supermarket Sri Lanka', type: 'supermarket' },
  'no limit': { query: 'No Limit supermarket Sri Lanka', type: 'supermarket' },
  'mini stop': { query: 'Mini Stop convenience store Sri Lanka', type: 'supermarket' },

  // ── Fast Food / Restaurants ────────────────────────────────────────────────
  'subway': { query: 'Subway restaurant Sri Lanka', type: 'restaurant' },
  'burger king': { query: 'Burger King Sri Lanka', type: 'restaurant' },
  'kfc': { query: 'KFC Sri Lanka', type: 'restaurant' },
  'pizza hut': { query: 'Pizza Hut Sri Lanka', type: 'restaurant' },
  'popeyes': { query: 'Popeyes Sri Lanka', type: 'restaurant' },
  'baskin robbins': { query: 'Baskin Robbins Sri Lanka', type: 'restaurant' },
  'delifrance': { query: 'Delifrance Sri Lanka', type: 'restaurant' },
  'crystal jade': { query: 'Crystal Jade restaurant Sri Lanka', type: 'restaurant' },
  'the coffee bean': { query: 'The Coffee Bean Tea Leaf Sri Lanka', type: 'cafe' },
  'coffee bean': { query: 'The Coffee Bean Tea Leaf Sri Lanka', type: 'cafe' },
  'barista': { query: 'Barista coffee Sri Lanka', type: 'cafe' },
  'starbucks': { query: 'Starbucks Sri Lanka', type: 'cafe' },
  'mcdonalds': { query: "McDonald's Sri Lanka", type: 'restaurant' },
  "mcdonald's": { query: "McDonald's Sri Lanka", type: 'restaurant' },
  'domini': { query: "Domino's Pizza Sri Lanka", type: 'restaurant' },
  'dominos': { query: "Domino's Pizza Sri Lanka", type: 'restaurant' },
  'chinese dragon': { query: 'Chinese Dragon Cafe Sri Lanka', type: 'restaurant' },
  'cbb': { query: 'Colombo Burger Bar Sri Lanka', type: 'restaurant' },
  'the fab': { query: 'The Fab Restaurant Sri Lanka', type: 'restaurant' },
  'palmyra': { query: 'Palmyra Restaurant Sri Lanka', type: 'restaurant' },

  // ── Fashion / Clothing ─────────────────────────────────────────────────────
  'stripes & checks': { query: 'Stripes and Checks Sri Lanka', type: 'clothing_store' },
  'stripes and checks': { query: 'Stripes and Checks Sri Lanka', type: 'clothing_store' },
  'cotton collection': { query: 'Cotton Collection Sri Lanka', type: 'clothing_store' },
  'fashion bug': { query: 'Fashion Bug Sri Lanka', type: 'clothing_store' },
  'odel': { query: 'ODEL department store Sri Lanka', type: 'clothing_store' },
  'cool planet': { query: 'Cool Planet clothing Sri Lanka', type: 'clothing_store' },
  'the factory': { query: 'The Factory outlet Sri Lanka', type: 'clothing_store' },
  'nolimit': { query: 'No Limit fashion Sri Lanka', type: 'clothing_store' },
  'levi': { query: "Levi's store Sri Lanka", type: 'clothing_store' },

  // ── Jewellery ──────────────────────────────────────────────────────────────
  'raja jewellers': { query: 'Raja Jewellers Sri Lanka', type: 'jewelry_store' },
  'vogue jewellers': { query: 'Vogue Jewellers Sri Lanka', type: 'jewelry_store' },
  'mincing jewellers': { query: 'Mincing Jewellers Sri Lanka', type: 'jewelry_store' },
  'swarna mahal': { query: 'Swarna Mahal jewellers Sri Lanka', type: 'jewelry_store' },
  'colombo jewellers': { query: 'Colombo Jewellers Sri Lanka', type: 'jewelry_store' },

  // ── Electronics ───────────────────────────────────────────────────────────
  'singer': { query: 'Singer showroom Sri Lanka', type: 'electronics_store' },
  'softlogic': { query: 'Softlogic showroom Sri Lanka', type: 'electronics_store' },
  'abans': { query: 'Abans showroom Sri Lanka', type: 'electronics_store' },
  'damro': { query: 'Damro furniture electronics Sri Lanka', type: 'electronics_store' },
  'istore': { query: 'iStore Apple Sri Lanka', type: 'electronics_store' },
  'digital life': { query: 'Digital Life electronics Sri Lanka', type: 'electronics_store' },
  'samsung': { query: 'Samsung Experience Store Sri Lanka', type: 'electronics_store' },

  // ── Hotels / Resorts ──────────────────────────────────────────────────────
  'cinnamon': { query: 'Cinnamon Hotels Sri Lanka', type: 'lodging' },
  'araliya': { query: 'Araliya Hotels Sri Lanka', type: 'lodging' },
  'centauria': { query: 'Centauria Hotels Sri Lanka', type: 'lodging' },
  'amagi': { query: 'Amagi Hotels Sri Lanka', type: 'lodging' },
  'amaara': { query: 'Amaara Hotels Sri Lanka', type: 'lodging' },
  'jetwing': { query: 'Jetwing Hotels Sri Lanka', type: 'lodging' },
  'aitken spence': { query: 'Aitken Spence Hotels Sri Lanka', type: 'lodging' },
  'john keells': { query: 'John Keells Hotels Sri Lanka', type: 'lodging' },
  'hemas': { query: 'Hemas Hotels Sri Lanka', type: 'lodging' },
  'paradise road': { query: 'Paradise Road Tintagel Colombo', type: 'lodging' },
  'heritance': { query: 'Heritance Hotels Sri Lanka', type: 'lodging' },
  'anantara': { query: 'Anantara Hotels Sri Lanka', type: 'lodging' },

  // ── Fuel Stations ─────────────────────────────────────────────────────────
  'ceypetco': { query: 'CEYPETCO filling station Sri Lanka', type: 'gas_station' },
  'ioc': { query: 'Lanka IOC filling station Sri Lanka', type: 'gas_station' },
  'lanka ioc': { query: 'Lanka IOC filling station Sri Lanka', type: 'gas_station' },

  // ── Pharmacy / Health ──────────────────────────────────────────────────────
  'healthguard': { query: 'Healthguard pharmacy Sri Lanka', type: 'pharmacy' },
  'osusala': { query: 'Osusala pharmacy Sri Lanka', type: 'pharmacy' },
  'osu sala': { query: 'Osusala pharmacy Sri Lanka', type: 'pharmacy' },
  'medicare': { query: 'Medicare pharmacy Sri Lanka', type: 'pharmacy' },
  'nawaloka': { query: 'Nawaloka hospital Sri Lanka', type: 'hospital' },
  'asiri': { query: 'Asiri hospital Sri Lanka', type: 'hospital' },
  'durdans': { query: 'Durdans hospital Colombo', type: 'hospital' },
  'lanka hospitals': { query: 'Lanka Hospitals Colombo', type: 'hospital' },

  // ── Telecom / Mobile ──────────────────────────────────────────────────────
  'dialog': { query: 'Dialog showroom Sri Lanka', type: 'store' },
  'mobitel': { query: 'Mobitel showroom Sri Lanka', type: 'store' },
  'hutch': { query: 'Hutch store Sri Lanka', type: 'store' },
  'airtel': { query: 'Airtel store Sri Lanka', type: 'store' },
  'slt': { query: 'SLT Mobitel store Sri Lanka', type: 'store' },

  // ── Education / Services ───────────────────────────────────────────────────
  'british council': { query: 'British Council Sri Lanka', type: 'school' },
  'pearson': { query: 'Pearson education Sri Lanka', type: 'school' },
  'nsbm': { query: 'NSBM Green University Sri Lanka', type: 'university' },

  // ── Travel / Transport ─────────────────────────────────────────────────────
  'srilankan airlines': { query: 'SriLankan Airlines office Sri Lanka', type: 'travel_agency' },
  'mihin': { query: 'Mihin Lanka Sri Lanka', type: 'travel_agency' },
  'malkey': { query: 'Malkey tours Sri Lanka', type: 'travel_agency' },
  'jetwing travels': { query: 'Jetwing Travels Sri Lanka', type: 'travel_agency' },

  // ── Automotive ────────────────────────────────────────────────────────────
  'laugfs gas': { query: 'LAUGFS Gas Sri Lanka', type: 'gas_station' },
  'uni motors': { query: 'Uni Motors Sri Lanka', type: 'car_dealer' },
  'dimo': { query: 'DIMO showroom Sri Lanka', type: 'car_dealer' },
  'toyota': { query: 'Toyota showroom Sri Lanka', type: 'car_dealer' },
  'honda': { query: 'Honda showroom Sri Lanka', type: 'car_dealer' },
} as const;

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Match a merchant name against the known-chains dictionary.
 * Returns the matching ChainConfig (with the matched key) or null.
 */
export function matchChain(
  merchantName: string,
): (ChainConfig & { key: string }) | null {
  if (!merchantName) return null;

  const normalized = merchantName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s&]/g, ' ')
    .replace(/\s+/g, ' ');

  for (const [key, config] of Object.entries(KNOWN_CHAINS)) {
    if (normalized.includes(key) || normalized === key) {
      return { key, ...config };
    }
  }
  return null;
}
