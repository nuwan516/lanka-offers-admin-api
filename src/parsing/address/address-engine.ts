import { stripHtmlKeepLines } from '@/parsing/text/html';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface AddressEngineConfig {
    /**
     * Country suffix appended when no country is found in the extracted address.
     * Used as part of the Places API search query when no structured address exists.
     * @default 'Sri Lanka'
     */
    country?: string;

    /**
     * Additional labeled-marker patterns specific to a bank/source.
     * Each regex must have exactly one capture group containing the address text.
     * These are prepended before the built-in marker set.
     *
     * @example [/Participating Restaurants?\s*:\s*([^;.\n]+)/i]
     */
    extraMarkers?: RegExp[];

    /**
     * Additional regex patterns to strip from extracted text (e.g., bank-specific
     * boilerplate that leaks through).
     */
    excludePatterns?: RegExp[];

    /**
     * Whether to fall back to `<merchantName>, <country>` when no address is found.
     * Defaults to true: the merchant-name query is the Places search hint for chains. It is NOT
     * a venue — location-scope classification ignores merchant-only addresses.
     * @default true
     */
    fallbackToMerchant?: boolean;

    /**
     * Dynamic reject patterns (admin `address_exclude` rules), evaluated per address so rule
     * edits apply without a restart. A match means the text is not an address.
     */
    rejectPatterns?: () => RegExp[];
}

// ─── Built-in labeled marker patterns ─────────────────────────────────────────
// Priority 1: explicit labeled sections.
// Each pattern must have exactly one capture group.
//
// Capture length: {3,200} — long enough for multi-branch lists, short enough to
// avoid capturing multiple unrelated sentences.

const BUILT_IN_MARKERS: RegExp[] = [
    /\bAddress\s*:\s*([^;\n]{3,200})/i,
    /\bLocations?\s*:\s*([^;\n]{3,200})/i,
    /\bBranch(?:es)?\s*:\s*([^;\n]{3,200})/i,
    /\bOutlet(?:s)?\s*:\s*([^;\n]{3,200})/i,
    /\bShop\s*:\s*([^;\n]{3,200})/i,
    /(?<![-a-zA-Z])Store\s*:\s*([^;\n]{3,200})/i,
    /\bAvailable\s+at\s*:\s*([^;\n]{3,200})/i,
    /\bFind\s+us\s+at\s*:\s*([^;\n]{3,200})/i,
    /\bVisit\s+us\s+at\s*:\s*([^;\n]{3,200})/i,
    /\bParticipating\s+(?:outlets?|branches?|stores?|restaurants?|hotels?)\s*:\s*([^;\n]{3,200})/i,
    /\bVenue\s*:\s*([^;\n]{3,200})/i,
];

// ─── Prose-embedded address patterns ──────────────────────────────────────────
// Priority 2: addresses introduced by prepositions / phrases but without an explicit
// colon-label. These are matched anywhere in the text as full-match patterns that
// return the address portion directly (capture group 1).

const PROSE_PATTERNS: RegExp[] = [
    // "located at No. 5, Main Road"
    /\b(?:located|situated|available|visit\s+us)\s+at\s+((?:No\.?\s*)?\d[^;\n]{3,120})/i,
    // "at No. 5, Main Road" (standalone preposition)
    /\bat\s+(No\.?\s*\d+[^;\n]{3,80})/i,
    // "call or visit <address>" — capture up to end of sentence
    /\bvisit\s+((?:No\.?\s*)?\d+[^;\n]{3,80})/i,
    // parenthesised address: "(No. 5, Galle Road)"
    /\(([^)]{5,100}(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St)[^)]{0,50})\)/i,
    // "our showroom at <address>"
    /\bour\s+(?:showroom|branch|store|outlet|hotel|restaurant)\s+at\s+([^;\n]{5,120})/i,
    // venue after "@": "@ Nuga Gama Restaurant, Cinnamon Grand Colombo" (BOC dining)
    // must not be preceded by a word char (that would be an email address)
    /(?:^|\s)@\s*([A-Za-z][^;\n|@]{3,100})/,
];

// ─── Structural segment patterns ──────────────────────────────────────────────
// Priority 3: scan every text segment (split by newline/semicolon) and classify
// it as address-like based on its shape alone.

const STRUCTURAL_PATTERNS: RegExp[] = [
    /\bNo\.?\s*\d+\b/i,                                             // "No. 5" or "No 45"
    /\b\d+[A-Z]?\s*[,/]\s*(?!(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)[A-Za-z]/i, // "12A, Main" or "12/A Main", not "31/Dec"
    /\b\d+\s*,\s*[A-Za-z]/,                                        // "123, Galle"
    // word boundary before the road word is required; "Place" must be capitalised to count as a road word
    /\b[A-Za-z]+\s+(?:Road|Street|Lane|Avenue|Mawatha|Junction|Rd|St)\b/i,
    /\b[A-Za-z]+\s+Place\b/,
    /\b(?:Hotel|Resort|Restaurant|Café|Cafe)\s+[A-Za-z]/i,
    /\b[A-Za-z]+\s+(?:Hotel|Resort|Restaurant|Café|Cafe)\b/i,
    /(?<!(?:Rs\.?|LKR)\s*)\b\d{5}\b/i,                              // 5-digit LK postal code, not currency amounts
    /\b\d+(?:st|nd|rd|th)\s+(?:Floor|Lane|Cross)/i,                // "3rd Floor", "2nd Lane"
    /\bFloor\s+\d+\b/i,                                             // "Floor 2"
    /^[A-Za-z][A-Za-z.'\s]{1,40},\s*Sri\s+Lanka\.?$/i,             // "Wadduwa, Sri Lanka" (city-only line)
    /^Colombo\s+\d{1,2}\.?$/i,                                      // "Colombo 03" (district-only line)
];

// ─── Noise / rejection patterns ───────────────────────────────────────────────

const NOISE_PATTERNS: RegExp[] = [
    /^all\s+(?:outlets?|branches?|locations?|stores?|island\s*wide)\b/i, // generic, not geocodable
    /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/?$/i, // bare domain/URL in an address field (NDB online stores)
    /^[+\d][\d\s/+-]{5,}$/, // phone number in an address field (Seylan data errors)
    /\bvalid\s+(?:on|until|till|through|from)\b/i,
    /click\s+here/i,
    /visit\s+website/i,
    /terms\s+and\s+conditions/i,
    /subject\s+to/i,
    /\b\d+\s*%/,                   // discount percentages
    /\b\d+\s*off\b/i,              // discount figures e.g. "20 off", "30 off"
    /\bflat\s+\d+\b/i,             // "Flat 20"
    /\bup\s+to\s+\d+\s*off\b/i,
    /\boff\s+(?:the|all|total|your|selected|any|every|storewide|items?|bill|purchases?)\b/i,
    // "off" is noise UNLESS followed by a road name (e.g. "Off Galle Road", "No 5, Off High Level Road")
    /\boff\b(?!\s+(?:[A-Za-z0-9.'\s]+\s+)?(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St|Drive|Highway)\b)/i,
    /\bstreet\s+food\b/i,          // "Enjoy Street food all week"
    /\bfree\s+delivery\b/i,        // "Free delivery above Rs. 15000"
    /\bdraw\s+takes\s+place\b/i,   // "Draw takes place in December"
    /\ball\s+week\b/i,
    /\bbuy\s+(?:\d+|one)\s+get\s+(?:\d+|one)\b/i, // "Buy one get one free", "Buy 2 get 1 free"
    /\bget\s+\d+\s+free\b/i,
    /\bfree\s+on\s+all\b/i,
    /\bfree\s+on\s+\w+\b/i,
    /\bminimum\s+spend/i,
    /\beligible\b/i,
    /\bcannot\s+be\s+combined/i,
    /\bper\s+(?:card|person|transaction)\b/i,
    /\bpurchase[sd]?\b/i,
    /\bpromoti(?:on|onal)\b/i,
    /\binstallment\b/i,
    /\breservation\b/i,
    /\bbilling\s+cycle\b/i,
    /\bexcept\s+(?:corporate|business|fuel)\b/i,
    /\bapplicable\s+for\b/i,
    /\bconverted\s+into\b/i,
    /\bmaximum\b/i,
    /\bcheck\s*-\s*in\b/i,
    /\bverification\b/i,
    /\bidentification\b/i,
    /\brate\s+being\s+applied\b/i,
    /\bbookings\s+must\s+be\s+made\b/i,
    /\bcall\s+centre\b/i,
    /\b(?:cardholder|customer)s?\b/i,
    /\btransactions?\b/i,
    /\bdiscount\b/i,
    /\bcontact\b/i,
    /\bpayable\b/i,
    /\b(?:easy\s+)?payment\s+plans?\b/i,                          // "request for easy payment plans up to 06 months"
    /\b\d+\s*(?:\(\w+\)\s*)?months?\b/i,                          // tenor wording, never a place
    /\brequest\s+for\b/i,
    /\b(?:debit|credit)\s+(?:and\s+(?:debit|credit)\s+)?cards?\b/i,
    /^(?:business|personal|corporate|retail|online|islandwide|general)\.?$/i, // generic labels
    /@/,                                                          // broken email fragment left after contact stripping
];

// ─── Phone / URL / email cleaners ────────────────────────────────────────────

function stripContactInfo(text: string): string {
    return text
        // Labeled contact fields — must be whole words followed by ":" / "-" or a number
        .replace(/(?:[-–—]\s*)?\b(?:Contact|Tel|Telephone|Phone|Reservations?|Hotline|Call\s+Center|Website|Web|Email)\b\s*(?:No\.?)?\s*(?:[:-]|\d).*$/i, '')
        // Phone numbers: +94 or 0 followed by area code and subscriber digits with spaces/hyphens
        .replace(/\b(?:\+94[\s-]*|0)\d{2}[\s-]*(?:\d[\s-]*){7}\b/g, '')
        // Remaining long standalone digit runs
        .replace(/\b\d{9,}\b/g, '')
        // URLs
        .replace(/https?:\/\/\S+/gi, '')
        // Emails
        .replace(/[\w.-]+@[\w.-]+\.\w+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function cutSentenceBoundary(text: string): string {
    // Cut at sentence boundary (. followed by space and capital or promo keyword),
    // but not at abbreviation dots (Mt., No., Rd., St., Dr., Ave., Blvd., Ste.)
    const match = /(?<!\b(?:Mt|No|Rd|St|Dr|Ste|Ave|Blvd))\.\s+(?=[A-Z]|valid\b|terms\b)/i.exec(text);
    if (match) {
        return text.slice(0, match.index).trim();
    }
    return text;
}

function stripTrailing(text: string): string {
    // trailing "-" is left behind after "... - Contact No: ..." is stripped
    return text.replace(/[-,.\s]+$/, '').trim();
}

function isNoise(text: string): boolean {
    return NOISE_PATTERNS.some(p => p.test(text));
}

// ─── AddressEngine ────────────────────────────────────────────────────────────

export class AddressEngine {
    private readonly country: string;
    private readonly markers: RegExp[];
    private readonly excludePatterns: RegExp[];
    private readonly fallbackToMerchant: boolean;
    private readonly rejectPatterns: () => RegExp[];

    constructor(config: AddressEngineConfig = {}) {
        this.country = config.country ?? 'Sri Lanka';
        this.markers = [...(config.extraMarkers ?? []), ...BUILT_IN_MARKERS];
        this.excludePatterns = config.excludePatterns ?? [];
        this.fallbackToMerchant = config.fallbackToMerchant ?? true;
        this.rejectPatterns = config.rejectPatterns ?? (() => []);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Extract address strings from raw offer text.
     *
     * Strategy (highest → lowest confidence):
     *   1. Labeled markers     — "Location: ...", "Branch: ..."
     *   2. Prose-embedded      — "located at No. 5, Galle Road"
     *   3. Structural segments — any line/segment shaped like an address
     *   4. Fallback            — "<merchantName>, <country>"  (only if fallbackToMerchant is true)
     *
     * @param rawText      Raw offer content (may contain HTML)
     * @param merchantName Merchant name used as fallback query hint
     */
    extract(rawText: string, merchantName = ''): string[] {
        if (!rawText && !merchantName) return [];

        // Newlines are preserved — one-branch-per-line lists (BOC) depend on them
        const text = rawText ? stripHtmlKeepLines(rawText) : '';

        // 1. Labeled markers (highest confidence)
        const fromMarkers = this.extractFromMarkers(text, merchantName);
        if (fromMarkers.length > 0) return fromMarkers;

        // 2. Prose-embedded patterns
        const fromProse = this.extractFromProse(text, merchantName);
        if (fromProse.length > 0) return fromProse;

        // 3. Structural segment scan
        const fromStructure = this.extractFromStructure(text, merchantName);
        if (fromStructure.length > 0) return fromStructure;

        // 4. Fallback — only if explicitly enabled
        if (this.fallbackToMerchant && merchantName) {
            return [this.appendCountry(merchantName)];
        }
        return [];
    }

    /**
     * Explicit Places API search query builder when geocoding is needed for a merchant venue,
     * keeping address extraction cleanly separated from Places API search queries.
     */
    buildPlacesSearchQuery(merchantName: string, locationHint?: string): string | null {
        if (!merchantName) return null;
        if (locationHint && locationHint !== '.' && !locationHint.startsWith('http') && !/all\s+outlets/i.test(locationHint)) {
            return this.appendCountry(`${merchantName}, ${locationHint}`);
        }
        return this.appendCountry(merchantName);
    }

    /**
     * Normalize a single raw address string:
     * - Strips labeled prefixes, phone numbers, URLs, emails
     * - Appends country if missing
     * - Returns null if the result is too short or is noise
     */
    normalize(address: string, _merchantName = ''): string | null {
        if (!address) return null;

        let cleaned = address
            // Strip common labeled prefixes that may have been included
            .replace(/^(?:Location|Address|Available at|Outlets?|Branches?|Shop|Venue)\s*[:-]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        cleaned = stripContactInfo(cleaned);

        // Apply any extra bank-specific exclusion patterns
        for (const pattern of this.excludePatterns) {
            cleaned = cleaned.replace(pattern, '').trim();
        }

        // Portal boilerplate glued to a place: "Hikkaduwa Special Terms" -> "Hikkaduwa"
        cleaned = cleaned.replace(/\s*[-–]?\s*\bSpecial\s+Terms\b.*$/i, '');
        cleaned = stripTrailing(cleaned);

        if (cleaned.length < 3) return null;
        if (isNoise(cleaned)) return null;
        if (this.rejectPatterns().some(p => p.test(cleaned))) return null;

        return this.appendCountry(cleaned);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** Step 1: match explicit colon-labeled sections */
    private extractFromMarkers(text: string, merchantName: string): string[] {
        const results: string[] = [];

        for (const marker of this.markers) {
            // Use global flag clone so we capture ALL occurrences (e.g. multiple branches)
            const gMarker = new RegExp(marker.source, 'gi');
            let match: RegExpExecArray | null;

            while ((match = gMarker.exec(text)) !== null) {
                // No noise pre-check here: lines like "No 33, ... - Contact: 011 269 8161"
                // must have contact info stripped (inside normalize) before judging noise.
                const content = cutSentenceBoundary(match[1].trim());
                const continuation: string[] = [];
                const followingLines = text.slice(gMarker.lastIndex).split('\n').slice(1);
                for (const line of followingLines) {
                    if (/^\s*(?:No\.?\s*\d|.{3,80}?-\s*(?:Contact|Tel|Phone|Hotline))/i.test(line)) {
                        continuation.push(line.trim());
                    } else {
                        break;
                    }
                }

                for (const part of this.splitMulti(content)) {
                    const normalized = this.normalize(part, merchantName);
                    if (normalized) results.push(normalized);
                }
                // Continuation lines are one address per line by construction —
                // their internal commas are address punctuation, never separators.
                for (const line of continuation) {
                    const normalized = this.normalize(line, merchantName);
                    if (normalized) results.push(normalized);
                }
            }

            // If this marker yielded results, stop — don't mix marker levels
            if (results.length > 0) break;
        }

        return [...new Set(results)];
    }

    /** Step 2: find addresses introduced by prose phrases ("located at", etc.) */
    private extractFromProse(text: string, merchantName: string): string[] {
        const results: string[] = [];

        for (const pattern of PROSE_PATTERNS) {
            const gPattern = new RegExp(pattern.source, 'gi');
            let match: RegExpExecArray | null;

            while ((match = gPattern.exec(text)) !== null) {
                const candidate = cutSentenceBoundary(match[1].trim());
                if (!candidate || isNoise(candidate)) continue;

                const normalized = this.normalize(candidate, merchantName);
                if (normalized) results.push(normalized);
            }
        }

        return [...new Set(results)];
    }

    /**
     * Step 3: segment the text at natural boundaries (newlines, semicolons,
     * sentence endings) and classify each segment structurally.
     */
    private extractFromStructure(text: string, merchantName: string): string[] {
        // Split at sentence-like boundaries: newlines, semicolons, periods followed
        // by space+capital. Abbreviations ("Mt. Lavinia", "No. 5") must not split —
        // require ≥3 lowercase letters before the period for it to end a sentence.
        const segments = text.split(/[\n;]|(?<=[a-z]{3}\.)\s+(?=[A-Z])/);
        const results: string[] = [];

        for (const seg of segments) {
            const trimmed = seg.trim();
            if (trimmed.length < 5 || trimmed.length > 200) continue;
            if (!STRUCTURAL_PATTERNS.some(p => p.test(trimmed))) continue;

            // A segment can itself be a " / "-separated branch list. Only the
            // spaced-slash split applies here — a structural segment's commas
            // are internal address punctuation, never separators.
            const parts = /\s\/\s/.test(trimmed) ? trimmed.split(/\s+\/\s+/) : [trimmed];
            for (const part of parts) {
                const normalized = this.normalize(part, merchantName);
                if (normalized) results.push(normalized);
            }
        }

        return [...new Set(results)];
    }

    private isContinuation(prev: string, curr: string): boolean {
        // Floor / Level / Unit prefix in prev makes next part a continuation
        if (/^(?:Level|Floor|Unit|Shop|Building)\s+\d+\b/i.test(prev) || /^\d+(?:st|nd|rd|th)\s+(?:Floor|Level)\b/i.test(prev)) {
            return true;
        }

        // House number prefix in prev makes next location/road/town a continuation (e.g. "No. 5, Mt. Lavinia")
        if (/^No\.?\s*\d+\b/i.test(prev) || /^\d+[A-Za-z]?(?:[/,]\d+)?\b/.test(prev)) {
            return true;
        }

        // Road part: contains a road keyword
        if (/\b(?:Road|Street|Lane|Place|Avenue|Mawatha|Junction|Rd|St|Drive|Highway|Way|Mw)\b/i.test(curr)) {
            return true;
        }

        // Zone part: "Colombo 03", etc.
        if (/^Colombo\s+\d{1,2}\b/i.test(curr)) {
            return true;
        }

        // Floor / level in curr
        if (/^(?:Level|Floor|Unit|Shop|Building)\s+\d+\b/i.test(curr) || /^\d+(?:st|nd|rd|th)\s+(?:Floor|Level)\b/i.test(curr)) {
            return true;
        }

        // House number in curr
        if (/^No\.?\s*\d+\b/i.test(curr) || /^\d+[A-Za-z]?(?:[/,]\d+)?\b/.test(curr)) {
            return true;
        }

        // Country / postal code
        if (/^Sri\s+Lanka\b/i.test(curr) || /^\d{5}\b/.test(curr)) {
            return true;
        }

        // Single town / city continuation when prev is a venue/hotel/restaurant (e.g. "Dolphin Hotel and Spa, Wadduwa")
        // and curr is not itself another venue
        const VENUE_OR_ROAD = /\b(?:Hotel|Spa|Resort|Restaurant|Cafe|Café|Bakery|Kitchen|Bar|Pub|Boutique|Lounge|Road|Street|Lane|Mawatha|Rd|St)\b/i;
        if (VENUE_OR_ROAD.test(prev) && !VENUE_OR_ROAD.test(curr)) {
            if (/^[A-Za-z\s.'-]{2,30}$/.test(curr)) {
                return true;
            }
        }

        return false;
    }

    private mergeContinuations(parts: string[]): string[] {
        const merged: string[] = [];
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            if (merged.length === 0) {
                merged.push(trimmed);
            } else {
                const prev = merged[merged.length - 1];
                if (this.isContinuation(prev, trimmed)) {
                    merged[merged.length - 1] = `${prev}, ${trimmed}`;
                } else {
                    merged.push(trimmed);
                }
            }
        }
        return merged;
    }

    /**
     * Split a multi-address string into individual parts.
     * Handles: "|", "&", "and", newlines, and comma-separated lists while
     * preserving venue names and address continuations (road, zone, floor).
     */
    private splitMulti(text: string): string[] {
        // " / "-separated branch lists (Seylan): "168, Old Negombo Road, Ja-Ela /
        // 98, ... / 451, Peradeniya Road, Kandy". A spaced slash is a separator;
        // "27/1" style house numbers are not.
        if (/\s\/\s/.test(text)) {
            return text
                .split(/\s+\/\s+/)
                .map(p => p.trim())
                .filter(p => p.length > 2);
        }

        // Several "No N, ..." addresses on one line → split before each
        const houseNumbers = text.match(/\bNo\.?\s*\d+/gi);
        if (houseNumbers && houseNumbers.length >= 2) {
            return text
                .split(/(?=\bNo\.?\s*\d+[A-Za-z]?\s*[,/])/i)
                .map(p => p.replace(/^[\s,&|]+|[\s,&|]+$/g, '').replace(/^and\s+/i, ''))
                .filter(p => p.length > 2);
        }

        // Protect & / and when neighbouring a venue word (Hotel, Spa, Co, Restaurant, Sons, etc.)
        // Use \uE001 for '&' and \uE002 for 'and'
        const VENUE_WORDS = /\b(?:Hotel|Spa|Co|Company|Restaurant|Sons|Resort|Bar|Pub|Cafe|Café|Bakery|Kitchen|Boutique|Lounge|Suites|Villas?|Inn|Saloon|Salon|Bistro|Grill)\b/i;

        const shielded = text.replace(/(\S+)\s+(&|and)\s+(\S+)/gi, (match, before, conj, after) => {
            if (VENUE_WORDS.test(before) || VENUE_WORDS.test(after)) {
                return `${before} ${conj === '&' ? '\uE001' : '\uE002'} ${after}`;
            }
            return match;
        });

        // Split on explicit separators: pipes, unshielded & / and, newlines
        const segments = shielded
            .split(/(?:\s*[|]\s*|\s*&\s*|\s+and\s+|\n)/i)
            .map(s => s.trim())
            .filter(s => s.length > 2);

        const results: string[] = [];

        for (const segment of segments) {
            // Split segment on commas and merge continuations
            const rawParts = segment.split(/,\s*/);
            const mergedParts = this.mergeContinuations(rawParts);
            for (const part of mergedParts) {
                // Restore placeholders
                const restored = part
                    .replace(/\uE001/g, '&')
                    .replace(/\uE002/g, 'and')
                    .trim();
                if (restored.length > 2) {
                    results.push(restored);
                }
            }
        }

        return results;
    }

    private appendCountry(text: string): string {
        if (text.toLowerCase().includes(this.country.toLowerCase())) return text;
        return `${text}, ${this.country}`;
    }
}
