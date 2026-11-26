import { Validity, RecurrenceType, PeriodType, DateRange, TimeWindow } from '@/core/types/offers';

const MONTHS: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    decmber: 11, dcember: 11, // observed typos
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type Weekday = typeof WEEKDAYS[number];

const FUZZY_WEEKDAY_MAP: Record<string, Weekday> = {
    monday: 'monday', mon: 'monday', mondy: 'monday',
    tuesday: 'tuesday', tue: 'tuesday', tuesdy: 'tuesday',
    wednesday: 'wednesday', wed: 'wednesday', wednseday: 'wednesday',
    thursday: 'thursday', thu: 'thursday', thursdy: 'thursday',
    friday: 'friday', fri: 'friday', friady: 'friday',
    saturday: 'saturday', sat: 'saturday', saturdy: 'saturday',
    sunday: 'sunday', sun: 'sunday', sundy: 'sunday',
};

const RECURRENCE_LABEL_PATTERNS = [
    { pattern: /\b(?:offer\s+period|offer)\s*:\s*/gi, type: PeriodType.OFFER },
    { pattern: /\b(?:booking\s+period|book(?:ing)?)\s*:\s*/gi, type: PeriodType.BOOKING },
    { pattern: /\b(?:stay(?:ing)?\s+period)\s*:\s*/gi, type: PeriodType.STAY },
    { pattern: /\b(?:travel(?:l?ing)?\s+period)\s*:\s*/gi, type: PeriodType.TRAVEL },
    { pattern: /\b(?:installment\s+period|instalment\s+period)\s*:\s*/gi, type: PeriodType.INSTALLMENT },
    { pattern: /\b(?:reserv(?:e|ation)\s+period)\s*:\s*/gi, type: PeriodType.RESERVATION },
    { pattern: /\b(?:event\s+period)\s*:\s*/gi, type: PeriodType.EVENT },
    // Seylan bundles dual windows without colons: "Offer valid until 31st
    // August 2026 EPP valid until 31st December 2026"
    { pattern: /\b(?:epp|installment\s+plans?|instalment\s+plans?|easy\s+payment\s+plans?)\s+valid\b\s*[;:]?\s*/gi, type: PeriodType.INSTALLMENT },
    // "Booking valid from X to Y" (ComBank) — bare "Booking valid", not
    // "Booking period:". Checked before the generic "offers? valid" pattern
    // so it isn't swallowed as type OFFER.
    { pattern: /\bbooking\s+valid\b\s*[;:]?\s*/gi, type: PeriodType.BOOKING },
    { pattern: /\b(?:offers?|discounts?)\s+valid\b\s*[;:]?\s*/gi, type: PeriodType.OFFER },
];


function clean(text: string): string {
    return text
        .replace(/-{2,}/g, '-') // "2026-07--01" typo
        .replace(/;/g, '') // "Ju;ly" typo
        .replace(/(\d+)(?:st|nd|rd|th|at|h)\b/gi, '$1') // "at"/"h" cover "31at July"/"29h" typos
        .replace(/\bof\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Calendar date in Asia/Colombo (UTC+05:30, no DST). `YYYY-MM-DD`. */
export const COLOMBO_TIME_ZONE = 'Asia/Colombo';

export function colomboCalendarDate(now: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: COLOMBO_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}

export function colomboCalendarYear(now: Date = new Date()): number {
    return parseInt(colomboCalendarDate(now).slice(0, 4), 10);
}

export function extractYear(text: string): number | null {
    const m = text.match(/\b(20\d{2})\b/);
    return m ? parseInt(m[1], 10) : null;
}

export function normalizeWeekday(input: string): Weekday | null {
    const key = input.toLowerCase().trim();
    // direct match
    if (WEEKDAYS.includes(key as Weekday)) return key as Weekday;
    // fuzzy match
    if (FUZZY_WEEKDAY_MAP[key]) return FUZZY_WEEKDAY_MAP[key];
    // prefix match (e.g., "mon" already handled, but for safety)
    for (const day of WEEKDAYS) {
        if (key.length >= 3 && day.startsWith(key.substring(0, 3))) return day;
    }
    return null;
}

export function parseHumanDate(text: string, fallbackYear?: number): string | null {
    if (!text) return null;
    const cleaned = clean(text);
    // ISO: YYYY-MM-DD — matched anywhere ("Valid from 2026-07-01" on cards)
    let m = cleaned.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
        return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    }
    // DD.MM.YYYY
    m = cleaned.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) {
        return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    // DD Month YYYY or Month DD YYYY
    // (?!\d) after each day group stops "December 2026" (no day at all) from
    // misparsing as day=20 by greedily eating the first two digits of the
    // year — without it, a bare "Month YYYY" silently "succeeds" with a
    // fabricated day instead of correctly failing to match.
    const monthNames = Object.keys(MONTHS).join('|');
    const regex = new RegExp(
        `(\\d{1,2})(?!\\d)\\s+(${monthNames})\\s*,?\\s*(\\d{4})?|(${monthNames})\\s+(\\d{1,2})(?!\\d)(?:,)?\\s*(\\d{4})?`,
        'i'
    );
    m = cleaned.match(regex);
    if (!m) return null;

    let day: string, month: number, year: number;
    if (m[1]) {
        // DD Month YYYY
        day = String(parseInt(m[1], 10)).padStart(2, '0');
        month = MONTHS[m[2].toLowerCase()];
        year = m[3] ? parseInt(m[3], 10) : fallbackYear ?? colomboCalendarYear();
    } else {
        // Month DD YYYY
        month = MONTHS[m[4].toLowerCase()];
        day = String(parseInt(m[5], 10)).padStart(2, '0');
        year = m[6] ? parseInt(m[6], 10) : fallbackYear ?? colomboCalendarYear();
    }

    if (month === undefined || isNaN(month)) return null;
    const date = new Date(year, month, parseInt(day));
    if (date.getMonth() !== month) return null; // invalid day

    const y = date.getFullYear();
    if (y < 2000 || y > 2100) return null; // sanity check

    return `${year}-${String(month + 1).padStart(2, '0')}-${day}`;
}

/** Bare "Month Year" (no day) → last calendar day of that month. */
function parseMonthEndDate(text: string, fallbackYear?: number): string | null {
    const cleaned = clean(text);
    const monthNames = Object.keys(MONTHS).join('|');
    const m = cleaned.match(new RegExp(`\\b(${monthNames})\\s*(\\d{4})?\\b`, 'i'));
    if (!m) return null;
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) return null;
    const year = m[2] ? parseInt(m[2], 10) : fallbackYear ?? colomboCalendarYear();
    const lastDay = new Date(year, month + 1, 0).getDate();
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export function isValidDateStr(dateStr: string | null): boolean {
    if (!dateStr) return false;
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const d = new Date(dateStr);
    return !isNaN(d.getTime()) && dateStr === d.toISOString().split('T')[0];
}

export function extractRecurrenceDays(text: string): Weekday[] {
    const days: Set<Weekday> = new Set();
    const lower = text.toLowerCase();

    // "every Monday", "on Tuesdays", "every weekend"
    if (/weekend/i.test(lower)) {
        days.add('saturday');
        days.add('sunday');
    }
    if (/weekday/i.test(lower)) {
        for (const d of WEEKDAYS) if (d !== 'saturday' && d !== 'sunday') days.add(d);
    }

    // explicit "every Monday" or "every Mon"
    const everyMatches = lower.match(/every\s+([a-z]{3,}day)s?/g);
    if (everyMatches) {
        everyMatches.forEach(m => {
            const word = m.replace(/every\s+/i, '').replace(/s$/i, '');
            const normalized = normalizeWeekday(word);
            if (normalized) days.add(normalized);
        });
    }

    // Range: "Monday to Friday"
    const rangeMatch = lower.match(/(\w+day)\s+to\s+(\w+day)/);
    if (rangeMatch) {
        const startDay = normalizeWeekday(rangeMatch[1]);
        const endDay = normalizeWeekday(rangeMatch[2]);
        if (startDay && endDay) {
            const startIdx = WEEKDAYS.indexOf(startDay);
            const endIdx = WEEKDAYS.indexOf(endDay);
            for (let i = startIdx; i !== (endIdx + 1) % 7; i = (i + 1) % 7) {
                days.add(WEEKDAYS[i]);
            }
        }
    }

    // Also catch "Mondays & Fridays", "On Thursdays" etc — plural forms included
    const explicitDays = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi);
    if (explicitDays) {
        explicitDays.forEach(d => {
            const normalized = normalizeWeekday(d.replace(/s$/i, ''));
            if (normalized) days.add(normalized);
        });
    }

    return [...days];
}

export function extractTimeWindow(text: string): TimeWindow | null {
    // Handles "3pm to 9pm", "10:00 AM – 9:00 PM", "10.30am-5pm", and
    // single-suffix ranges like "6:00-7:00 PM" (first meridiem inferred)
    const match = text.match(
        /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:to|till|[-–—|])\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)/i,
    );
    if (!match) return null;

    let fromH = parseInt(match[1], 10);
    const fromMin = match[2] ?? '00';
    const fromMer = (match[3] ?? match[6]).toLowerCase();
    let toH = parseInt(match[4], 10);
    const toMin = match[5] ?? '00';
    const toMer = match[6].toLowerCase();
    if (fromMer === 'pm' && fromH !== 12) fromH += 12;
    if (fromMer === 'am' && fromH === 12) fromH = 0;
    if (toMer === 'pm' && toH !== 12) toH += 12;
    if (toMer === 'am' && toH === 12) toH = 0;
    return {
        from: `${String(fromH).padStart(2, '0')}:${fromMin}`,
        to: `${String(toH).padStart(2, '0')}:${toMin}`,
    };
}

export function extractMonthlyRange(text: string): { fromDay: number; toDay: number } | null {
    const m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+(?:each|every)\s+month/i);
    if (m) {
        return { fromDay: parseInt(m[1], 10), toDay: parseInt(m[2], 10) };
    }
    // NDB phrasing: "20th - Month end in Every month 2026"
    const m2 = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s*[-–]\s*month\s*end/i);
    if (m2 && /every\s+month/i.test(text)) {
        return { fromDay: parseInt(m2[1], 10), toDay: 31 };
    }
    return null;
}

export function extractBlackoutPeriods(text: string, fallbackYear?: number): DateRange[] {
    const ranges: DateRange[] = [];

    // ISO ranges: "2026-04-11 to 2026-04-17"
    const isoRe = /\b(\d{4}-\d{1,2}-\d{1,2})\s*(?:to|till|[-–])\s*(\d{4}-\d{1,2}-\d{1,2})\b/gi;
    let isoMatch;
    while ((isoMatch = isoRe.exec(text)) !== null) {
        const from = parseHumanDate(isoMatch[1]);
        const to = parseHumanDate(isoMatch[2]);
        if (from && to) ranges.push({ from, to });
    }
    if (ranges.length > 0) return ranges;

    // "11th to 17th April 2026" or "11th-17th April"
    const re = /(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|[-–])\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
        const fromDay = parseInt(match[1], 10);
        const toDay = parseInt(match[2], 10);
        const monthKey = match[3].toLowerCase();
        const year = match[4] ? parseInt(match[4], 10) : fallbackYear ?? colomboCalendarYear();
        const month = MONTHS[monthKey];
        if (month !== undefined) {
            const from = `${year}-${String(month + 1).padStart(2, '0')}-${String(fromDay).padStart(2, '0')}`;
            const to = `${year}-${String(month + 1).padStart(2, '0')}-${String(toDay).padStart(2, '0')}`;
            ranges.push({ from, to });
        }
    }
    return ranges;
}

export function extractExclusionDays(text: string): Weekday[] {
    const days: Weekday[] = [];
    const excludeMatch = text.match(/exclude\s+(?:on\s+)?([^)]+)/i);
    if (excludeMatch) {
        const excludeText = excludeMatch[1].toLowerCase();
        for (const day of WEEKDAYS) {
            if (excludeText.includes(day)) days.push(day);
        }
    }
    return [...new Set(days)];
}

export function extractSpecificDates(text: string, fallbackYear?: number): string[] {
    // ISO date lists: "2026-07-18 & 2026-07-25"
    const isoDates = text.replace(/-{2,}/g, '-').match(/\b\d{4}-\d{1,2}-\d{1,2}\b/g);
    if (isoDates && isoDates.length >= 2) {
        return isoDates
            .map(d => {
                const [y, mo, da] = d.split('-');
                return `${y}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
            })
            .filter(isValidDateStr);
    }

    const defaultYear = extractYear(text) ?? fallbackYear ?? colomboCalendarYear();

    // Only the contiguous day-list phrase directly before each month counts —
    // scanning ALL digits before the month turns phone numbers into "dates".
    // A day token must not be a slice of a 4-digit year ("2026 & 1st January"
    // used to invent day 26). Global: "27th June & 25th July" is two months.
    const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december';
    const dayTok = '(?<!\\d)\\d{1,2}(?!\\d)(?:st|nd|rd|th)?';
    const phraseRe = new RegExp(
        `((?:${dayTok}\\s*(?:[,&]|and)\\s*)*${dayTok})\\s+(${monthNames})\\s*,?\\s*(20\\d{2})?`,
        'gi',
    );

    const phrases: Array<{ month: number; days: string[]; year: number | null }> = [];
    let phrase: RegExpExecArray | null;
    while ((phrase = phraseRe.exec(clean(text))) !== null) {
        const month = MONTHS[phrase[2].toLowerCase()];
        if (month === undefined) continue;
        const dayMatches = phrase[1].match(/(?<!\d)\d{1,2}(?!\d)/g) ?? [];
        const days = dayMatches.map(d => String(parseInt(d, 10)).padStart(2, '0'));
        if (days.length === 0) continue;
        phrases.push({
            month,
            days,
            year: phrase[3] ? parseInt(phrase[3], 10) : null,
        });
    }

    const years = assignSpecificDateYears(phrases, defaultYear);
    const dates: string[] = [];
    phrases.forEach((p, i) => {
        const year = years[i];
        for (const day of p.days) {
            dates.push(`${year}-${String(p.month + 1).padStart(2, '0')}-${day}`);
        }
    });

    return dates.filter(isValidDateStr);
}

/**
 * A missing year on a later January after a November/December date is the
 * next calendar year. Dates written in order with no year at all roll the
 * same way. A single trailing year ("27th June & 25th July 2026") is shared.
 */
function assignSpecificDateYears(
    phrases: Array<{ month: number; year: number | null }>,
    defaultYear: number,
): number[] {
    const explicit: Array<{ index: number; year: number }> = [];
    phrases.forEach((p, index) => {
        if (p.year !== null) explicit.push({ index, year: p.year });
    });

    if (explicit.length === 0) {
        let year = defaultYear;
        let prevMonth: number | null = null;
        return phrases.map(p => {
            if (prevMonth !== null && prevMonth >= 10 && p.month <= 2) year += 1;
            prevMonth = p.month;
            return year;
        });
    }

    return phrases.map((phrase, index) => {
        if (phrase.year !== null) return phrase.year;
        const next = explicit.find(e => e.index > index);
        const prev = [...explicit].reverse().find(e => e.index < index);
        if (next && phrase.month >= 10 && phrases[next.index].month <= 2) return next.year - 1;
        if (prev && phrases[prev.index].month >= 10 && phrase.month <= 2) return prev.year + 1;
        if (prev) return prev.year;
        if (next) return next.year;
        return defaultYear;
    });
}


export interface ParsePeriodOptions {
    fallbackYear?: number;
    today?: string;
    defaultPeriodType?: PeriodType;
    /** ISO date, or a human date such as BOC's "31 Dec 2026". */
    apiFrom?: string | null;
    /** ISO date, or a human date such as BOC's "31 Dec 2026". */
    apiTo?: string | null;
}

/** isValidDateStr accepts only YYYY-MM-DD. Bank fields like "31 Dec 2026" are normalized first. */
function coerceApiDate(value: string | null | undefined, fallbackYear: number): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (isValidDateStr(trimmed)) return trimmed;
    const human = parseHumanDate(trimmed, fallbackYear);
    return human && isValidDateStr(human) ? human : null;
}

function yearOf(iso: string): number {
    return parseInt(iso.slice(0, 4), 10);
}

function withYear(iso: string, year: number): string {
    const month = parseInt(iso.slice(5, 7), 10);
    const day = parseInt(iso.slice(8, 10), 10);
    const last = new Date(year, month, 0).getDate();
    const clamped = Math.min(day, last);
    return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function addYears(iso: string, delta: number): string {
    return withYear(iso, yearOf(iso) + delta);
}

function daysBetween(from: string, to: string): number {
    const [fy, fm, fd] = from.split('-').map(n => parseInt(n, 10));
    const [ty, tm, td] = to.split('-').map(n => parseInt(n, 10));
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function shorterForward(
    rolled: { from: string; to: string },
    swapped: { from: string; to: string },
): { from: string; to: string } {
    const rollDays = daysBetween(rolled.from, rolled.to);
    const swapDays = daysBetween(swapped.from, swapped.to);
    if (rollDays >= 0 && rollDays < swapDays) return rolled;
    return swapped;
}

/**
 * A missing year is filled from the side that wrote one. When that still
 * runs backwards, a short New Year wrap ("1 December 2026 to 15 January")
 * wins over swapping into a long range. Both years written and reversed
 * stay a typo swap ("31 August 2026 to 25 July 2026").
 */
function completeRangeYears(
    fromDate: string,
    toDate: string,
    fromHasYear: boolean,
    toHasYear: boolean,
): { from: string; to: string } {
    if (fromHasYear && !toHasYear) {
        const toInStartYear = withYear(toDate, yearOf(fromDate));
        if (toInStartYear >= fromDate) return { from: fromDate, to: toInStartYear };
        return shorterForward(
            { from: fromDate, to: addYears(toInStartYear, 1) },
            { from: toInStartYear, to: fromDate },
        );
    }
    if (!fromHasYear && toHasYear) {
        const fromInEndYear = withYear(fromDate, yearOf(toDate));
        if (fromInEndYear <= toDate) return { from: fromInEndYear, to: toDate };
        return shorterForward(
            { from: addYears(fromInEndYear, -1), to: toDate },
            { from: toDate, to: fromInEndYear },
        );
    }
    if (fromDate > toDate) {
        if (fromHasYear && toHasYear) return { from: toDate, to: fromDate };
        return shorterForward(
            { from: fromDate, to: addYears(toDate, 1) },
            { from: toDate, to: fromDate },
        );
    }
    return { from: fromDate, to: toDate };
}

function resolveRangeEndpoints(
    fromPart: string | null | undefined,
    toPart: string,
    fallbackYear: number,
): { fromDate: string | null; toDate: string | null } | null {
    const fromRaw = (fromPart ?? '').trim();
    const toRaw = toPart.trim();
    const toDate = parseHumanDate(toRaw, fallbackYear);
    if (!toDate) return null;

    const fromHasYear = /\b20\d{2}\b/.test(fromRaw);
    const toHasYear = /\b20\d{2}\b/.test(toRaw);
    let fromDate = fromRaw ? parseHumanDate(fromRaw, fallbackYear) : null;
    if (fromRaw && !fromDate) {
        const dayMatch = fromRaw.match(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)?$/i);
        if (dayMatch) {
            const [toYear, toMonth] = toDate.split('-');
            fromDate = `${toYear}-${toMonth}-${String(parseInt(dayMatch[1], 10)).padStart(2, '0')}`;
        }
    }
    if (fromDate) {
        const fixed = completeRangeYears(fromDate, toDate, fromHasYear, toHasYear);
        return { fromDate: fixed.from, toDate: fixed.to };
    }
    return { fromDate: null, toDate };
}

const DASH_LABEL_RE = /\b(booking(?:\s*&\s*(?:stay|travel))?|stay|travel(?:\s*-\s*stay)?)\s+periods?\s*[-–:]\s*/gi;

function dashLabelType(label: string): PeriodType {
    const key = label.toLowerCase();
    if (key.startsWith('booking')) return PeriodType.BOOKING;
    if (key.startsWith('stay')) return PeriodType.STAY;
    return PeriodType.TRAVEL;
}

/** Stay/Booking/Travel Period labels with a dash or colon, anywhere in the text. */
function splitDashLabeledPeriods(
    text: string,
    defaultType: PeriodType,
): Array<{ type: PeriodType; text: string }> | null {
    const markers: Array<{ type: PeriodType; index: number; length: number }> = [];
    const re = new RegExp(DASH_LABEL_RE.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        markers.push({ type: dashLabelType(match[1]), index: match.index, length: match[0].length });
    }
    if (markers.length === 0) return null;

    const parts: Array<{ type: PeriodType; text: string }> = [];
    if (markers[0].index > 0) {
        const before = text.slice(0, markers[0].index).trim();
        if (before) parts.push({ type: defaultType, text: before });
    }
    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index + markers[i].length;
        const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
        const sub = text.slice(start, end).trim();
        if (sub) parts.push({ type: markers[i].type, text: sub });
    }
    return parts.length > 0 ? parts : null;
}

export function parsePeriod(rawText: string, options: ParsePeriodOptions = {}): Validity[] {
    const {
        fallbackYear = colomboCalendarYear(),
        today = colomboCalendarDate(),
        defaultPeriodType = PeriodType.OFFER,
        apiFrom = null,
        apiTo = null,
    } = options;

    const apiFromIso = coerceApiDate(apiFrom, fallbackYear);
    const apiToIso = coerceApiDate(apiTo, fallbackYear);

    if (!rawText || rawText.trim().length === 0) {
        // Only API dates available
        const fromIsApi = Boolean(apiFromIso);
        let from: string | null = fromIsApi ? apiFromIso : today;
        let to = apiToIso;

        if (from && to && from > to) {
            if (!fromIsApi) {
                from = null;
            } else {
                const temp = from;
                from = to;
                to = temp;
            }
        }

        return [{
            validFrom: from,
            validTo: to,
            periodType: defaultPeriodType,
            recurrenceType: RecurrenceType.DAILY,
            recurrenceDays: null,
            timeWindow: null,
            exclusionDays: null,
            blackoutPeriods: null,
            exclusionNotes: null,
            rawPeriodText: rawText,
        }];
    }

    const cleaned = rawText.trim();

    // Stay / Booking / Travel labels are not only at the start. ComBank puts
    // "Stay Period – …" on its own bullet beside a different headline date.
    const dashParts = splitDashLabeledPeriods(cleaned, defaultPeriodType);
    if (dashParts && (dashParts.length > 1 || dashParts[0].text !== cleaned)) {
        const dated = dashParts.filter(part => looksDated(part.text));
        if (dated.length > 0) {
            return dated.flatMap(part => parsePeriod(part.text, { ...options, defaultPeriodType: part.type }));
        }
    }

    // Sub‑period labels (Offer period, Booking period, Installment period, etc.)
    // Only parts that actually contain date-like content become periods — HNB
    // modal text feeds the whole body here, so "Offer: 20% off ..." parts must
    // not turn into junk validity rows.
    const subPeriods = splitSubPeriods(cleaned);
    if (subPeriods.length > 1) {
        const dated = subPeriods.filter(sub => looksDated(sub.text));
        if (dated.length > 0) {
            return dated.flatMap(sub => parsePeriod(sub.text, { ...options, defaultPeriodType: sub.type }));
        }
    }
    // A single labeled sub-period ("Booking Period: 1st Jan to 28th Feb 2026")
    // keeps its label's type. Text differs from cleaned only when a label was
    // stripped, so this recursion terminates.
    if (subPeriods.length === 1 && subPeriods[0].text !== cleaned) {
        return parsePeriod(subPeriods[0].text, { ...options, defaultPeriodType: subPeriods[0].type });
    }

    // Blackout parentheticals: "(Black out Period: 11th to 17th April 2026)".
    // Extract them, then remove the segment so its inner range doesn't get
    // mistaken for the main offer range.
    let working = cleaned;
    let blackoutPeriods: DateRange[] = [];
    const blackoutMatch = working.match(/\(?\s*black\s*-?\s*out(?:\s+period)?\s*:?\s*([^)]*)\)?/i);
    if (blackoutMatch) {
        blackoutPeriods = extractBlackoutPeriods(blackoutMatch[1], fallbackYear);
        working = working.replace(blackoutMatch[0], ' ').replace(/\s+/g, ' ').trim();
    }

    // Multiple explicit ranges in one line:
    // "2026-07-01 to 2026-07-15 & 2026-08-01 to 2026-08-15"
    // "20th to 31st July 2026, 20th to 31st August 2026, 20th to 30th September 2026"
    // "On Thursdays from 02nd to 30th July 2026 and On Fridays from 03rd to 31st July 2026"
    // Each chunk keeps the text preceding its range so weekday context survives.
    const chunks: string[] = [];
    MULTI_RANGE_RE.lastIndex = 0;
    let prevEnd = 0;
    let rangeMatch: RegExpExecArray | null;
    while ((rangeMatch = MULTI_RANGE_RE.exec(working)) !== null) {
        chunks.push(
            working
                .slice(prevEnd, rangeMatch.index + rangeMatch[0].length)
                .replace(/^[\s,&|/]+/, '')
                .replace(/^and\s+/i, '')
                .trim(),
        );
        prevEnd = rangeMatch.index + rangeMatch[0].length;
    }
    if (chunks.length >= 2) {
        return chunks
            .flatMap(seg => parsePeriod(seg, { ...options, defaultPeriodType, apiFrom: null, apiTo: null }))
            .map(v => ({
                ...v,
                blackoutPeriods: blackoutPeriods.length > 0 ? blackoutPeriods : v.blackoutPeriods,
                rawPeriodText: cleaned,
            }));
    }

    // Specific date lists: "21st & 22nd March 2026", "06th and 20th July 2026",
    // "2026-07-18 & 2026-07-25". Percentages must NOT trigger this —
    // "35% off on weekdays & 30% off on weekends" is a rate split, not dates.
    if (/(?:&|\band\b)\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\b(?!\s*%))/.test(working)) {
        const specificDates = extractSpecificDates(working, fallbackYear);
        if (specificDates.length > 0) {
            return [{
                validFrom: specificDates[0],
                validTo: specificDates[specificDates.length - 1],
                periodType: defaultPeriodType,
                recurrenceType: RecurrenceType.SPECIFIC_DATES,
                recurrenceDays: specificDates,
                timeWindow: extractTimeWindow(working),
                exclusionDays: null,
                blackoutPeriods: blackoutPeriods.length > 0 ? blackoutPeriods : null,
                exclusionNotes: null,
                rawPeriodText: cleaned,
            }];
        }
    }

    // Monthly range "1st to 28th of each month", optionally with an outer
    // deadline: "Valid (5th to 10th of every month) until 2026-12-31"
    const monthly = extractMonthlyRange(working);
    if (monthly) {
        const tail = working.match(/\b(?:untill?|till)\s+([^)]+)$/i);
        // "till December 2026" (bare month+year, no day) means the LAST day
        // of that month, distinct from a day-bearing tail like "till 31st
        // December 2026" which parseHumanDate already handles directly.
        const monthlyTo = tail ? (parseHumanDate(tail[1], fallbackYear) ?? parseMonthEndDate(tail[1], fallbackYear)) : null;
        const resolvedTo = monthlyTo ?? apiToIso;
        const resolvedFrom = (resolvedTo && today > resolvedTo) ? null : today;
        return [{
            validFrom: resolvedFrom,
            validTo: resolvedTo,
            periodType: defaultPeriodType,
            recurrenceType: RecurrenceType.MONTHLY_RANGE,
            recurrenceDays: [`${monthly.fromDay}-${monthly.toDay}`],
            timeWindow: extractTimeWindow(working),
            exclusionDays: null,
            blackoutPeriods: blackoutPeriods.length > 0 ? blackoutPeriods : null,
            exclusionNotes: null,
            rawPeriodText: cleaned,
        }];
    }

    // Date range: "from X to Y", "till X", "X - Y", etc.
    // Time windows ("from 3pm to 9pm only") are removed first so their "to"
    // doesn't hijack the range split, and a leading "Valid Until/From/On" card
    // prefix is dropped.
    const rangeText = removeTimeWindows(working).replace(/^\s*valid\s+/i, '').trim();

    let fromDate: string | null = null;
    let toDate: string | null = null;

    // Priority 1: Explicit "\bfrom <date> to <date>" within the text
    const explicitFromTo = rangeText.match(/\bfrom\s+([A-Za-z0-9\s,.-]+?)(?<!\bup)\s+(?:to|ti|untill?|till)\s+([A-Za-z0-9\s,.-]+?)(?:\s*(?:\*|conditions|for\b|\.|$|\())/i);
    if (explicitFromTo) {
        const resolved = resolveRangeEndpoints(explicitFromTo[1], explicitFromTo[2], fallbackYear);
        if (resolved) {
            fromDate = resolved.fromDate;
            toDate = resolved.toDate;
        }
    }

    // Priority 2: Explicit "period / validity / dates: <from> to <to>"
    if (!toDate) {
        const periodMatch = rangeText.match(/\b(?:period|validity|dates?)\s*[:–-]?\s*([A-Za-z0-9\s,.-]+?)(?<!\bup)\s+(?:to|ti|untill?|till|[-–])\s+([A-Za-z0-9\s,.-]+?)(?:\s*(?:\(|$|\.|\*))/i);
        if (periodMatch) {
            const resolved = resolveRangeEndpoints(periodMatch[1], periodMatch[2], fallbackYear);
            if (resolved) {
                fromDate = resolved.fromDate;
                toDate = resolved.toDate;
            }
        }
    }

    // Priority 3: Compact date range "8th to 15th Dec 2025" or "01st September to 30th November 2026".
    // The start side keeps its own year ("1st December 2026 to 15th January").
    if (!toDate) {
        const compactMatch = rangeText.match(/\b(\d{1,2}(?:st|nd|rd|th)?(?:\s+[a-z]+)?(?:\s+\d{4})?)\s+(?:to|ti|untill?|till|[-–])\s+(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+(?:\s+\d{4})?)/i);
        if (compactMatch) {
            const resolved = resolveRangeEndpoints(compactMatch[1], compactMatch[2], fallbackYear);
            if (resolved) {
                fromDate = resolved.fromDate;
                toDate = resolved.toDate;
            }
        }
    }

    // Priority 4: General range split "X to Y" / "X - Y"
    if (!toDate) {
        let m = rangeText.match(/^from\s+(.+?)(?<!\bup)\s+(?:to|ti|untill?|till)\s+(.+)/i) ||
                rangeText.match(/^(.+?)(?<!\b(?:up|upto|open|subject|prior|due|refer|listen|relate|applicable|entitled|access|welcome|switch|add|applied|exclusive))\s+(?:to|ti|untill?|till)\s+(.+)/i) ||
                rangeText.match(/^(.+?)\s*[-–]\s*(.+)/i);

        if (!m) {
            // Not only at the start: PABC hotel copy ends with "until 31 October 2026".
            const tillMatch = rangeText.match(/\b(?:untill?|till)\s+(.+)/i);
            if (tillMatch) {
                m = [rangeText, '', tillMatch[1]] as RegExpMatchArray;
            }
        }

        if (m && m[2]) {
            const resolved = resolveRangeEndpoints(m[1] ?? '', m[2], fallbackYear);
            if (resolved) {
                fromDate = resolved.fromDate;
                toDate = resolved.toDate;
            } else {
                toDate = parseHumanDate(rangeText, fallbackYear);
            }
        } else {
            if (/month\s*end/i.test(rangeText)) {
                const monthMatch = rangeText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)/i);
                const todayMonth = /^\d{4}-\d{2}-\d{2}$/.test(today) ? parseInt(today.slice(5, 7), 10) - 1 : parseInt(colomboCalendarDate().slice(5, 7), 10) - 1;
                const month = monthMatch ? MONTHS[monthMatch[1].toLowerCase()] : todayMonth;
                const year = extractYear(rangeText) ?? fallbackYear;
                const lastDay = new Date(year, month + 1, 0).getDate();
                toDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            } else {
                toDate = parseHumanDate(rangeText, fallbackYear);
            }
        }
    }

    // "Valid on 01st August 2026" / "Valid only on 31st July 2026" is that
    // calendar day, not an open interval from the scrape date through it.
    // "until/till/before/from" stays an open start (validFrom falls back to today).
    const isPointDate =
        !fromDate &&
        !!toDate &&
        /\bon\b/i.test(rangeText) &&
        !/\b(?:until|untill|till|before|from)\b/i.test(rangeText);
    if (isPointDate) {
        fromDate = toDate;
    }

    let fromIsFallback = false;

    // If we have API dates, fill gaps. Make sure they are valid.
    if (!fromDate) {
        if (apiFromIso) {
            fromDate = apiFromIso;
        } else {
            fromDate = today;
            fromIsFallback = true;
        }
    }

    if (!toDate && apiToIso) toDate = apiToIso;

    // Reconcile with authoritative apiTo if available
    if (apiToIso) {
        if (!toDate) {
            toDate = apiToIso;
        } else if (!fromIsFallback && fromDate && toDate < fromDate && apiToIso >= fromDate) {
            // Parser inverted or extracted earlier date, but apiTo is valid and matches fromDate
            toDate = apiToIso;
        }
    }

    // Validate extracted dates
    if (fromDate && !isValidDateStr(fromDate)) {
        fromDate = today;
        fromIsFallback = true;
    }
    if (toDate && !isValidDateStr(toDate)) toDate = null;

    // Swap if from > to (but don't swap if fromDate is just the fallback today, meaning it's an expired offer)
    if (fromDate && toDate && fromDate > toDate && !fromIsFallback) {
        const temp = fromDate;
        fromDate = toDate;
        toDate = temp;
    } else if (fromIsFallback && toDate && fromDate && fromDate > toDate) {
        // Fallback "today" post-dates the offer's expiry — do not invent a start date
        // in the future for an already-expired offer; leave validFrom null.
        fromDate = null;
    }

    const recurrenceDays = extractRecurrenceDays(working);
    const timeWindow = extractTimeWindow(working);
    const exclusionDays = extractExclusionDays(working);

    const recurrenceType: RecurrenceType =
        recurrenceDays.length > 0 ? RecurrenceType.SPECIFIC_WEEKDAYS : RecurrenceType.DAILY;

    return [{
        validFrom: fromDate,
        validTo: toDate,
        periodType: defaultPeriodType,
        recurrenceType,
        recurrenceDays: recurrenceDays.length > 0 ? recurrenceDays : null,
        timeWindow,
        exclusionDays: exclusionDays.length > 0 ? exclusionDays : null,
        blackoutPeriods: blackoutPeriods.length > 0 ? blackoutPeriods : null,
        exclusionNotes: null,
        rawPeriodText: cleaned,
    }];
}

// Two or more of these in one line means the offer has multiple discrete ranges.
const MULTI_RANGE_RE =
    /\b\d{4}-\d{1,2}-\d{1,2}\s*(?:to|till|[-–])\s*\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s*(?:[A-Za-z]{3,}\s+)?(?:to\s|[-–])\s*\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,}(?:\s+\d{4})?/gi;

const MONTH_NAMES_RE = new RegExp(`\\b(?:${Object.keys(MONTHS).join('|')})\\b`, 'i');

/** Does this text fragment contain anything that could be a date? */
function looksDated(text: string): boolean {
    return /\b20\d{2}\b/.test(text) ||
        /\d{4}-\d{1,2}-\d{1,2}/.test(text) ||
        MONTH_NAMES_RE.test(text) ||
        /\b(?:each|every)\s+month\b/i.test(text) ||
        /month\s*end/i.test(text);
}

/** Strip "3pm to 9pm" / "10:00 AM – 9:00 PM" / "6:00-7:00 PM" windows so their "to" doesn't split the date range. */
function removeTimeWindows(text: string): string {
    return text.replace(/\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*(?:to|till|[-–—|])\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)/gi, ' ');
}

function splitSubPeriods(text: string): Array<{ type: PeriodType; text: string }> {
    const markers: Array<{ type: PeriodType; index: number; length: number }> = [];
    for (const { pattern, type } of RECURRENCE_LABEL_PATTERNS) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            markers.push({ type, index: match.index, length: match[0].length });
        }
    }
    if (markers.length === 0) return [{ type: PeriodType.OFFER, text }];

    markers.sort((a, b) => a.index - b.index);
    const parts: Array<{ type: PeriodType; text: string }> = [];

    for (let i = 0; i < markers.length; i++) {
        const start = markers[i].index + markers[i].length;
        const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
        const sub = text.substring(start, end).trim();
        if (sub.length > 0) {
            parts.push({ type: markers[i].type, text: sub });
        }
    }

    // If there's text before the first marker, treat as default offer period
    if (markers[0].index > 0) {
        const before = text.substring(0, markers[0].index).trim();
        if (before.length > 2) {
            parts.unshift({ type: PeriodType.OFFER, text: before });
        }
    }

    return parts;
}
