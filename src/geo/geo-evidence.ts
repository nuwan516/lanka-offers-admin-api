/**
 * Lanka Offers — Geo Evidence Extractor & Structured Context Builder
 *
 * Implements Section 4 of the Geo Pipeline:
 * - Packages complete extracted offer object with structured location candidates.
 * - Extracts bounded, provenance-tracked evidence snippets from raw HTML/text.
 * - Associates unique evidence IDs (e.g. "ev-1", "ev-2") with character offsets.
 * - Prevents sending multi-megabyte raw pages to the LLM by extracting
 *   location-relevant windows.
 */

import * as crypto from 'crypto';
import { Offer } from '@/core/types/offers';
import { RawValidationData } from '@/core/types/validation';
import { AddressQuality, assessAddressQuality } from '@/geo/address-quality';
import { determineLocationScope } from '@/domain/location-scope';

export interface EvidenceSnippet {
  id: string; // e.g. "ev-1"
  text: string;
  sourceLocation: string; // e.g. "offer-details", "terms", "raw-html-block"
  startOffset?: number;
  endOffset?: number;
}

export interface GeoOfferContext {
  offerId: string;
  bank: string;
  merchant: {
    name: string;
    addresses: string[];
    location: string | null;
  };
  offer: {
    title: string;
    description: string | null;
    category: string;
    terms: string[];
    locationScope: string;
  };
  extractedGeo: {
    candidateAddresses: string[];
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    addressQuality: AddressQuality;
    qualityReasons: string[];
  };
  sourceEvidence: {
    sourceUrl: string | null;
    contentType: string;
    evidenceHash: string;
    relevantSnippets: EvidenceSnippet[];
  };
}

const LOCATION_KEYWORDS = [
  /\baddress\b/i,
  /\blocation\b/i,
  /\bbranch(?:es)?\b/i,
  /\boutlet(?:s)?\b/i,
  /\bparticipating\b/i,
  /\bvenue\b/i,
  /\bvisit\s+us\b/i,
  /\bfind\s+us\b/i,
  /\bavailable\s+at\b/i,
  /\bselected\s+(?:outlets?|branches?|stores?)\b/i,
  /\ball\s+(?:outlets?|branches?|stores?)\b/i,
  /\bisland\s*wide\b/i,
  /\bonline\s+only\b/i,
  /\bwebsite\s+only\b/i,
  /\bColombo\s+(?:0?[1-9]|1[0-5])\b/i,
  /\b(?:Road|Street|Mawatha|Lane|Avenue|Plaza|Mall)\b/i,
];

const MAX_SNIPPET_LENGTH = 400;
const MAX_TOTAL_SNIPPETS = 6;

/**
 * Builds the structured GeoOfferContext from an Offer and raw source validation data.
 */
export function buildGeoOfferContext(
  offer: Offer,
  rawData?: RawValidationData | null
): GeoOfferContext {
  const candidateAddresses = [
    ...(offer.merchant.addresses ?? []),
  ].filter((a) => a && a.trim().length > 0);

  const offerDetails = offer.offer;
  const terms = [
    ...(offerDetails?.generalTerms ?? []),
    ...(offerDetails?.specialConditions ?? []),
    ...(offerDetails?.restrictions ?? []),
  ];

  const qualityAssessment = assessAddressQuality({
    candidateAddresses,
    rawLocation: offer.merchant.location ?? '',
    merchantName: offer.merchant.name,
    rawText: [offer.title, offerDetails?.description ?? '', ...terms].join(' '),
  });

  const rawText = rawData?.rawText ?? '';
  const rawHtml = rawData?.rawHtml ?? offer.rawHtml ?? '';
  const combinedRaw = rawText || rawHtml || [offer.title, offerDetails?.description ?? '', ...terms].join('\n');

  const snippets: EvidenceSnippet[] = [];
  let snippetCounter = 1;

  // 1. Check offer title/description/terms first as high-priority snippets
  if (offer.title) {
    snippets.push({
      id: `ev-${snippetCounter++}`,
      text: offer.title.slice(0, MAX_SNIPPET_LENGTH),
      sourceLocation: 'offer-title',
    });
  }

  if (offerDetails?.description) {
    snippets.push({
      id: `ev-${snippetCounter++}`,
      text: offerDetails.description.slice(0, MAX_SNIPPET_LENGTH),
      sourceLocation: 'offer-description',
    });
  }

  // 2. Scan terms for location keywords
  for (const term of terms) {
    if (snippets.length >= MAX_TOTAL_SNIPPETS) break;
    if (LOCATION_KEYWORDS.some((kw) => kw.test(term))) {
      snippets.push({
        id: `ev-${snippetCounter++}`,
        text: term.slice(0, MAX_SNIPPET_LENGTH),
        sourceLocation: 'terms-and-conditions',
      });
    }
  }

  // 3. Scan combined raw text for location keywords if we still have capacity
  if (snippets.length < MAX_TOTAL_SNIPPETS && combinedRaw) {
    const lines = combinedRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 10);
    for (const line of lines) {
      if (snippets.length >= MAX_TOTAL_SNIPPETS) break;
      // Skip if line was already included
      if (snippets.some((s) => s.text.includes(line) || line.includes(s.text))) continue;

      if (LOCATION_KEYWORDS.some((kw) => kw.test(line))) {
        snippets.push({
          id: `ev-${snippetCounter++}`,
          text: line.slice(0, MAX_SNIPPET_LENGTH),
          sourceLocation: 'raw-source-snippet',
        });
      }
    }
  }

  // If no snippets matched keywords, include first chunk of raw content
  if (snippets.length === 0 && combinedRaw) {
    snippets.push({
      id: `ev-${snippetCounter++}`,
      text: combinedRaw.slice(0, MAX_SNIPPET_LENGTH),
      sourceLocation: 'raw-fallback',
    });
  }

  const evidenceHash = crypto
    .createHash('sha256')
    .update(snippets.map((s) => s.text).join('::'))
    .digest('hex');

  const determinedScope = determineLocationScope({
    title: offer.title,
    description: offerDetails?.description,
    merchantName: offer.merchant.name,
    addresses: candidateAddresses,
    location: offer.merchant.location,
  });

  return {
    offerId: offer.uniqueId,
    bank: offer.source,
    merchant: {
      name: offer.merchant.name,
      addresses: offer.merchant.addresses ?? [],
      location: offer.merchant.location ?? null,
    },
    offer: {
      title: offer.title,
      description: offerDetails?.description ?? null,
      category: offer.category,
      terms,
      locationScope: determinedScope.scope,
    },
    extractedGeo: {
      candidateAddresses: qualityAssessment.cleanAddresses,
      confidence: qualityAssessment.confidence,
      addressQuality: qualityAssessment.quality,
      qualityReasons: qualityAssessment.reasons,
    },
    sourceEvidence: {
      sourceUrl: offer.sourceUrl ?? rawData?.sourceUrl ?? null,
      contentType: rawHtml ? 'text/html' : 'text/plain',
      evidenceHash,
      relevantSnippets: snippets,
    },
  };
}
