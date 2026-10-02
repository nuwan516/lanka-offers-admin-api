/**
 * Pure parsing functions for extracting and normalizing branch/location data
 * from bank offer text. Ported from the legacy branch-parser.js with full types.
 */

// ─── Branch list parsers ──────────────────────────────────────────────────────

/**
 * Parse a comma/ampersand-separated outlet list.
 *
 * @example
 * parseOutletList("Participating Outlets: Rajagiriya, Mount Lavinia & HavelockCity Mall", "Jucies")
 * // → ["Jucies, Rajagiriya", "Jucies, Mount Lavinia", "Jucies, HavelockCity Mall"]
 */
export function parseOutletList(text: string, merchantName: string): string[] {
  if (!text) return [];

  let content = text;
  const prefixMatch = text.match(
    /participating\s+(?:outlets?|restaurants?|properties)\s*[-–:]\s*(.+)/i,
  );
  if (prefixMatch) content = prefixMatch[1];

  const raw = content
    .split(/\s*[,&]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  return raw.map((branch) => {
    if (merchantName && !branch.toLowerCase().includes(merchantName.toLowerCase())) {
      return `${merchantName}, ${branch}`;
    }
    return branch;
  });
}

/**
 * Parse an asterisk-delimited branch list.
 *
 * @example
 * parseAsteriskList("* Solar Crab, Pamunugama* The Walden, Nuwara Eliya")
 * // → ["Solar Crab, Pamunugama", "The Walden, Nuwara Eliya"]
 */
export function parseAsteriskList(text: string): string[] {
  if (!text) return [];
  return text
    .split(/\*/)
    .map((s) => s.trim())
    .filter((s) => s && s.length > 3);
}

/**
 * Parse concatenated branch names with no delimiter.
 * Detects uppercase letter immediately following a lowercase letter.
 *
 * @example
 * parseConcatenatedBranches("Solar Crab, PamunugamaThe Walden, Nuwara Eliya")
 * // → ["Solar Crab, Pamunugama", "The Walden, Nuwara Eliya"]
 */
export function parseConcatenatedBranches(text: string): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z])([A-Z])/g, '$1\n$2')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s.length > 3);
}

// ─── City extraction ──────────────────────────────────────────────────────────

export interface ParsedVenueCity {
  name: string;
  city: string;
}

/**
 * Extract city from a venue-city string using a dash separator.
 *
 * @example
 * extractCityFromName("Amaara Sky Hotel - Kandy")
 * // → { name: "Amaara Sky Hotel", city: "Kandy" }
 */
export function extractCityFromName(text: string): ParsedVenueCity | null {
  if (!text) return null;
  const dashMatch = text.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { name: dashMatch[1].trim(), city: dashMatch[2].trim() };
  }
  return null;
}

// ─── Address building ─────────────────────────────────────────────────────────

export interface AddressParts {
  merchantName?: string;
  city?: string | null;
  location?: string | null;
  address?: string | null;
}

/**
 * Build a geocodable address string from available location parts.
 * Returns null if no meaningful address can be built.
 */
export function buildAddress(parts: AddressParts): string | null {
  const { merchantName, city, location, address } = parts;
  const segments: string[] = [];

  if (address?.trim()) {
    segments.push(address.trim());
  } else if (merchantName) {
    segments.push(merchantName.trim());
  }

  if (
    location?.trim() &&
    location !== '.' &&
    !location.startsWith('http') &&
    !/all\s+outlets/i.test(location) &&
    location.toLowerCase() !== (merchantName ?? '').toLowerCase()
  ) {
    segments.push(location.trim());
  }

  if (city?.trim()) {
    const existing = segments.join(' ').toLowerCase();
    if (!existing.includes(city.toLowerCase())) {
      segments.push(city.trim());
    }
  }

  return segments.length > 0 ? segments.join(', ') : null;
}
