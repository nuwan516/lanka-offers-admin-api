import { Offer, OfferDetails, Merchant, CardEligibility, TransactionRange, InstallmentPlan, ImageInfo, PeriodType } from '@/core/types/offers';
import { parsePeriod } from '@/parsing/period/period-engine';
import { AddressEngine } from '@/parsing/address/address-engine';
import { stripHtml } from '@/parsing/text/html';
import { applyRegexRule, applyKeywordRule, applyTransactionRule } from '@/banks/bank-rules-loader';
import * as crypto from 'crypto';

const addressEngine = new AddressEngine({ country: 'Sri Lanka' });

export interface HNBDetailResponse {
    id: string;
    title: string;
    from: string;        // e.g., "2026-01-01"
    to: string;          // e.g., "2026-12-31"
    cardType: string;
    content: string;     // HTML with offer details
    thumb?: string;      // Thumbnail image path
    assets?: unknown[];
}

export interface HNBListItem {
    id: string;
    title: string;
    from: string;
    to: string;
    cardType: string;
    categoryName?: string;
    categoryId?: number;
    // ... other minimal fields
}

/**
 * Parse an HNB detail API response into a complete Offer.
 * @param id - The item ID from the list
 * @param detailResponse - The JSON from get_web_card_promo
 * @param categoryName - Name of the category (e.g., 'Hotel')
 * @param categoryId - Category ID
 */
export function parseHNBDetail(
    id: string,
    detailResponse: HNBDetailResponse | Record<string, any>,
    categoryName: string,
    categoryId: number
): Offer | null {
    const rawObj = detailResponse as Record<string, any>;
    const title = rawObj.title ?? '';
    const from = rawObj.from ?? '';
    const to = rawObj.to ?? '';
    const cardType = rawObj.cardType ?? '';
    const content = rawObj.content ?? rawObj.rawHtml ?? '';

    // Strip HTML for text extraction
    const plainText = stripHtml(content);

    // 1. Merchant info
    const merchant = extractMerchant(plainText, title);

    // 1.5 Rule evaluation context for runtime dynamic rules (source_path, category, sourceType)
    const ruleContext = {
        bank: 'hnb',
        field: '',
        category: categoryName,
        sourceType: 'rest-api',
        rawOffer: detailResponse as unknown as Record<string, unknown>,
    };

    // 2. Offer details
    const offer = extractOfferDetails(plainText, title, ruleContext);

    // 3. Validity periods
    const validityPeriods = parsePeriod(plainText, {
        apiFrom: from,
        apiTo: to,
        defaultPeriodType: PeriodType.OFFER,
    });

    // 4. Card eligibility
    const cardEligibility = extractCardEligibility(plainText, cardType, ruleContext);

    // 5. Transaction range
    const transactionRange = extractTransactionRange(plainText, ruleContext);

    // 6. Installment plans
    const installmentPlans = extractInstallmentPlans(plainText);

    // 7. Images (from content HTML + thumb)
    const images = extractImages(content, rawObj.thumb);

    // 8. Unique ID
    const uniqueId = `hnb_${id}`;

    // 9. Source URL
    const sourceUrl = `https://venus.hnb.lk/api/get_web_card_promo?id=${id}`;

    return {
        uniqueId,
        source: 'hnb',
        sourceId: id,
        sourceUrl,
        title,
        category: categoryName,
        categoryId,
        cardType: cardEligibility.cardTypes.length > 0 ? cardEligibility.cardTypes.join(', ') : cardType,
        scrapedAt: new Date().toISOString(),
        merchant,
        offer,
        installmentPlans,
        transactionRange,
        cardEligibility,
        images,
        validityPeriods,
        contentHash: generateContentHash(title, plainText),
        rawHtml: content,
    };
}

// ─── Private extraction helpers ──────────────────────

function extractMerchant(plainText: string, title: string): Merchant {
    let name = title;
    // Look for explicit Merchant: block (require General Terms so we don't truncate on e.g. "General Corporation")
    const merchantMatch = plainText.match(/Merchant\s*:\s*([^\n]+?)(?=\s*(?:Offer|Period|Eligibility|Contact|Location|Special|General\s+Terms|$))/i);
    if (merchantMatch) {
        name = merchantMatch[1].trim()
            .replace(/^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/g, '')
            .replace(/&amp;/g, '&');
    } else {
        // High-confidence pattern in title: at <Merchant>, with <Merchant>, @ <Merchant>
        const atMatch = title.match(/\b(?:at|@|with)\s+([A-Z0-9][A-Za-z0-9'&.\s-]{2,50})(?:\s*\(|$|\s+for|\s+on|\s*-\s*)/);
        if (atMatch) {
            const candidate = atMatch[1].trim().replace(/\s+(?:outlets?|branches?)$/i, '');
            if (!/^(?:all|selected|participating|any|our|hnb)\b/i.test(candidate) && candidate.length > 1) {
                name = candidate;
            }
        }
    }

    const addresses = addressEngine.extract(plainText, name);
    const phone = extractPhones(plainText);
    const email = extractEmails(plainText);
    const website = extractWebsite(plainText);

    let location: string | null = null;
    const locMatch = plainText.match(/Locations?\s*:\s*([^\n]+?)(?=\s*(?:Special|General|Additional|$))/i);
    if (locMatch) {
        location = locMatch[1].trim().replace(/^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/g, '');
    } else if (addresses.length > 0) {
        const addrCandidate = addresses[0].split(',')[0].trim();
        if (addrCandidate.toLowerCase() !== name.toLowerCase() && addrCandidate.toLowerCase() !== title.toLowerCase()) {
            location = addrCandidate;
        }
    }

    return {
        name,
        location,
        addresses,
        phone,
        email,
        website,
        logo: null,
    };
}

function extractOfferDetails(plainText: string, title?: string, context?: Record<string, unknown>): OfferDetails {
    // Offer text usually after "Offer:" or just the first meaningful paragraph
    const offerMatch = plainText.match(/Offer:\s*(.+?)(?=\s*(?:Period|Eligibility|Contact|Location|Special|General|$))/is);
    const description = offerMatch ? offerMatch[1].trim() : plainText;

    const discountRaw = applyRegexRule('hnb', 'discount_pct', plainText, /(\d+(?:\.\d+)?)\s*%/, context);
    const discountPercentage = discountRaw ? parseFloat(discountRaw) : null;

    const applicableCards: string[] = [];
    if (/credit\s+card/i.test(plainText)) applicableCards.push('Credit Card');
    if (/debit\s+card/i.test(plainText)) applicableCards.push('Debit Card');

    const bookingRequired = applyKeywordRule('hnb', 'booking_required', plainText, /reservation|booking|advance\s+booking/i, context);
    const fullText = title ? `${title} ${plainText}` : plainText;
    const isUpTo = /\b(?:up\s*-?\s*to|upto)\s+\d+%/i.test(fullText);
    const restrictions = [];
    if (/cannot be combined/i.test(plainText)) restrictions.push('Cannot be combined with other offers');
    if (/subject to availability/i.test(plainText)) restrictions.push('Subject to availability');
    if (isUpTo) restrictions.push('Discount is "up to" the stated percentage, may vary by item/venue');

    // Special & general terms extracted simply (could be improved)
    const specialConditions: string[] = [];
    const generalTerms: string[] = [];

    return {
        description,
        discountPercentage,
        applicableCards,
        bookingRequired,
        restrictions,
        specialConditions,
        generalTerms,
    };
}

function extractCardEligibility(plainText: string, cardTypeFromApi: string, context?: Record<string, unknown>): CardEligibility {
    const includedCards: string[] = [];
    const excludedCards: string[] = [];
    const cardTypes: string[] = [];
    const networks: string[] = [];
    const restrictions: string[] = [];

    if (cardTypeFromApi) {
        // The API field often contains comma-separated card names
        const rawTokens = cardTypeFromApi.split(',').map(s => s.trim()).filter(Boolean);
        for (const token of rawTokens) {
            // Filter out generic card type tokens from includedCards so specific product tiers aren't polluted
            if (/^(?:credit|debit|credit\s*(?:\/|&)\s*debit|all\s+cards?|cards?)(?:\s+cards?)?$/i.test(token)) {
                continue;
            }
            includedCards.push(token);
        }
    }

    if (applyKeywordRule('hnb', 'card_types', `${cardTypeFromApi} ${plainText}`, /credit/i, context)) cardTypes.push('Credit Card');
    if (/debit/i.test(cardTypeFromApi) || /debit/i.test(plainText)) cardTypes.push('Debit Card');
    
    // Only extract network if it's prominently mentioned in the offer details, not the boilerplate
    const nonBoilerplate = plainText.split(/General Terms/i)[0];
    const networkSource = `${cardTypeFromApi} ${nonBoilerplate}`;
    if (/visa/i.test(networkSource)) networks.push('Visa');
    if (/mastercard|master\s+card/i.test(networkSource)) networks.push('Mastercard');
    if (/amex|american express/i.test(networkSource)) networks.push('Amex');

    // Specific luxury tier mentions in non-boilerplate offer text
    if (/\b(?:HNB\s+)?Visa\s+Signature\b/i.test(nonBoilerplate)) includedCards.push('Visa Signature');
    if (/\b(?:HNB\s+)?Visa\s+Infinite\b/i.test(nonBoilerplate)) includedCards.push('Visa Infinite');
    if (/\bWorld\s+Mastercard\b/i.test(nonBoilerplate)) includedCards.push('World Mastercard');

    const exceptMatch = plainText.match(/\(except\s+([^)]+)\)/i);
    if (exceptMatch) {
        const cleaned = exceptMatch[1].replace(/&amp;/gi, '&');
        const rawTokens = cleaned
            .split(/,\s*|\s*&\s*|\s+and\s+/i)
            .map(c => c.trim())
            .filter(c => c.length > 0 && !/^(?:and|or|cards?)$/i.test(c));
        excludedCards.push(...rawTokens);
        restrictions.push(`Except: ${cleaned.trim()}`);
    }

    return {
        includedCards: [...new Set(includedCards)],
        excludedCards: [...new Set(excludedCards)],
        cardTypes: [...new Set(cardTypes)],
        networks: [...new Set(networks)],
        restrictions,
    };
}

function extractTransactionRange(plainText: string, context?: Record<string, unknown>): TransactionRange {
    const minFallback = /(?:minimum|min)\s+(?:bill|spend|transaction)(?:\s+value)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[:-]?\s*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i;
    const maxFallback = /(?:maximum|max)\s+(?:bill|transaction|discount)(?:\s+value)?(?:\s+at\s+[^.]+)?(?:\s+is|\s+of)?\s*[:-]?\s*(?:Rs\.?|LKR)?\s*([\d,]+)(?:\/-)?/i;
    const txMin = applyTransactionRule('hnb', 'transaction_min', plainText, minFallback, context);
    const txMax = applyTransactionRule('hnb', 'transaction_max', plainText, maxFallback, context);
    if (txMin !== null || txMax !== null) return { min: txMin, max: txMax, currency: 'LKR' };

    const rangeMatch = plainText.match(/(?:Rs\.?|LKR)\s*([\d,.]+(?:\s*(?:Million|Lakh|Mn|k|m))?)\s*(?:to|[-–])\s*(?:Rs\.?|LKR)?\s*([\d,.]+(?:\s*(?:Million|Lakh|Mn|k|m))?)/i);
    if (rangeMatch) {
        let min = parseAmount(rangeMatch[1]);
        let max = parseAmount(rangeMatch[2]);
        if (min !== null && max !== null && min > max) { const temp = min; min = max; max = temp; }
        return { min, max, currency: 'LKR' };
    }
    return { min: null, max: null, currency: 'LKR' };
}

function extractInstallmentPlans(plainText: string): InstallmentPlan[] {
    const plans: InstallmentPlan[] = [];
    const match = plainText.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\s*,\s*\d+)*(?:\s*&\s*\d+)?)\s*months/i);
    if (match) {
        const interest = parseFloat(match[1]);
        const months = match[2].replace(/&/g, ',').split(',').map(m => parseInt(m, 10));
        months.forEach(m => plans.push({ months: m, interestRate: interest, type: 'installment' }));
    }
    return plans;
}

function extractImages(html: string, thumb?: string): { logo: ImageInfo | null; gallery: ImageInfo[]; images: ImageInfo[] } {
    const images: ImageInfo[] = [];
    
    // Add thumbnail as the logo if available
    let logo: ImageInfo | null = null;
    if (thumb) {
        // Handle relative URLs for thumbnails
        const thumbUrl = thumb.startsWith('http') ? thumb : `https://www.hnb.lk/${thumb.replace(/^\/+/, '')}`;
        logo = { url: thumbUrl, alt: 'thumbnail', type: 'logo' };
        images.push(logo);
    }

    // simple regex to find img tags
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["']/gi;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
        let url = match[1];
        if (url.startsWith('//')) url = 'https:' + url;
        images.push({ url, alt: match[2], type: 'gallery' });
    }
    
    // If no explicit thumb, use the first gallery image as logo
    if (!logo && images.length > 0) {
        logo = { ...images[0], type: 'logo' as const };
    }
    
    return { logo, gallery: images.filter(i => i.type !== 'logo'), images };
}

function extractPhones(plainText: string): string[] {
    const phones: string[] = [];
    const phoneMatch = plainText.match(/(?:Contact(?:\s+No)?|Tel|Phone|Reservations?)\s*:\s*([^a-zA-Z]{5,})/i);
    if (phoneMatch) {
        const numsText = phoneMatch[1].replace(/[\s-]/g, '');
        const individual = numsText.match(/(?:\+94|0)\d{9}/g);
        if (individual) {
            individual.forEach(num => {
                phones.push(num.startsWith('94') ? `0${num.substring(2)}` : num);
            });
        }
    }
    return [...new Set(phones)];
}

function extractEmails(plainText: string): string[] {
    const emails = plainText.match(/[\w.-]+@[\w.-]+\.\w+/g);
    return emails ? [...new Set(emails)] : [];
}

function extractWebsite(plainText: string): string | null {
    const match = plainText.match(/(?:Website|Web)\s*:\s*(https?:\/\/[^\s]+)/i);
    return match ? match[1] : null;
}

function parseAmount(str: string): number | null {
    const num = parseFloat(str.replace(/[^\d.]/g, ''));
    if (isNaN(num)) return null;
    
    if (/million|mn|m/i.test(str)) {
        return num * 1_000_000;
    }
    if (/lakh/i.test(str)) {
        return num * 100_000;
    }
    if (/k/i.test(str)) {
        return num * 1_000;
    }
    return num;
}

function generateContentHash(title: string, plainText: string): string {
    return crypto.createHash('sha256').update(`${title}|${plainText}`).digest('hex');
}
