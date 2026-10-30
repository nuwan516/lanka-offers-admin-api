# Lanka Offers — Validation & LLM Quality Gate

## 1. Overview

Lanka Offers enforces a deterministic-first validation philosophy. Machine learning and Large Language Models (LLMs) are strictly secondary fallback tools used only when deterministic rules cannot achieve high confidence.

```text
Scraped Normalized Candidate
             │
             ▼
[ Deterministic Rule Engine ] ────── (Syntax, Dates, Numbers, Terms, Merchant)
             │
      ┌──────┴──────────────────────┐
      │ Confidence >= 0.85          │ Confidence < 0.85 (Ambiguous)
      ▼                             ▼
[ Deterministic Pass ]      [ LLM Content Hash Gate ] (Invariant #6)
      │                             │
      │                     ┌───────┴───────────────────────┐
      │                     │ Hash Match (Cached)           │ Hash Miss (New Content)
      │                     ▼                               ▼
      │             [ Reuse LLM Result ]            [ Bounded LLM Invocation ]
      │                     │                               │
      └─────────────────────┼───────────────────────────────┘
                            ▼
              [ Quality Decision Classifier ]
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  [ AUTO_STAGED ]   [ REVIEW_REQUIRED ]    [ REJECTED ]
```

---

## 2. Deterministic Validation Engine

Located in `admin/api/src/parsing/validators/`:

### Rules Evaluated
1. **Temporal Feasibility:**
   - `valid_until >= valid_from`
   - `valid_until >= CURRENT_DATE` (expired offers at discovery are rejected or archived).
   - Timezone normalized to `Asia/Colombo` (UTC+05:30).
2. **Financial Precision:**
   - Percentage discounts must fall in `[1%, 100%]`.
   - Flat amounts must match verified currency strings (LKR).
   - "Up to N%" qualification extracted only if present in source text.
3. **Card Tier Legality:**
   - Recognized Sri Lankan issuer card families (Visa, Mastercard, Amex, UnionPay).
   - Specific tiers (Classic, Gold, Platinum, Signature, Infinite, World).
   - If ambiguous, explicitly marked `unknown` (never assumed).
4. **Merchant Verification:**
   - Match against verified merchant dictionary (`src/core/constants/`).
   - Discard promotional placeholder entries.

---

## 3. Zero-Cost LLM Gate (Invariant #6)

When deterministic confidence falls below the approval threshold, the system consults an LLM (Gemini or equivalent) with strict financial and architectural guardrails:

### 3.1 Content Hashing & Cache Invalidation
Before dispatching any external API request, the system computes:
```typescript
const contentHash = createHash('sha256')
  .update(`${rawOffer.title}|${rawOffer.description}|${rawOffer.termsRaw}`)
  .digest('hex');
```
If `offers.llm_validated_content_hash === contentHash`, the previous LLM response is reused without network calls or operational cost.

### 3.2 Structured Tool Calling & Schemas
The LLM does not generate freeform prose. It executes against a strict Zod schema (`src/llm/schemas/offer-validation.schema.ts`):
- `corrected_merchant_name`: Canonical string
- `discount_percentage`: Number or null
- `discount_type`: Enum (`PERCENTAGE`, `FLAT`, `BUY_ONE_GET_ONE`, `CASHBACK`, `SPECIAL_PRICE`)
- `card_eligibility`: Structured object with tiers and card types
- `location_scope`: Enum
- `confidence_score`: Float `[0.0, 1.0]`

### 3.3 Cost Controls & Safety Guards
- Daily invocation quota configured in `src/config/cost-control.ts`.
- Requests fail safe: if the LLM provider fails, times out, or exceeds budget, the candidate offer is automatically routed to `REVIEW_REQUIRED` for human evaluation rather than rejected or lost.
