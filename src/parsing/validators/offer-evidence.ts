import { Offer } from '@/core/types/offers';
import { EvidenceSnippet } from '@/llm/schemas/offer-validation.schema';

/**
 * Normalizes text for comparison and token matching:
 * lowercase, stripped punctuation, normalized whitespace.
 */
export function normalizeEvidenceText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts non-stopword tokens (length >= 2).
 */
export function extractSignificantTokens(text: string): Set<string> {
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'all', 'any', 'per', 'are', 'this',
    'that', 'has', 'have', 'had', 'not', 'but', 'will', 'can', 'may', 'via',
    'under', 'over', 'into', 'out', 'onto', 'upon', 'about', 'after', 'before',
  ]);

  const normalized = normalizeEvidenceText(text);
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Builds a structured, non-destructive evidence inventory from an extracted Offer.
 * Assigns stable evidence IDs (e.g. `ev-title`, `ev-desc`, `ev-term-1`, etc.)
 */
export function buildOfferEvidenceSnippets(offer: Offer, rawTextOverride?: string | null): EvidenceSnippet[] {
  const snippets: EvidenceSnippet[] = [];

  if (offer.title && offer.title.trim().length > 0) {
    snippets.push({
      id: 'ev-title',
      sourceField: 'title',
      text: offer.title.trim(),
    });
  }

  if (offer.offer?.description && offer.offer.description.trim().length > 0) {
    snippets.push({
      id: 'ev-desc',
      sourceField: 'description',
      text: offer.offer.description.trim(),
    });
  }

  // Terms and conditions
  let termIdx = 1;
  for (const term of offer.offer?.restrictions ?? []) {
    if (term && term.trim().length > 0) {
      snippets.push({
        id: `ev-rest-${termIdx++}`,
        sourceField: 'terms',
        text: term.trim(),
      });
    }
  }

  for (const term of offer.offer?.specialConditions ?? []) {
    if (term && term.trim().length > 0) {
      snippets.push({
        id: `ev-spec-${termIdx++}`,
        sourceField: 'specialConditions',
        text: term.trim(),
      });
    }
  }

  for (const term of offer.offer?.generalTerms ?? []) {
    if (term && term.trim().length > 0) {
      snippets.push({
        id: `ev-gen-${termIdx++}`,
        sourceField: 'generalTerms',
        text: term.trim(),
      });
    }
  }

  // Validity periods
  for (const [idx, period] of (offer.validityPeriods ?? []).entries()) {
    if (period.rawPeriodText && period.rawPeriodText.trim().length > 0) {
      snippets.push({
        id: `ev-validity-${idx + 1}`,
        sourceField: 'validityText',
        text: period.rawPeriodText.trim(),
      });
    }
  }

  // Merchant location and addresses
  if (offer.merchant?.location && offer.merchant.location.trim().length > 0) {
    snippets.push({
      id: 'ev-merchant-loc',
      sourceField: 'merchantLocation',
      text: offer.merchant.location.trim(),
    });
  }

  for (const [idx, addr] of (offer.merchant?.addresses ?? []).entries()) {
    if (addr && addr.trim().length > 0) {
      snippets.push({
        id: `ev-addr-${idx + 1}`,
        sourceField: 'merchantAddresses',
        text: addr.trim(),
      });
    }
  }

  // Raw text / HTML fallback
  const rawContent = rawTextOverride || offer.rawHtml;
  if (rawContent && rawContent.trim().length > 0) {
    // Strip tags for text matching snippet
    const cleanRaw = rawContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanRaw.length > 0) {
      // Chunk raw into bounded 500-char paragraphs if long
      const CHUNK_SIZE = 600;
      for (let i = 0; i < cleanRaw.length; i += CHUNK_SIZE) {
        const chunk = cleanRaw.slice(i, i + CHUNK_SIZE).trim();
        if (chunk.length > 10) {
          snippets.push({
            id: `ev-raw-${Math.floor(i / CHUNK_SIZE) + 1}`,
            sourceField: 'rawText',
            text: chunk,
            offset: i,
          });
        }
      }
    }
  }

  return snippets;
}

/**
 * Checks whether a proposed text claim is grounded in cited or available evidence snippets.
 * Returns overlap ratio and matching snippet IDs.
 */
export function verifyEvidenceTokens(
  claim: string,
  evidenceSnippets: EvidenceSnippet[],
  citedIds?: string[]
): {
  grounded: boolean;
  tokenOverlapRatio: number;
  matchedSnippetIds: string[];
} {
  const claimTokens = extractSignificantTokens(claim);
  if (claimTokens.size === 0) {
    return { grounded: true, tokenOverlapRatio: 1.0, matchedSnippetIds: [] };
  }

  // Filter snippets to cited if provided, otherwise all
  const relevantSnippets = citedIds && citedIds.length > 0
    ? evidenceSnippets.filter((s) => citedIds.includes(s.id))
    : evidenceSnippets;

  const matchedSnippetIds = new Set<string>();
  let matchedTokens = 0;

  for (const token of claimTokens) {
    for (const snippet of relevantSnippets) {
      const snippetTokens = extractSignificantTokens(snippet.text);
      if (snippetTokens.has(token)) {
        matchedTokens++;
        matchedSnippetIds.add(snippet.id);
        break;
      }
    }
  }

  const tokenOverlapRatio = matchedTokens / claimTokens.size;
  // A claim is considered grounded if >= 40% of its significant tokens exist in evidence
  const grounded = tokenOverlapRatio >= 0.40;

  return {
    grounded,
    tokenOverlapRatio,
    matchedSnippetIds: Array.from(matchedSnippetIds),
  };
}

export type NumericSemanticRole =
  | 'DISCOUNT_PERCENT'
  | 'CASHBACK_PERCENT'
  | 'CASHBACK_AMOUNT'
  | 'MINIMUM_SPEND'
  | 'MAXIMUM_DISCOUNT_CAP'
  | 'MAXIMUM_TRANSACTION_LIMIT'
  | 'INSTALLMENT_MONTHS'
  | 'GENERIC';

/**
 * Associates an exact numeric value with its specific semantic role in source text.
 * Strictly prevents calendar days (e.g. "25th"), phone numbers, or street addresses
 * (e.g. "25 Galle Rd") from being falsely accepted as discount percentages or spend limits.
 */
export function verifySemanticNumericEvidence(
  numericValue: number,
  role: NumericSemanticRole,
  evidenceSnippets: EvidenceSnippet[],
  citedIds?: string[]
): {
  found: boolean;
  matchedSnippetIds: string[];
  contexts: string[];
  semanticMatch: boolean;
} {
  const numStr = String(numericValue);
  const formattedWithCommas = numericValue.toLocaleString('en-US');
  const numPattern = `(?:${numStr}|${formattedWithCommas.replace(',', ',?')})`;

  let roleRegex: RegExp;

  switch (role) {
    case 'DISCOUNT_PERCENT':
      // Must be followed by %, percent, pct, or preceded by discount/save/off
      // Disallow if followed by cashback or rebate (cashback paid later != point-of-sale discount)
      roleRegex = new RegExp(
        `(?:\\b(?:discount|save|off|upto|up\\s*to|get)\\s*(?:of\\s*)?)?${numPattern}\\s*(?:%|percent|pct|\\s*\\/-\\s*off|\\s*off\\b)(?!\\s*(?:cash\\s*back|cashback|rebate))`,
        'i'
      );
      break;

    case 'CASHBACK_PERCENT':
      roleRegex = new RegExp(
        `(?:\\b(?:cash\\s*back|cashback|rebate)\\s*(?:of\\s*)?)?${numPattern}\\s*(?:%|percent|pct)\\s*(?:cash\\s*back|cashback|rebate)?`,
        'i'
      );
      break;

    case 'CASHBACK_AMOUNT':
      roleRegex = new RegExp(
        `(?:(?:lkr|rs\\.?)\\s*${numPattern}\\s*(?:cash\\s*back|cashback|rebate)|(?:cash\\s*back|cashback|rebate)\\s*(?:of\\s*)?(?:lkr|rs\\.?)?\\s*${numPattern})`,
        'i'
      );
      break;

    case 'MINIMUM_SPEND':
      // Must be associated with min bill, spend, purchase, above, exceeding, threshold, or value
      roleRegex = new RegExp(
        `(?:(?:min(?:imum)?\\s*(?:total\\s+)?(?:spend|bill|purchase|transaction|amount|threshold|invoice|order|booking)?(?:\\s*value)?(?:\\s*[:=\\-–—\\s])?|(?:spend|purchase|bills?|orders?|transactions?)\\s*(?:of|exceeding|above|over|and\\s*above)?|threshold\\s*(?:of)?)\\s*(?:lkr|rs\\.?)?\\s*${numPattern}|(?:lkr|rs\\.?)\\s*${numPattern}\\s*(?:min(?:imum)?|and\\s*above|or\\s*more))`,
        'i'
      );
      break;

    case 'MAXIMUM_DISCOUNT_CAP':
      // Must be associated with max discount, cap, capped at, up to a maximum discount
      roleRegex = new RegExp(
        `(?:(?:max(?:imum)?\\s*(?:discount\\s*)?(?:cap(?:ped)?(?:\\s*at)?)?|(?:discount\\s*)?capped\\s*at|up\\s*to\\s*a\\s*max(?:imum)?\\s*(?:discount)?)\\s*(?:of\\s*)?(?:lkr|rs\\.?)?\\s*${numPattern}|(?:lkr|rs\\.?)\\s*${numPattern}\\s*(?:max(?:imum)?\\s*(?:discount)?|cap))`,
        'i'
      );
      break;

    case 'MAXIMUM_TRANSACTION_LIMIT':
      roleRegex = new RegExp(
        `(?:(?:max(?:imum)?\\s*(?:transaction|spend|bill)|transactions?\\s*up\\s*to)\\s*(?:of\\s*)?(?:lkr|rs\\.?)?\\s*${numPattern})`,
        'i'
      );
      break;

    case 'INSTALLMENT_MONTHS':
      roleRegex = new RegExp(
        `(?:(?:for|over|in|plan\\s*of)\\s*)?${numPattern}\\s*(?:months?|mths?|inst(?:allments?)?)`,
        'i'
      );
      break;

    case 'GENERIC':
    default:
      roleRegex = new RegExp(`\\b${numPattern}\\b`, 'i');
      break;
  }

  const relevantSnippets = citedIds && citedIds.length > 0
    ? evidenceSnippets.filter((s) => citedIds.includes(s.id))
    : evidenceSnippets;

  const matchedSnippetIds: string[] = [];
  const contexts: string[] = [];

  for (const snippet of relevantSnippets) {
    const match = roleRegex.exec(snippet.text);
    if (match) {
      // Disqualify if it's clearly a street number or date when looking for discount
      if (role === 'DISCOUNT_PERCENT') {
        const isDatePattern = new RegExp(`\\b${numStr}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)`, 'i');
        const isStreetPattern = new RegExp(`(?:no\\.?\\s*|street|road|rd|lane|colombo|kandy)\\s*${numStr}\\b`, 'i');
        if (isDatePattern.test(snippet.text) && !match[0].includes('%')) {
          continue;
        }
        if (isStreetPattern.test(snippet.text) && !match[0].includes('%')) {
          continue;
        }
      }

      matchedSnippetIds.push(snippet.id);
      const start = Math.max(0, match.index - 50);
      const end = Math.min(snippet.text.length, match.index + match[0].length + 50);
      contexts.push(`...${snippet.text.slice(start, end).replace(/\\s+/g, ' ')}...`);
    }
  }

  return {
    found: matchedSnippetIds.length > 0,
    matchedSnippetIds,
    contexts,
    semanticMatch: matchedSnippetIds.length > 0,
  };
}

/**
 * Checks whether an exact numeric value physically exists in cited or available evidence.
 * For backwards compatibility, delegates to verifySemanticNumericEvidence with GENERIC or inferred role.
 */
export function verifyNumericEvidence(
  numericValue: number,
  evidenceSnippets: EvidenceSnippet[],
  citedIds?: string[]
): {
  found: boolean;
  matchedSnippetIds: string[];
  contexts: string[];
} {
  return verifySemanticNumericEvidence(numericValue, 'GENERIC', evidenceSnippets, citedIds);
}

/**
 * Strictly inspects whether a discount is described with "up to" semantics.
 * Critical Invariant #8: Only show "Up to N%" when the bank's title or description says so.
 */
export function detectUpToSemantics(
  text: string | null | undefined,
  percentage: number | null | undefined
): {
  isUpTo: boolean;
  evidenceContext: string | null;
} {
  if (!text) return { isUpTo: false, evidenceContext: null };

  // Look for "up to [percentage]%" or "upto [percentage]%"
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  const upToRegex = percentage != null
    ? new RegExp(`(?:up\\s*to|upto|maximum\\s*of)\\s*(?:${percentage}%|${percentage}\\s*%)`, 'i')
    : /\b(?:up\s*to|upto|maximum\s*of)\b/i;

  const match = upToRegex.exec(clean);
  if (match) {
    const start = Math.max(0, match.index - 20);
    const end = Math.min(clean.length, match.index + match[0].length + 20);
    return {
      isUpTo: true,
      evidenceContext: clean.slice(start, end),
    };
  }

  return { isUpTo: false, evidenceContext: null };
}
