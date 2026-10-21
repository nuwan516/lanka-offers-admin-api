/**
 * Lanka Offers — Geo Tool Registry
 *
 * Implements Section 6 of the Intelligent Address Validation Pipeline.
 * Provides the definitions and JSON schemas for the 10 bounded deterministic tools.
 */export interface ToolParameterProperty {
  type: string;
  description?: string;
  items?: {
    type: string;
    description?: string;
    properties?: Record<string, ToolParameterProperty>;
  };
  properties?: Record<string, ToolParameterProperty>;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required: string[];
  };
}

export const GEO_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_raw_offer_evidence',
    description: 'Retrieves relevant raw scraped content and evidence snippets for an offer with provenance.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Unique ID of the offer' },
        section: { type: 'string', description: 'Section identifier (e.g. "details", "terms", "all")', enum: ['details', 'terms', 'all'] },
        maxChars: { type: 'number', description: 'Maximum characters to return (capped at 2000)' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'extract_address_candidates',
    description: 'Runs the deterministic AddressEngine on a source snippet to extract candidate addresses.',
    parameters: {
      type: 'object',
      properties: {
        snippet: { type: 'string', description: 'Raw text snippet to parse for addresses' },
        bank: { type: 'string', description: 'Optional bank code for bank-specific heuristics' },
      },
      required: ['snippet'],
    },
  },
  {
    name: 'normalize_sri_lankan_address',
    description: 'Standardizes spelling, road abbreviations (e.g. Rd -> Road, Mw -> Mawatha), Colombo postal zones, and removes duplicate city suffixes.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Sri Lankan address string to normalize' },
      },
      required: ['address'],
    },
  },
  {
    name: 'classify_location_scope',
    description: 'Determines the canonical location scope (ONLINE, NATIONWIDE, SELECTED_OUTLETS, EXPLICIT_BRANCH, MULTIPLE_BRANCHES, UNRESOLVED).',
    parameters: {
      type: 'object',
      properties: {
        merchantName: { type: 'string', description: 'Merchant name' },
        addresses: { type: 'array', items: { type: 'string', description: 'Address string' }, description: 'Extracted address list' },
        rawText: { type: 'string', description: 'Raw promotion text for restriction indicators' },
      },
      required: ['merchantName', 'addresses'],
    },
  },
  {
    name: 'compare_offer_to_raw_evidence',
    description: 'Compares candidate address strings against raw source evidence to verify exact or token match support.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer ID' },
        addressesToVerify: { type: 'array', items: { type: 'string', description: 'Address string' }, description: 'Addresses to verify against evidence' },
      },
      required: ['offerId', 'addressesToVerify'],
    },
  },
  {
    name: 'validate_branch_list',
    description: 'Validates whether candidate locations represent distinct participating physical branches and deduplicates them safely.',
    parameters: {
      type: 'object',
      properties: {
        candidateBranches: { type: 'array', items: { type: 'string', description: 'Branch string' }, description: 'Candidate branch addresses or names' },
        merchantName: { type: 'string', description: 'Merchant name to check for name-prefix redundancy' },
      },
      required: ['candidateBranches'],
    },
  },
  {
    name: 'lookup_merchant_geo_cache',
    description: 'Performs a read-only lookup in the existing local GeoCache for previously resolved addresses or venues.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Address or merchant venue query to check in cache' },
      },
      required: ['query'],
    },
  },
  {
    name: 'retrieve_additional_source_context',
    description: 'Retrieves a bounded additional window of cached raw source text around a specific character offset.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer ID' },
        offset: { type: 'number', description: 'Starting character offset in raw text' },
        length: { type: 'number', description: 'Length of text window to return (max 1000)' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'validate_corrected_offer',
    description: 'Runs deterministic validators against proposed address corrections to detect invalid patterns or safety issues.',
    parameters: {
      type: 'object',
      properties: {
        candidateAddresses: { type: 'array', items: { type: 'string', description: 'Address string' }, description: 'Proposed address list' },
        merchantName: { type: 'string', description: 'Merchant name' },
      },
      required: ['candidateAddresses'],
    },
  },
  {
    name: 'submit_correction_proposal',
    description: 'Submits a structured correction proposal for orchestrator evaluation. Does not write to DB.',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'Validation decision', enum: ['ACCEPT', 'CORRECT', 'REJECT', 'NEEDS_MORE_EVIDENCE', 'REVIEW_REQUIRED'] },
        locationScope: { type: 'string', description: 'Location scope enum' },
        addressQuality: { type: 'string', description: 'Address quality classification' },
        proposedAddresses: {
          type: 'array',
          description: 'List of proposed address items',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', description: 'Full address string' },
              evidenceIds: { type: 'array', description: 'Cited evidence snippet IDs', items: { type: 'string' } },
              reason: { type: 'string', description: 'Evidence-based justification' },
            },
          },
        },
        removedCandidates: { type: 'array', description: 'Removed candidate strings', items: { type: 'string' } },
        reasoning: { type: 'string', description: 'Reasoning summary' },
      },
      required: ['decision', 'locationScope', 'addressQuality', 'proposedAddresses'],
    },
  },
];
