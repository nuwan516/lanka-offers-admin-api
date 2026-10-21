import { ToolDefinition } from './geo-tool-registry';

/**
 * Complete allowlisted tool registry for Full Offer Validation.
 * Implements Part 10 requirements with strict parameter types and descriptions.
 */
export const OFFER_TOOL_DEFINITIONS: ToolDefinition[] = [
  // ─── A. Source Tools ─────────────────────────────────────────────────────────
  {
    name: 'get_raw_offer',
    description: 'Reads the captured raw offer context, metadata, and extracted evidence snippets.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'get_source_section',
    description: 'Retrieves a bounded section of the source content (title, description, terms, validity, merchant, raw_html).',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        section: {
          type: 'string',
          description: 'Section to retrieve',
          enum: ['title', 'description', 'terms', 'validity', 'merchant', 'raw_html'],
        },
      },
      required: ['offerId', 'section'],
    },
  },
  {
    name: 'search_source_evidence',
    description: 'Searches source text for relevant keywords or phrases and returns matching snippets with offsets.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        query: { type: 'string', description: 'Keyword or phrase to search (e.g. "discount", "minimum", "expiry")' },
      },
      required: ['offerId', 'query'],
    },
  },
  {
    name: 'expand_evidence_window',
    description: 'Expands context window around a specific snippet ID or offset up to 1000 characters.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        snippetId: { type: 'string', description: 'Evidence snippet ID to expand around' },
        windowSize: { type: 'number', description: 'Number of extra characters before and after (max 500)' },
      },
      required: ['offerId', 'snippetId'],
    },
  },

  // ─── B. Merchant Tools ───────────────────────────────────────────────────────
  {
    name: 'normalize_merchant_name',
    description: 'Runs deterministic Sri Lankan merchant name normalization (strips legal noise, trailing geography, etc.).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Raw merchant name string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_existing_merchants',
    description: 'Read-only lookup of known canonical merchant names in the platform catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Merchant name or fragment to search' },
      },
      required: ['query'],
    },
  },
  {
    name: 'compare_merchant_identity',
    description: 'Evaluates candidate merchant against source text and location evidence.',
    parameters: {
      type: 'object',
      properties: {
        candidateName: { type: 'string', description: 'Candidate merchant name' },
        rawTitle: { type: 'string', description: 'Raw promotion title' },
        rawDescription: { type: 'string', description: 'Raw promotion description' },
      },
      required: ['candidateName', 'rawTitle'],
    },
  },

  // ─── C. Financial Tools ──────────────────────────────────────────────────────
  {
    name: 'extract_financial_terms',
    description: 'Runs deterministic financial parsing on text to extract discount percentage, up-to semantics, caps, and min spend.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to parse for financial benefits' },
      },
      required: ['text'],
    },
  },
  {
    name: 'compare_financial_terms',
    description: 'Verifies whether candidate financial benefit (percentage, cap, min spend) is grounded in source evidence.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        discountPercentage: { type: 'number', description: 'Claimed discount percentage' },
        isUpTo: { type: 'boolean', description: 'Whether the benefit is claimed as up-to' },
        minimumSpend: { type: 'number', description: 'Claimed minimum spend threshold' },
        maximumCap: { type: 'number', description: 'Claimed maximum discount cap' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'validate_financial_consistency',
    description: 'Checks cross-field financial consistency (e.g. discount % vs cap vs minimum spend).',
    parameters: {
      type: 'object',
      properties: {
        discountPercentage: { type: 'number', description: 'Discount percentage' },
        minimumSpend: { type: 'number', description: 'Minimum spend amount' },
        maximumCap: { type: 'number', description: 'Maximum cap amount' },
      },
      required: [],
    },
  },

  // ─── D. Eligibility Tools ───────────────────────────────────────────────────
  {
    name: 'extract_card_eligibility',
    description: 'Extracts credit/debit card types, card networks (Visa/Mastercard/Amex), and tier restrictions from text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text containing card eligibility details' },
        bankCode: { type: 'string', description: 'Bank code for bank-specific card brand rules' },
      },
      required: ['text'],
    },
  },
  {
    name: 'validate_card_restrictions',
    description: 'Verifies claimed card types and networks against source evidence.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        cardTypes: { type: 'array', items: { type: 'string', description: 'Card type' }, description: 'List of card types' },
        networks: { type: 'array', items: { type: 'string', description: 'Network' }, description: 'List of card networks' },
      },
      required: ['offerId'],
    },
  },

  // ─── E. Date Tools ──────────────────────────────────────────────────────────
  {
    name: 'extract_offer_dates',
    description: 'Runs deterministic date parser on raw period text to extract ISO validFrom and validTo.',
    parameters: {
      type: 'object',
      properties: {
        periodText: { type: 'string', description: 'Text containing date ranges' },
      },
      required: ['periodText'],
    },
  },
  {
    name: 'validate_date_range',
    description: 'Validates date range chronology, format (YYYY-MM-DD), and expiry relative to current date.',
    parameters: {
      type: 'object',
      properties: {
        validFrom: { type: 'string', description: 'Start date YYYY-MM-DD' },
        validTo: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'find_date_evidence',
    description: 'Retrieves source paragraphs containing dates or validity duration.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
      },
      required: ['offerId'],
    },
  },

  // ─── F. Duplicate Tools ─────────────────────────────────────────────────────
  {
    name: 'find_similar_offers',
    description: 'Performs read-only lookup of potentially duplicate or renewed offers in current batch/store.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'compare_offer_versions',
    description: 'Compares candidate offer against another offer to produce field-level diffs and similarity score.',
    parameters: {
      type: 'object',
      properties: {
        candidateOfferId: { type: 'string', description: 'Candidate offer ID' },
        existingOfferId: { type: 'string', description: 'Existing offer ID' },
      },
      required: ['candidateOfferId', 'existingOfferId'],
    },
  },
  {
    name: 'classify_duplicate_relationship',
    description: 'Classifies duplicate candidate into EXACT_DUPLICATE, UPDATED_OFFER, RENEWED_CAMPAIGN, or NOT_DUPLICATE.',
    parameters: {
      type: 'object',
      properties: {
        similarityScore: { type: 'number', description: 'Computed similarity score 0-100' },
        sameBank: { type: 'boolean', description: 'Whether offers share the same bank' },
        validityOverlapRatio: { type: 'number', description: 'Validity period overlap ratio' },
      },
      required: ['similarityScore', 'sameBank'],
    },
  },

  // ─── G. Validation Tools ────────────────────────────────────────────────────
  {
    name: 'validate_offer_schema',
    description: 'Runs Zod schema check on candidate offer object to detect missing required fields.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'validate_correction_patch',
    description: 'Deterministically pre-validates a proposed field correction patch against allowlist and cited evidence.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
        fieldPath: { type: 'string', description: 'Dot path in EDITABLE_FIELD_PATHS' },
        proposedValue: { type: 'string', description: 'JSON-serialized proposed value' },
        evidenceIds: { type: 'array', items: { type: 'string', description: 'Evidence snippet ID' }, description: 'Cited snippet IDs' },
      },
      required: ['offerId', 'fieldPath', 'proposedValue', 'evidenceIds'],
    },
  },
  {
    name: 'evaluate_offer_quality',
    description: 'Computes deterministic quality gate status (VALIDATED, REVIEW_REQUIRED, REJECT) based on field support.',
    parameters: {
      type: 'object',
      properties: {
        offerId: { type: 'string', description: 'Offer unique ID' },
      },
      required: ['offerId'],
    },
  },
  {
    name: 'submit_offer_validation_proposal',
    description: 'Submits the final structured FullOfferValidationProposal. Does NOT publish or write to DB directly.',
    parameters: {
      type: 'object',
      properties: {
        proposal: { type: 'string', description: 'JSON string of FullOfferValidationProposal' },
      },
      required: ['proposal'],
    },
  },
];
