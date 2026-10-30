# Lanka Offers — Data Model & Lifecycle Schema

## 1. Overview

Lanka Offers uses PostgreSQL (hosted on Neon Cloud) as its authoritative datastore. Schema definitions are centralized in `admin/api/src/infrastructure/db/schema.sql`.

The schema enforces strict separation between raw scraping provenance, automated candidate updates, operator overrides, and public visibility.

---

## 2. Core Tables

### 2.1 `offers`
The primary table holding all promotional records across all lifecycle stages.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | SERIAL PRIMARY KEY | No | Internal integer ID. |
| `unique_id` | VARCHAR(255) | No | Deterministic hash/slug identifying the promotion across scrapes. UNIQUE constraint. |
| `bank` | VARCHAR(50) | No | Bank identifier (`hnb`, `boc`, `sampath`, `peoples`, etc.). |
| `title` | TEXT | No | Normalized promotional title. |
| `description` | TEXT | Yes | Descriptive text and eligibility criteria. |
| `category` | VARCHAR(100) | No | Main taxonomy (Dining, Shopping, Travel, Supermarket, etc.). |
| `merchant` | VARCHAR(255) | No | Canonical merchant name. |
| `discount_type` | VARCHAR(50) | Yes | `PERCENTAGE`, `FLAT`, `BOGO`, `SPECIAL_PRICE`. |
| `discount_value` | NUMERIC(10,2) | Yes | Numeric percentage or flat value. |
| `valid_from` | TIMESTAMPTZ | Yes | Start date/time (UTC). |
| `valid_until` | TIMESTAMPTZ | Yes | Expiry date/time (UTC, normalized to end-of-day Asia/Colombo). |
| `db_status` | VARCHAR(50) | No | Lifecycle status (see Section 3). Indexed. |
| `location_scope` | VARCHAR(50) | No | `ONLINE`, `NATIONWIDE`, `SELECTED_OUTLETS`, `SPECIFIC_OUTLET`, etc. |
| `raw_offer` | JSONB | No | **Immutable original evidence** captured directly from the bank. |
| `manual_override` | JSONB | Yes | **Sacred operator corrections** (title, dates, merchant, discounts, locations). |
| `pending_candidate`| JSONB | Yes | Proposed automated changes from subsequent scrapes awaiting review. |
| `confidence_score` | NUMERIC(5,4) | Yes | Quality confidence score `[0.0000, 1.0000]`. |
| `llm_validated_content_hash` | VARCHAR(64) | Yes | SHA-256 hash of text validated by LLM to avoid redundant invocation. |
| `created_at` | TIMESTAMPTZ | No | Insertion timestamp (`DEFAULT NOW()`). |
| `updated_at` | TIMESTAMPTZ | No | Last update timestamp. |

### 2.2 `offer_review_history`
Append-only audit trail enabling fine-grained reversibility and regulatory audit compliance.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | SERIAL PRIMARY KEY | No | History log identifier. |
| `offer_id` | INT REFERENCES offers(id) | No | Target offer ID. |
| `action` | VARCHAR(50) | No | `approve`, `reject`, `publish`, `unpublish`, `edit`, `rollback`. |
| `actor` | VARCHAR(100) | No | Operator identity or automated worker ID. |
| `previous_state` | JSONB | Yes | Snapshot of offer prior to change. |
| `changes` | JSONB | Yes | Specific fields modified or operation metadata. |
| `created_at` | TIMESTAMPTZ | No | Audit timestamp. |

### 2.3 `scrape_runs`
Tracks batch scraper execution, job fencing, and run-level rollback boundaries.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | SERIAL PRIMARY KEY | No | Run ID. |
| `bank` | VARCHAR(50) | No | Target bank or `all`. |
| `status` | VARCHAR(50) | No | `running`, `completed`, `failed`, `rolled_back`. |
| `total_found` | INT | No | Count of raw offers extracted from source. |
| `total_inserted` | INT | No | Count of brand new offers staged. |
| `total_updated` | INT | No | Count of existing offers updated or candidates generated. |
| `total_rejected` | INT | No | Count of discarded offers (e.g., expired, noise). |
| `started_at` | TIMESTAMPTZ | No | Job start time. |
| `completed_at` | TIMESTAMPTZ | Yes | Job completion time. |
| `lease_expires_at`| TIMESTAMPTZ | Yes | Lease fence timestamp to prevent overlapping executions. |

### 2.4 `geo_cache`
Persistent location resolution cache preventing duplicate external geocoding requests.

| Column | Type | Nullable | Description |
|---|---|---|---|
| `id` | SERIAL PRIMARY KEY | No | Cache entry ID. |
| `query_text` | TEXT | No | Normalized address or venue string. UNIQUE index. |
| `lat` | NUMERIC(10,7) | Yes | Latitude. |
| `lon` | NUMERIC(10,7) | Yes | Longitude. |
| `confidence` | NUMERIC(5,4) | Yes | Geocoding confidence score. |
| `source` | VARCHAR(50) | No | Geocoder provider (`google`, `osm`, `manual`). |
| `verified` | BOOLEAN | No | True if verified against Sri Lankan city/merchant directory. |
| `created_at` | TIMESTAMPTZ | No | Cache insertion timestamp. |

---

## 3. Offer Lifecycle State Machine

```text
       [ Scraper Ingestion ]
                 │
                 ▼
          ( DRAFT / RAW )
                 │
        ┌────────┴────────┐
        ▼                 ▼
[ High Confidence ]  [ Low Confidence / Ambiguity ]
        │                 │
        ▼                 ▼
  ( AUTO_STAGED )    ( REVIEW_REQUIRED )
        │                 │
        │           ┌─────┴─────┐
        │           ▼           ▼
        │     ( APPROVED )  ( REJECTED )
        │           │
        └─────┬─────┘
              ▼
    ( Operator Review )
              │
              ▼
        ( PUBLISHED ) ──────► Public API Consumer Visibility
              │
        ┌─────┴─────┐
        ▼           ▼
   ( DISABLED )  ( EXPIRED / ARCHIVED )
```

### Lifecycle States (`db_status`)
- `DRAFT`: Initial parsing state. Not visible to reviewers.
- `REVIEW_REQUIRED`: Low confidence parsing, missing critical terms, or candidate conflict. Queued in admin dashboard.
- `AUTO_STAGED`: High confidence deterministic pass. Ready for operator batch approval.
- `APPROVED`: Verified by operator, ready for public publication sync.
- `PUBLISHED`: **Active public visibility** (served by `backend-api` if unexpired).
- `REJECTED`: Discarded as irrelevant, duplicate, or unverified.
- `DISABLED`: Manually pulled from public view due to terms cancellation or merchant dispute.
- `ARCHIVED`: Expired promotions retained for historical indexing and reporting.

---

## 4. The Effective Offer Merge Pattern

When rendering or publishing an offer, the system dynamically merges three layers in order of authority:

```text
Base Scraped Offer (Normalized fields from raw_offer)
                    +
Approved Pending Candidate (if automated re-scrape updated terms)
                    +
Manual Overrides (Sacred operator edits in manual_override JSON)
                    =
EFFECTIVE OFFER (Authoritative record served to consumers)
```

Manual overrides ALWAYS take absolute precedence over automated scraping results.
