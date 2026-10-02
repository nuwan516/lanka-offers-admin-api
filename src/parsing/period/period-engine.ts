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
        `(\\d{1,2})(?!\\d)\\s+(${monthNames})\\s*(\\d{4})?|(${monthNames})\\s+(\\d{1,2})(?!\\d)(?:,)?\\s*(\\d{4})?`,
        'i'
    );
    m = cleaned.match(regex);
    if (!m) return null;

    let day: string, month: number, year: number;
    if (m[1]) {
        // DD Month YYYY
        day = String(parseInt(m[1], 10)).padStart(2, '0');
        month = MONTHS[m[2].toLowerCase()];
        year = m[3] ? parseInt(m[3], 10) : fallbackYear ?? new Date().getFullYear();
    } else {
        // Month DD YYYY
        month = MONTHS[m[4].toLowerCase()];
        day = String(parseInt(m[5], 10)).padStart(2, '0');
        year = m[6] ? parseInt(m[6], 10) : fallbackYear ?? new Date().getFullYear();
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
    const year = m[2] ? parseInt(m[2], 10) : fallbackYear ?? new Date().getFullYear();
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
        const year = match[4] ? parseInt(match[4], 10) : fallbackYear ?? new Date().getFullYear();
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

    const year = extractYear(text) ?? fallbackYear ?? new Date().getFullYear();

    // Only the contiguous day-list phrase directly before each month counts —
    // scanning ALL digits before the month turns phone numbers into "dates".
    // Global: "27th June & 25th July" carries dates in two different months.
    const monthNames = 'january|february|march|april|may|june|july|august|september|october|november|december';
    const phraseRe = new RegExp(
        `((?:\\d{1,2}(?:st|nd|rd|th)?\\s*(?:[,&]|and)\\s*)*\\d{1,2}(?:st|nd|rd|th)?)\\s+(${monthNames})`,
        'gi',
    );

    const dates: string[] = [];
    let phrase: RegExpExecArray | null;
    while ((phrase = phraseRe.exec(clean(text))) !== null) {
        const month = MONTHS[phrase[2].toLowerCase()];
        if (month === undefined) continue;
        const dayMatches = phrase[1].match(/\d{1,2}/g) ?? [];
        for (const d of dayMatches) {
            const day = String(parseInt(d, 10)).padStart(2, '0');
            dates.push(`${year}-${String(month + 1).padStart(2, '0')}-${day}`);
        }
    }

    return dates.filter(isValidDateStr);
}


export interface ParsePeriodOptions {
    fallbackYear?: number;
    today?: string;
    defaultPeriodType?: PeriodType;
    apiFrom?: string | null;   // YYYY-MM-DD from API
    apiTo?: string | null;     // YYYY-MM-DD from API
}

export function parsePeriod(rawText: string, options: ParsePeriodOptions = {}): Validity[] {
    const {
        fallbackYear = new Date().getFullYear(),
        today = new Date().toISOString().split('T')[0],
        defaultPeriodType = PeriodType.OFFER,
        apiFrom = null,
        apiTo = null,
    } = options;

    if (!rawText || rawText.trim().length === 0) {
        // Only API dates available
        const fromIsApi = Boolean(apiFrom && apiFrom.length >= 10 && isValidDateStr(apiFrom));
        let from: string | null = fromIsApi ? apiFrom! : today;
        let to = null;
        if (apiTo && apiTo.length >= 10 && isValidDateStr(apiTo)) {
            to = apiTo;
        }

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

    // Dash-form labels (NDB): "Booking Period - Until 31st July 2026",
    // "Booking & Stay Period - Until 30th November 2026". Anchored, so prose
    // is never affected; the label is consumed before recursing.
    const dashLabel = cleaned.match(/^\s*(booking(?:\s*&\s*(?:stay|travel))?|stay|travel(?:\s*-\s*stay)?)\s+periods?\s*[-–:]\s*(?=\S)/i);
    if (dashLabel) {
        const label = dashLabel[1].toLowerCase();
        const type = label.startsWith('booking')
            ? PeriodType.BOOKING
            : label.startsWith('stay') ? PeriodType.STAY : PeriodType.TRAVEL;
        return parsePeriod(cleaned.slice(dashLabel[0].length), { ...options, defaultPeriodType: type });
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
        const resolvedTo = monthlyTo ?? (isValidDateStr(apiTo) ? apiTo : null);
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
        const fp = explicitFromTo[1].trim();
        const tp = explicitFromTo[2].trim();
        const td = parseHumanDate(tp, fallbackYear);
        if (td) {
            toDate = td;
            fromDate = parseHumanDate(fp, fallbackYear);
            if (!fromDate) {
                const dayMatch = fp.match(/\b(\d{1,2})(?:st|nd|rd|th)?$/i);
                if (dayMatch) {
                    const [toYear, toMonth] = toDate.split('-');
                    fromDate = `${toYear}-${toMonth}-${String(parseInt(dayMatch[1])).padStart(2, '0')}`;
                }
            }
        }
    }

    // Priority 2: Explicit "period / validity / dates: <from> to <to>"
    if (!toDate) {
        const periodMatch = rangeText.match(/\b(?:period|validity|dates?)\s*[:–-]?\s*([A-Za-z0-9\s,.-]+?)(?<!\bup)\s+(?:to|ti|untill?|till|[-–])\s+([A-Za-z0-9\s,.-]+?)(?:\s*(?:\(|$|\.|\*))/i);
        if (periodMatch) {
            const fp = periodMatch[1].trim();
            const tp = periodMatch[2].trim();
            const td = parseHumanDate(tp, fallbackYear);
            if (td) {
                toDate = td;
                fromDate = parseHumanDate(fp, fallbackYear);
                if (!fromDate) {
                    const dayMatch = fp.match(/\b(\d{1,2})(?:st|nd|rd|th)?$/i);
                    if (dayMatch) {
                        const [toYear, toMonth] = toDate.split('-');
                        fromDate = `${toYear}-${toMonth}-${String(parseInt(dayMatch[1])).padStart(2, '0')}`;
                    }
                }
            }
        }
    }

    // Priority 3: Compact date range "8th to 15th Dec 2025" or "01st September to 30th November 2026"
    if (!toDate) {
        const compactMatch = rangeText.match(/\b(\d{1,2}(?:st|nd|rd|th)?(?:\s+[a-z]+)?)\s+(?:to|ti|untill?|till|[-–])\s+(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+(?:\s+\d{4})?)/i);
        if (compactMatch) {
            const fp = compactMatch[1].trim();
            const tp = compactMatch[2].trim();
            const td = parseHumanDate(tp, fallbackYear);
            if (td) {
                toDate = td;
                fromDate = parseHumanDate(fp, fallbackYear);
                if (!fromDate) {
                    const dayMatch = fp.match(/\b(\d{1,2})(?:st|nd|rd|th)?$/i);
                    if (dayMatch) {
                        const [toYear, toMonth] = toDate.split('-');
                        fromDate = `${toYear}-${toMonth}-${String(parseInt(dayMatch[1])).padStart(2, '0')}`;
                    }
                }
            }
        }
    }

    // Priority 4: General range split "X to Y" / "X - Y"
    if (!toDate) {
        let m = rangeText.match(/^from\s+(.+?)(?<!\bup)\s+(?:to|ti|untill?|till)\s+(.+)/i) ||
                rangeText.match(/^(.+?)(?<!\b(?:up|upto|open|subject|prior|due|refer|listen|relate|applicable|entitled|access|welcome|switch|add|applied|exclusive))\s+(?:to|ti|untill?|till)\s+(.+)/i) ||
                rangeText.match(/^(.+?)\s*[-–]\s*(.+)/i);

        if (!m) {
            const tillMatch = rangeText.match(/^(?:untill?|till)\s+(.+)/i);
            if (tillMatch) {
                m = [rangeText, '', tillMatch[1]] as RegExpMatchArray;
            }
        }

        if (m && m[2]) {
            const fromPart = m[1]?.trim();
            const toPart = m[2].trim();
            fromDate = fromPart ? parseHumanDate(fromPart, fallbackYear) : null;
            toDate = parseHumanDate(toPart, fallbackYear);
            if (fromPart && !fromDate && toDate) {
                const dayMatch = fromPart.match(/\b(\d{1,2})(?:st|nd|rd|th)?$/i);
                if (dayMatch) {
                    const [toYear, toMonth] = toDate.split('-');
                    fromDate = `${toYear}-${toMonth}-${String(parseInt(dayMatch[1])).padStart(2, '0')}`;
                }
            }
            if (!fromDate && !toDate) {
                toDate = parseHumanDate(rangeText, fallbackYear);
            }
        } else {
            if (/month\s*end/i.test(rangeText)) {
                const monthMatch = rangeText.match(/(january|february|march|april|may|june|july|august|september|october|november|december)/i);
                const month = monthMatch ? MONTHS[monthMatch[1].toLowerCase()] : new Date().getMonth();
                const year = extractYear(rangeText) ?? fallbackYear;
                const lastDay = new Date(year, month + 1, 0).getDate();
                toDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            } else {
                toDate = parseHumanDate(rangeText, fallbackYear);
            }
        }
    }

    let fromIsFallback = false;

    // If we have API dates, fill gaps. Make sure they are valid.
    if (!fromDate) {
        if (isValidDateStr(apiFrom)) {
            fromDate = apiFrom!;
        } else {
            fromDate = today;
            fromIsFallback = true;
        }
    }

    if (!toDate && isValidDateStr(apiTo)) toDate = apiTo!;

    // Reconcile with authoritative apiTo if available
    if (isValidDateStr(apiTo)) {
        if (!toDate) {
            toDate = apiTo!;
        } else if (!fromIsFallback && fromDate && toDate < fromDate && apiTo! >= fromDate) {
            // Parser inverted or extracted earlier date, but apiTo is valid and matches fromDate
            toDate = apiTo!;
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
