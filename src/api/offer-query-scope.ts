/**
 * Pure SQL-fragment builder for `GET /api/offers`, extracted out of
 * server.ts so the public/admin visibility rule (Step 3/19) is unit
 * testable without booting Express.
 *
 * Non-admin callers (the public Flutter app, or anyone omitting
 * `scope=admin`) ALWAYS get `db_status = 'PUBLISHED'` — the incoming
 * `status` filter is ignored for them so staging/review data can never leak.
 *
 * Admin triage `view` presets map to server-side filters so the dashboard
 * does not rely on a 300-row client-side slice.
 */
export type AdminOfferView =
  | 'all'
  | 'new'
  | 'changed'
  | 'staged'
  | 'low_confidence'
  | 'validation_failed'
  | 'geo_issues'
  | 'approved'
  | 'rejected'
  | 'published';

export interface OfferListQueryInput {
  bank?: string;
  status?: string;
  search?: string;
  scope?: string;
  paramOffset?: number;
  locationScope?: string;
  merchant?: string;
  /** Admin-only review-queue presets. Ignored for non-admin callers. */
  view?: string;
  hasPendingCandidate?: boolean | string;
  changeStatus?: string;
  rulePassed?: boolean | string;
  geoStatus?: string;
  maxLlmScore?: number | string;
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

function parseBool(v: boolean | string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

function parseNumber(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Apply named admin review-queue presets onto discrete filter fields. */
function applyAdminView(
  view: string | undefined,
  input: OfferListQueryInput
): OfferListQueryInput {
  if (!view || view === 'all') return input;
  switch (view as AdminOfferView) {
    case 'new':
      return { ...input, changeStatus: 'NEW' };
    case 'changed':
      // Staged updates OR change_status CHANGED (awaiting review).
      return { ...input, changeStatus: 'CHANGED_OR_PENDING' };
    case 'staged':
      return { ...input, hasPendingCandidate: true };
    case 'low_confidence':
      return { ...input, maxLlmScore: 70 };
    case 'validation_failed':
      return { ...input, rulePassed: false };
    case 'geo_issues':
      return { ...input, geoStatus: 'unresolved,quota_blocked' };
    case 'approved':
      return { ...input, status: 'APPROVED' };
    case 'rejected':
      return { ...input, status: 'REJECTED' };
    case 'published':
      return { ...input, status: 'PUBLISHED' };
    default:
      return input;
  }
}

export function buildOfferListQuery(rawInput: OfferListQueryInput): OfferListQuery {
  const isAdmin = rawInput.scope === 'admin';
  const input = isAdmin ? applyAdminView(rawInput.view, rawInput) : rawInput;
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

  // Admin-only triage filters — never applied for public callers.
  if (isAdmin) {
    const hasPending = parseBool(input.hasPendingCandidate);
    if (hasPending === true) {
      conditions.push('pending_candidate IS NOT NULL');
    } else if (hasPending === false) {
      conditions.push('pending_candidate IS NULL');
    }

    if (input.changeStatus === 'CHANGED_OR_PENDING') {
      conditions.push(`(pending_candidate IS NOT NULL OR change_status = 'CHANGED')`);
    } else if (input.changeStatus) {
      conditions.push(`change_status = $${i++}`);
      params.push(input.changeStatus);
    }

    const rulePassed = parseBool(input.rulePassed);
    if (rulePassed === true) {
      conditions.push('rule_passed = true');
    } else if (rulePassed === false) {
      conditions.push('rule_passed = false');
    }

    if (input.geoStatus) {
      const statuses = input.geoStatus.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        conditions.push(`geo_status = $${i++}`);
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        const placeholders = statuses.map(() => `$${i++}`).join(', ');
        conditions.push(`geo_status IN (${placeholders})`);
        params.push(...statuses);
      }
    }

    const maxLlm = parseNumber(input.maxLlmScore);
    if (maxLlm !== undefined) {
      // Unscored offers also need human eyes in the low-confidence queue.
      conditions.push(`(llm_score IS NULL OR llm_score < $${i++})`);
      params.push(maxLlm);
    }
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: i,
    isAdmin,
  };
}
