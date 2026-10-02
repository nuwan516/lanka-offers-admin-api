/**
 * Pure SQL-fragment builder for `GET /api/offers`, extracted out of
 * server.ts so the public/admin visibility rule (Step 3/19) is unit
 * testable without booting Express.
 *
 * Non-admin callers (the public Flutter app, or anyone omitting
 * `scope=admin`) ALWAYS get `db_status = 'PUBLISHED'` — the incoming
 * `status` filter is ignored for them so staging/review data can never leak.
 */
export interface OfferListQueryInput {
  bank?: string;
  status?: string;
  search?: string;
  scope?: string;
  paramOffset?: number;
  locationScope?: string;
  merchant?: string;
}

export interface OfferListQuery {
  whereSql: string;
  params: unknown[];
  nextParamIndex: number;
  isAdmin: boolean;
}

/**
 * Fields safe to return from the single-offer detail endpoint to a
 * non-admin caller. `getOfferById()` selects `o.*` (plus `llm_reasoning`/
 * `llm_issues`) for admin convenience — that unfiltered row must never
 * reach a public caller as-is, since it includes `pending_candidate`
 * (an unreviewed future version), `manual_override` (internal admin
 * metadata), and LLM reasoning text. `raw_offer` IS kept — the Flutter
 * detail view reads merchant/offer details out of it.
 */
const PUBLIC_OFFER_FIELDS = [
  'id', 'unique_id', 'bank', 'source_url', 'title', 'category', 'card_type',
  'merchant_name', 'merchant_location', 'canonical_merchant', 'location_scope',
  'discount_percentage', 'valid_from', 'valid_to', 'card_eligibility',
  'geo_locations', 'geo_status', 'raw_offer', 'rule_passed', 'db_status',
  'created_at', 'updated_at',
] as const;

export function sanitizePublicOffer(offer: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const field of PUBLIC_OFFER_FIELDS) {
    if (field in offer) safe[field] = offer[field];
  }
  return safe;
}

export function buildOfferListQuery(input: OfferListQueryInput): OfferListQuery {
  const isAdmin = input.scope === 'admin';
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = (input.paramOffset ?? 0) + 1;

  if (input.bank) { conditions.push(`bank = $${i++}`); params.push(input.bank); }

  if (isAdmin) {
    if (input.status) { conditions.push(`db_status = $${i++}`); params.push(input.status); }
  } else {
    conditions.push(`db_status = 'PUBLISHED'`);
    conditions.push(`(valid_to IS NULL OR valid_to >= CURRENT_DATE)`);
  }

  if (input.locationScope) {
    conditions.push(`location_scope = $${i++}`);
    params.push(input.locationScope);
  }

  if (input.merchant) {
    conditions.push(`(merchant_name ILIKE $${i} OR canonical_merchant ILIKE $${i})`);
    params.push(`%${input.merchant}%`);
    i++;
  }

  if (input.search) {
    conditions.push(`(title ILIKE $${i} OR merchant_name ILIKE $${i} OR canonical_merchant ILIKE $${i})`);
    params.push(`%${input.search}%`);
    i++;
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: i,
    isAdmin,
  };
}

