/**
 * Lanka Offers — Evidence-backed Sri Lanka Geospatial Administrative Catalog
 *
 * Contains canonical definitions for:
 * - 25 Administrative Districts (with Sinhala, Tamil, and English representations).
 * - 15 Municipal Postal Zones of Colombo (Colombo 01 to 15, matching colloquial & historical names).
 * - Primary commercial hubs, major suburban junctions, and key retail malls.
 */

export interface DistrictInfo {
  name: string;
  province: string;
  sinhala: string;
  tamil: string;
  capital: string;
}

export interface ColomboPostalZone {
  zone: string; // e.g. "Colombo 03"
  zoneNumber: number; // e.g. 3
  primaryName: string; // e.g. "Kollupitiya"
  aliases: string[]; // e.g. ["kollupitiya", "colpetty", "kolpetty"]
  district: 'Colombo';
}

export interface LocationEntry {
  canonicalName: string;
  district: string;
  province: string;
  aliases: string[];
  isJunction?: boolean;
  isMall?: boolean;
}

/** 25 Administrative Districts of Sri Lanka */
export const SRI_LANKA_DISTRICTS: readonly DistrictInfo[] = [
  { name: 'Colombo', province: 'Western', sinhala: 'කොළඹ', tamil: 'கொழும்பு', capital: 'Colombo' },
  { name: 'Gampaha', province: 'Western', sinhala: 'ගම්පහ', tamil: 'கம்பஹா', capital: 'Gampaha' },
  { name: 'Kalutara', province: 'Western', sinhala: 'කළුතර', tamil: 'களுத்துறை', capital: 'Kalutara' },
  { name: 'Kandy', province: 'Central', sinhala: 'මහනුවර', tamil: 'கண்டி', capital: 'Kandy' },
  { name: 'Matale', province: 'Central', sinhala: 'මාතලේ', tamil: 'மாத்தளை', capital: 'Matale' },
  { name: 'Nuwara Eliya', province: 'Central', sinhala: 'නුවරඑළිය', tamil: 'நுவரெலியா', capital: 'Nuwara Eliya' },
  { name: 'Galle', province: 'Southern', sinhala: 'ගාල්ල', tamil: 'காலி', capital: 'Galle' },
  { name: 'Matara', province: 'Southern', sinhala: 'මාතර', tamil: 'மாத்தறை', capital: 'Matara' },
  { name: 'Hambantota', province: 'Southern', sinhala: 'හම්බන්තොට', tamil: 'அம்பாந்தோட்டை', capital: 'Hambantota' },
  { name: 'Jaffna', province: 'Northern', sinhala: 'යාපනය', tamil: 'யாழ்ப்பாணம்', capital: 'Jaffna' },
  { name: 'Kilinochchi', province: 'Northern', sinhala: 'කිලිනොච්චිය', tamil: 'கிளிநொச்சி', capital: 'Kilinochchi' },
  { name: 'Mannar', province: 'Northern', sinhala: 'මන්නාරම', tamil: 'மன்னார்', capital: 'Mannar' },
  { name: 'Vavuniya', province: 'Northern', sinhala: 'වවුනියාව', tamil: 'வவுனியா', capital: 'Vavuniya' },
  { name: 'Mullaitivu', province: 'Northern', sinhala: 'මුලතිව්', tamil: 'முல்லைத்தீவு', capital: 'Mullaitivu' },
  { name: 'Batticaloa', province: 'Eastern', sinhala: 'මඩකලපුව', tamil: 'மட்டக்களப்பு', capital: 'Batticaloa' },
  { name: 'Ampara', province: 'Eastern', sinhala: 'අම්පාර', tamil: 'அம்பாறை', capital: 'Ampara' },
  { name: 'Trincomalee', province: 'Eastern', sinhala: 'ත්‍රිකුණාමලය', tamil: 'திருகோணமலை', capital: 'Trincomalee' },
  { name: 'Kurunegala', province: 'North Western', sinhala: 'කුරුණෑගල', tamil: 'குருணாகல்', capital: 'Kurunegala' },
  { name: 'Puttalam', province: 'North Western', sinhala: 'පුත්තලම', tamil: 'புத்தளம்', capital: 'Puttalam' },
  { name: 'Anuradhapura', province: 'North Central', sinhala: 'අනුරාධපුරය', tamil: 'அனுராதபுரம்', capital: 'Anuradhapura' },
  { name: 'Polonnaruwa', province: 'North Central', sinhala: 'පොළොන්නරුව', tamil: 'பொலன்னறுவை', capital: 'Polonnaruwa' },
  { name: 'Badulla', province: 'Uva', sinhala: 'බදුල්ල', tamil: 'பதுளை', capital: 'Badulla' },
  { name: 'Monaragala', province: 'Uva', sinhala: 'මොනරාගල', tamil: 'மொணராகலை', capital: 'Monaragala' },
  { name: 'Ratnapura', province: 'Sabaragamuwa', sinhala: 'රත්නපුර', tamil: 'இரத்தினபுரி', capital: 'Ratnapura' },
  { name: 'Kegalle', province: 'Sabaragamuwa', sinhala: 'කෑගල්ල', tamil: 'கேகாலை', capital: 'Kegalle' },
];

/** The 15 Postal Zones of Colombo Municipal Council */
export const COLOMBO_POSTAL_ZONES: readonly ColomboPostalZone[] = [
  { zone: 'Colombo 01', zoneNumber: 1, primaryName: 'Fort', aliases: ['fort', 'colombo 01', 'colombo 1', 'colombo-1', 'කොටුව', 'கோட்டை'], district: 'Colombo' },
  { zone: 'Colombo 02', zoneNumber: 2, primaryName: 'Slave Island', aliases: ['slave island', 'kompannavidiya', 'kompanna veediya', 'colombo 02', 'colombo 2', 'colombo-2', 'කොම්පඤ්ඤවීදිය', 'கொம்பனித்தெரு'], district: 'Colombo' },
  { zone: 'Colombo 03', zoneNumber: 3, primaryName: 'Kollupitiya', aliases: ['kollupitiya', 'colpetty', 'kolpetty', 'colpetty junction', 'kolpetty junction', 'colombo 03', 'colombo 3', 'colombo-3', 'කොල්ලුපිටිය', 'கொள்ளுப்பிட்டி'], district: 'Colombo' },
  { zone: 'Colombo 04', zoneNumber: 4, primaryName: 'Bambalapitiya', aliases: ['bambalapitiya', 'colombo 04', 'colombo 4', 'colombo-4', 'බම්බලපිටිය', 'பம்பலப்பிட்டி'], district: 'Colombo' },
  { zone: 'Colombo 05', zoneNumber: 5, primaryName: 'Havelock Town', aliases: ['havelock town', 'havelock city', 'kirulapone', 'kirulapana', 'colombo 05', 'colombo 5', 'colombo-5', 'කිරුළපන'], district: 'Colombo' },
  { zone: 'Colombo 06', zoneNumber: 6, primaryName: 'Wellawatte', aliases: ['wellawatte', 'wellawatta', 'pamankada', 'colombo 06', 'colombo 6', 'colombo-6', 'වැල්ලවත්ත', 'வெள்ளவத்தை'], district: 'Colombo' },
  { zone: 'Colombo 07', zoneNumber: 7, primaryName: 'Cinnamon Gardens', aliases: ['cinnamon gardens', 'kurunduwatta', 'torrington', 'colombo 07', 'colombo 7', 'colombo-7', 'කුරුඳුවත්ත'], district: 'Colombo' },
  { zone: 'Colombo 08', zoneNumber: 8, primaryName: 'Borella', aliases: ['borella', 'borella junction', 'colombo 08', 'colombo 8', 'colombo-8', 'බොරැල්ල', 'பொரளை'], district: 'Colombo' },
  { zone: 'Colombo 09', zoneNumber: 9, primaryName: 'Dematagoda', aliases: ['dematagoda', 'colombo 09', 'colombo 9', 'colombo-9', 'දෙමටගොඩ', 'தெமட்டகொட'], district: 'Colombo' },
  { zone: 'Colombo 10', zoneNumber: 10, primaryName: 'Maradana', aliases: ['maradana', 'panchikawatte', 'colombo 10', 'colombo-10', 'මරදාන', 'மருதானை'], district: 'Colombo' },
  { zone: 'Colombo 11', zoneNumber: 11, primaryName: 'Pettah', aliases: ['pettah', 'pitakotuwa', 'colombo 11', 'colombo-11', 'පිටකොටුව', 'புறக்கோட்டை'], district: 'Colombo' },
  { zone: 'Colombo 12', zoneNumber: 12, primaryName: 'Hultsdorf', aliases: ['hultsdorf', 'aluthkade', 'colombo 12', 'colombo-12', 'අලුත්කඩේ'], district: 'Colombo' },
  { zone: 'Colombo 13', zoneNumber: 13, primaryName: 'Kotahena', aliases: ['kotahena', 'bloemendhal', 'colombo 13', 'colombo-13', 'කොටහේන', 'கொட்டாஞ்சேனை'], district: 'Colombo' },
  { zone: 'Colombo 14', zoneNumber: 14, primaryName: 'Grandpass', aliases: ['grandpass', 'thotalanga', 'colombo 14', 'colombo-14', 'තොටළඟ'], district: 'Colombo' },
  { zone: 'Colombo 15', zoneNumber: 15, primaryName: 'Mutwal', aliases: ['mutwal', 'modara', 'mattakkuliya', 'colombo 15', 'colombo-15', 'මට්ටක්කුලිය', 'මෝදර'], district: 'Colombo' },
];

/** Major Commercial Towns, Suburbs, Malls, and Junctions */
export const SRI_LANKAN_COMMERCIAL_HUBS: readonly LocationEntry[] = [
  // Greater Colombo / Western
  { canonicalName: 'Nugegoda', district: 'Colombo', province: 'Western', aliases: ['nugegoda', 'nugegoda junction', 'නුගේගොඩ'] },
  { canonicalName: 'Kohuwala', district: 'Colombo', province: 'Western', aliases: ['kohuwala', 'kohuwala junction', 'කොහුවල'] },
  { canonicalName: 'Maharagama', district: 'Colombo', province: 'Western', aliases: ['maharagama', 'මහරගම'] },
  { canonicalName: 'Kottawa', district: 'Colombo', province: 'Western', aliases: ['kottawa', 'කොට්ටාව'] },
  { canonicalName: 'Dehiwala', district: 'Colombo', province: 'Western', aliases: ['dehiwala', 'dehiwela', 'දෙහිවල', 'தெஹிவளை'] },
  { canonicalName: 'Mount Lavinia', district: 'Colombo', province: 'Western', aliases: ['mount lavinia', 'mt lavinia', 'mt. lavinia', 'galkissa', 'ගල්කිස්ස'] },
  { canonicalName: 'Moratuwa', district: 'Colombo', province: 'Western', aliases: ['moratuwa', 'මොරටුව'] },
  { canonicalName: 'Battaramulla', district: 'Colombo', province: 'Western', aliases: ['battaramulla', 'බත්තරමුල්ල'] },
  { canonicalName: 'Pelawatte', district: 'Colombo', province: 'Western', aliases: ['pelawatte', 'pelawatta', 'පැලවත්ත'] },
  { canonicalName: 'Thalawathugoda', district: 'Colombo', province: 'Western', aliases: ['thalawathugoda', 'thalawathugoda junction'] },
  { canonicalName: 'Malabe', district: 'Colombo', province: 'Western', aliases: ['malabe', 'මාලබේ'] },
  { canonicalName: 'Rajagiriya', district: 'Colombo', province: 'Western', aliases: ['rajagiriya', 'රාජගිරිය'] },
  { canonicalName: 'Nawala', district: 'Colombo', province: 'Western', aliases: ['nawala', 'නාවල'] },
  { canonicalName: 'Wattala', district: 'Gampaha', province: 'Western', aliases: ['wattala', 'වත්තල'] },
  { canonicalName: 'Ja-Ela', district: 'Gampaha', province: 'Western', aliases: ['ja-ela', 'ja ela', 'ජා-ඇල'] },
  { canonicalName: 'Kadawatha', district: 'Gampaha', province: 'Western', aliases: ['kadawatha', 'කඩවත'] },
  { canonicalName: 'Kiribathgoda', district: 'Gampaha', province: 'Western', aliases: ['kiribathgoda', 'කිරිබත්ගොඩ'] },
  { canonicalName: 'Kelaniya', district: 'Gampaha', province: 'Western', aliases: ['kelaniya', 'කැලණිය'] },
  { canonicalName: 'Negombo', district: 'Gampaha', province: 'Western', aliases: ['negombo', 'meegamuwa', 'මීගමුව', 'நீர்கொழும்பு'] },
  { canonicalName: 'Panadura', district: 'Kalutara', province: 'Western', aliases: ['panadura', 'පානදුර'] },
  { canonicalName: 'Kalutara', district: 'Kalutara', province: 'Western', aliases: ['kalutara', 'කළුතර'] },

  // Central / Kandy
  { canonicalName: 'Kandy', district: 'Kandy', province: 'Central', aliases: ['kandy', 'mahanuwara', 'kandy city', 'මහනුවර', 'கண்டி'] },
  { canonicalName: 'Peradeniya', district: 'Kandy', province: 'Central', aliases: ['peradeniya', 'පේරාදෙණිය'] },
  { canonicalName: 'Katugastota', district: 'Kandy', province: 'Central', aliases: ['katugastota', 'කටුගස්තොට'] },
  { canonicalName: 'Nuwara Eliya', district: 'Nuwara Eliya', province: 'Central', aliases: ['nuwara eliya', 'නුවරඑළිය'] },
  { canonicalName: 'Dambulla', district: 'Matale', province: 'Central', aliases: ['dambulla', 'දඹුල්ල'] },

  // Southern
  { canonicalName: 'Galle', district: 'Galle', province: 'Southern', aliases: ['galle', 'galle fort', 'ගාල්ල', 'காலி'] },
  { canonicalName: 'Unawatuna', district: 'Galle', province: 'Southern', aliases: ['unawatuna', 'උණවටුන'] },
  { canonicalName: 'Hikkaduwa', district: 'Galle', province: 'Southern', aliases: ['hikkaduwa', 'හික්කඩුව'] },
  { canonicalName: 'Matara', district: 'Matara', province: 'Southern', aliases: ['matara', 'මාතර'] },
  { canonicalName: 'Mirissa', district: 'Matara', province: 'Southern', aliases: ['mirissa', 'මිරිස්ස'] },

  // Major Malls & Shopping Landmarks
  { canonicalName: 'One Galle Face', district: 'Colombo', province: 'Western', aliases: ['one galle face', 'one galle face mall', 'ogf'], isMall: true },
  { canonicalName: 'Colombo City Centre', district: 'Colombo', province: 'Western', aliases: ['colombo city centre', 'colombo city center', 'ccc'], isMall: true },
  { canonicalName: 'Havelock City Mall', district: 'Colombo', province: 'Western', aliases: ['havelock city mall', 'havelockcity mall', 'hcm'], isMall: true },
  { canonicalName: 'Crescat Boulevard', district: 'Colombo', province: 'Western', aliases: ['crescat boulevard', 'crescat'], isMall: true },
  { canonicalName: 'Majestic City', district: 'Colombo', province: 'Western', aliases: ['majestic city', 'mc'], isMall: true },
  { canonicalName: 'Kandy City Centre', district: 'Kandy', province: 'Central', aliases: ['kandy city centre', 'kandy city center', 'kcc'], isMall: true },
];

/** Direct alias lookup map for exact match */
const aliasToLocationMap = new Map<string, LocationEntry>();
for (const hub of SRI_LANKAN_COMMERCIAL_HUBS) {
  for (const alias of hub.aliases) {
    aliasToLocationMap.set(alias.toLowerCase(), hub);
  }
}

/** Pre-sorted by longest alias first to prevent short names (e.g. 'Galle') matching before 'One Galle Face' */
const SORTED_HUBS_BY_ALIAS_LENGTH = SRI_LANKAN_COMMERCIAL_HUBS.flatMap((hub) =>
  hub.aliases.map((alias) => ({ alias: alias.toLowerCase(), hub, len: alias.length })),
).sort((a, b) => b.len - a.len);

/** Direct alias lookup map for Colombo postal zones */
const aliasToPostalZoneMap = new Map<string, ColomboPostalZone>();
for (const pz of COLOMBO_POSTAL_ZONES) {
  for (const alias of pz.aliases) {
    aliasToPostalZoneMap.set(alias.toLowerCase(), pz);
  }
}

const SORTED_ZONES_BY_ALIAS_LENGTH = COLOMBO_POSTAL_ZONES.flatMap((pz) =>
  pz.aliases.map((alias) => ({ alias: alias.toLowerCase(), pz, len: alias.length })),
).sort((a, b) => b.len - a.len);

export function findColomboPostalZone(text: string): ColomboPostalZone | null {
  if (!text) return null;
  const clean = text.toLowerCase().trim();

  // 1. Direct alias match
  if (aliasToPostalZoneMap.has(clean)) {
    return aliasToPostalZoneMap.get(clean)!;
  }

  // 2. Pattern match for "Colombo 03", "Colombo 3", "Colombo-03", "Colombo 3."
  const cboMatch = clean.match(/\bcolombo\s*[-–]?\s*0?([1-9]|1[0-5])\b/i);
  if (cboMatch) {
    const num = parseInt(cboMatch[1], 10);
    const found = COLOMBO_POSTAL_ZONES.find((z) => z.zoneNumber === num);
    if (found) return found;
  }

  // 3. Substring check for named zones (longest alias first)
  for (const item of SORTED_ZONES_BY_ALIAS_LENGTH) {
    if (item.len > 3) {
      const escaped = item.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(clean)) {
        return item.pz;
      }
    }
  }

  return null;
}

export function findCommercialHub(text: string): LocationEntry | null {
  if (!text) return null;
  const clean = text.toLowerCase().trim();

  // 1. Exact alias match
  if (aliasToLocationMap.has(clean)) {
    return aliasToLocationMap.get(clean)!;
  }

  // 2. Substring match (longest alias first so 'One Galle Face' precedes 'Galle')
  for (const item of SORTED_HUBS_BY_ALIAS_LENGTH) {
    if (item.len > 2) {
      const escaped = item.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(clean)) {
        return item.hub;
      }
    }
  }

  return null;
}
