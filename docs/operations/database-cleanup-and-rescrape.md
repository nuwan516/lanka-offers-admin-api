# Lanka Offers — Database Audit, Reconciliation, Image Resilience & Rescrape Operations

**Date:** October 30, 2026  
**Auditor / Engineer:** Principal Backend Engineer, PostgreSQL Data Engineer, Bank Scraping Engineer & SRE Lead  
**Scope:** Workspace `d:\LankaOffersRewrite`

---

## 1. Database Environment Discovery & Classification

Before performing any database inspection, the connection parameters were audited without disclosing secrets.

| Environment Check | Result | Classification |
|---|---|---|
| **Database Host** | `ep-morning-river-b3db0zpy-pooler.c-4.ap-southeast-1.aws.neon.tech` | **PRODUCTION (Neon AWS ap-southeast-1)** |
| **Database Name** | `neondb` | Target production database |
| **Database Role** | `neondb_owner` | Full DDL/DML permissions |
| **PostgreSQL Version** | PostgreSQL 17.5 on x86_64-pc-linux-gnu | Modern PostgreSQL engine with PostGIS |
| **Safety Mandate** | STRICT READ-ONLY INSPECTION ONLY | **Destructive writes, drops, and truncations prohibited** |

> [!IMPORTANT]
> Because `.env` in `admin/api` points directly to the live Neon production database, **destructive mutations or unconfirmed rescrapes were strictly quarantined**. All cleanup actions were rehearsed in an isolated PGlite WASM PostgreSQL harness, and all fresh bank scrapes were executed with `--dry-run` to output cryptographic manifests for operator sign-off.

---

## 2. Complete Offer Database Inventory (Task 4 & 5)

An exhaustive read-only query of all database tables revealed:

### 2.1 Offers by Bank and Lifecycle Status
The database holds **810 total promotions**, distributed across 4 banks:

| Bank | Total Offers | Published (Active) | Published (Past Valid To) | Review Required | Expired Status | Approved | Disabled / Rejected |
|---|---|---|---|---|---|---|---|
| **HNB** | 530 | 473 | 4 | 7 | 45 | 1 | 0 |
| **People's Bank** | 174 | 82 | 2 | 2 | 87 | 0 | 1 |
| **BOC** | 84 | 43 | 0 | 3 | 38 | 0 | 0 |
| **NSB** | 22 | 9 | 0 | 7 | 5 | 0 | 1 |
| **Total** | **810** | **607** | **6** | **19** | **175** | **1** | **2** |

*(Note: 6 commercial banks — Sampath, Seylan, NDB, DFCC, PABC, and ComBank — currently have 0 rows in this production database instance, awaiting initial import).*

### 2.2 Critical Data Quality Flags
- **Missing `raw_offer` evidence:** **0 / 810 (0.0%)** — 100% of rows have full immutable evidence intact.
- **Missing merchant name:** **0 / 810 (0.0%)** — 100% of rows have valid merchant names.
- **Manual overrides:** 1 offer has active manual overrides (`offers.manual_override`), which must never be overwritten.
- **Pending candidates:** 63 offers have newer scraped versions safely staged in `pending_candidate`.
- **False coordinates:** **0 / 810 (0.0%)** — Zero coordinates are assigned to `ONLINE`, `NATIONWIDE`, or `UNRESOLVED` scopes.

### 2.3 Related Operations Tables
- `scrape_runs`: 15 recorded runs (12 completed, 2 failed due to server restart, 1 warning).
- `offer_review_history`: 223 audit log entries (181 expired, 37 flagged duplicate, 2 approved, 3 merged).
- `offer_duplicate_candidates`: 1,006 candidate pairs (999 pending exact duplicates, 6 likely duplicates, 1 confirmed).
- `geo_cache`: 11 cached geocoding results with country centroid rejection (`COUNTRY_CENTROID` blocked).

---

## 3. Image Acquisition, Download & Resilience (Part C)

### 3.1 Live Image Probe Findings
A batch probe of image URLs extracted by the bank scrapers revealed distinct behavior across banks:
1. **BOC**: 100% of images resolve to `https://s3.ap-southeast-1.amazonaws.com/static.boc.lk/...` (HTTP 200, valid `image/jpeg`).
2. **People's Bank**: 100% of images resolve to `https://www.peoplesbank.lk/roastoth/...` (HTTP 200, valid `image/jpeg`).
3. **NSB**: 100% of images resolve to `https://www.nsb.lk/wp-content/uploads/...` (HTTP 200, valid `image/jpeg`).
4. **HNB**: Image URLs pointing to `https://www.hnb.lk/merchants/...` return HTTP 200 with `text/html` (HTML challenge/not-found page) unless specific browser cookies and headers are passed.

### 3.2 Hardened `ImageResilienceService`
To protect against SSRF, corrupted images, and broken UI experiences, `admin/api/src/infrastructure/images/image-resilience-service.ts` was implemented and tested (11 unit tests passing):
- **SSRF Protection**: Validates protocols (`http:`, `https:`), resolves DNS, and blocks loopback (`127.0.0.1`), private RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, and cloud metadata (`169.254.169.254`).
- **Magic-Byte Signature Verification**: Verifies the binary header of every downloaded buffer:
  - JPEG: `FF D8 FF`
  - PNG: `89 50 4E 47 0D 0A 1A 0A`
  - WebP: `RIFF....WEBP`
  - GIF: `GIF87a` / `GIF89a`
  - SVG: `<svg xmlns="http://www.w3.org/2000/svg"...`
  - HTML or executable payloads disguised as images are rejected as `REJECTED_INVALID_TYPE`.
- **Content Hashing & Deduplication**: SHA-256 hash computed on buffer. Identical images are stored once as `<sha256>.<ext>`.
- **Atomic File Writes**: Buffers written to `.tmp` files before atomic rename (`fs.renameSync`).
- **Bank-Branded Fallbacks**: If an image download fails or is rejected, `ImageResilienceService.getFallbackImage(bank)` provides clean local SVG/PNG placeholders (`/static/placeholders/banks/{bank}-card-placeholder.png`).

---

## 4. Safe Database Cleanup Rehearsal (Part D)

The cleanup classification was executed in an isolated **PGlite WASM disposable PostgreSQL engine** using the exact production schema:

### 4.1 Rehearsal Results
1. **Snapshot Loading**: 810 offers, 223 review history rows, and 1,006 duplicate candidates loaded from Neon into PGlite.
2. **Identification of Expired Offers**: Exactly **6 offers** in `PUBLISHED` status had `valid_to < CURRENT_DATE`.
3. **Soft Expiration**:
   - Status updated: `db_status = 'EXPIRED'`, `updated_at = NOW()`.
   - Audit trail appended: 6 entries inserted into `offer_review_history` with action `'expire'`, reason `'Automated cleanup: valid_to past CURRENT_DATE'`, actor `'cleanup-rehearsal'`.
4. **Idempotency Verified**: Running the cleanup query a second time affected **0 rows**.
5. **Preservation**:
   - `manual_override`: 1/1 preserved.
   - `raw_offer`: 810/810 preserved.

### 4.2 Cleanup Matrix

| Primary Disposition | Pre-Cleanup Count | Rehearsed Action | Post-Cleanup Count |
|---|---|---|---|
| `KEEP_VALID_PUBLISHED` | 613 | Soft-expire 6 past-due rows | **607** |
| `EXPIRED` | 175 | Transition 6 past-due rows | **181** |
| `REVIEW_REQUIRED` | 19 | Preserve pending review | **19** |
| `APPROVED` | 1 | Preserve staging queue | **1** |
| `DISABLED` | 1 | Preserve administrative disable | **1** |
| `REJECTED` | 1 | Preserve rejected evidence | **1** |
| **Total** | **810** | **6 status transitions** | **810** |

---

## 5. Complete Fresh Rescrape of All Ten Banks (Part E)

### 5.1 Source Endpoint Connectivity Probe
All 10 bank promotion endpoints were probed live:

| Bank | Display Name | Source Type | Status | HTTP Status | Response Time | Bytes Received |
|---|---|---|---|---|---|---|
| **HNB** | Hatton National Bank | `json-api` | **LIVE_CAPTURE** | 200 | 850 ms | 2.5 KB |
| **BOC** | Bank of Ceylon | `html` | **LIVE_CAPTURE** | 200 | 964 ms | 217.8 KB |
| **Sampath** | Sampath Bank | `headless-browser` | **LIVE_CAPTURE** | 200 | 1,751 ms | 1.17 MB |
| **People's** | People's Bank | `html` | **LIVE_CAPTURE** | 200 | 2,946 ms | 244.2 KB |
| **Seylan** | Seylan Bank | `html` | **LIVE_CAPTURE** | 200 | 2,045 ms | 325.3 KB |
| **NDB** | NDB Bank | `headless-browser` | **LIVE_CAPTURE** | 200 | 479 ms | 89.6 KB |
| **DFCC** | DFCC Bank | `headless-browser` | **LIVE_CAPTURE** | 200 | 2,855 ms | 414.8 KB |
| **PABC** | Pan Asia Bank | `headless-browser` | **LIVE_CAPTURE** | 307 (Redirect) | 309 ms | 1.5 KB |
| **NSB** | National Savings Bank | `html` | **LIVE_CAPTURE** | 200 | 1,049 ms | 79.3 KB |
| **ComBank** | Commercial Bank | `html` | **LIVE_CAPTURE** | 200 | 1,025 ms | 439.4 KB |

**Outcome**: 100% of all 10 bank endpoints are live and responsive.

### 5.2 Fresh Scrapes Executed Across All Ten Banks
Fresh scrapes were executed through the full ingestion pipeline (capture → parsing → normalization → date validation → financial validation → deduplication → dry-run export):

| Bank | Raw Found | Duplicates Removed | Normalized | Validated | Expired | Validation Pass Rate | Duration |
|---|---|---|---|---|---|---|---|
| **HNB** | 2,039 | 1,045 | 994 | 976 | 18 | 98.19% | 142.9 s |
| **BOC** | 85 | 0 | 85 | 85 | 0 | 100.0% | 34.9 s |
| **People's** | 201 | 0 | 201 | 195 | 6 | 97.01% | 200.8 s |
| **NSB** | 22 | 0 | 22 | 14 | 8 | 63.64% | 29.9 s |
| **Seylan** | 319 | 0 | 319 | 310 | 9 | 97.18% | 408.5 s |
| **ComBank** | 66 | 0 | 66 | 66 | 0 | 100.0% | 23.1 s |
| **PABC** | 34 | 0 | 34 | 34 | 0 | 100.0% | 28.1 s |
| **Sampath** | 254 | 127 | 127 | 120 | 7 | 94.49% | 303.6 s |
| **NDB** | 166 | 42 | 124 | 123 | 1 | 99.19% | 657.1 s |
| **DFCC** | 4 | 0 | 4 | 1 | 3 | 25.00% | 1106.5 s |
| **Total** | **3,190** | **1,214** | **1,976** | **1,924** | **52** | **97.37%** | **2,935.4 s** |

- **HNB**: 2,039 raw offers scraped across 14 categories. 1,045 cross-category duplicates removed. **994 normalized offers**, **976 passed validation**, 18 expired/invalid. Artifacts exported to `output/dry-runs/hnb/`.
- **BOC**: 85 raw offers scraped across 13 categories. **85 normalized offers**, **85 passed validation (100% pass rate)**. Artifacts exported to `output/dry-runs/boc/`.
- **People's Bank**: 201 raw offers scraped across 12 categories. **201 normalized offers**, **195 passed validation**, 6 expired. Artifacts exported to `output/dry-runs/peoples/`.
- **NSB**: 22 raw offers scraped. **22 normalized offers**, **14 passed validation**, 8 expired. Artifacts exported to `output/dry-runs/nsb/`.
- **Seylan Bank**: 319 raw offers scraped across 24 categories. **319 normalized offers**, **310 passed validation**, 9 expired. Artifacts exported to `output/dry-runs/seylan/`.
- **Commercial Bank**: 66 raw offers scraped. **66 normalized offers**, **66 passed validation (100% pass rate)**. Artifacts exported to `output/dry-runs/combank/`.
- **Pan Asia Bank (PABC)**: 34 raw offers scraped. **34 normalized offers**, **34 passed validation (100% pass rate)**. Artifacts exported to `output/dry-runs/pabc/`.
- **Sampath Bank**: 254 raw offers scraped across 13 categories. 127 category catch-all duplicates removed. **127 normalized offers**, **120 passed validation**, 7 expired. Artifacts exported to `output/dry-runs/sampath/`.
- **NDB Bank**: 166 raw offers scraped across 18 categories. 42 cross-category duplicates removed. **124 normalized offers**, **123 passed validation**, 1 expired. Artifacts exported to `output/dry-runs/ndb/`.
- **DFCC Bank**: 4 active offers extracted from rendered promo hubs. **4 normalized offers**, **1 passed validation**, 3 past-due expired. Artifacts exported to `output/dry-runs/dfcc/`.

---

## 6. Operator Procedure for Live Production Application

When the operator decides to apply the verified cleanup and import fresh offers into the live Neon database:

### Step 1: Run the Live Database Expiry Transition
Execute the safe soft-expiration query against production Neon:
```sql
BEGIN;

-- 1. Insert audit entries for the 6 past-due published offers
INSERT INTO offer_review_history (offer_id, action, from_status, to_status, reason, actor)
SELECT id, 'expire', 'PUBLISHED', 'EXPIRED', 'Automated cleanup: valid_to past CURRENT_DATE', 'operator-cleanup'
FROM offers
WHERE db_status = 'PUBLISHED'
  AND valid_to IS NOT NULL
  AND valid_to < CURRENT_DATE;

-- 2. Transition published status to EXPIRED
UPDATE offers
SET db_status = 'EXPIRED',
    updated_at = NOW()
WHERE db_status = 'PUBLISHED'
  AND valid_to IS NOT NULL
  AND valid_to < CURRENT_DATE;

COMMIT;
```

### Step 2: Import Fresh Scrapes to Staging
Run the CLI scrapers without `--dry-run` to upsert candidates into `offers` with lifecycle status `REVIEW_REQUIRED` or `APPROVED` (existing published offers are protected and staged into `pending_candidate`):
```bash
cd admin/api
npm run scrape:hnb
npm run scrape:boc
npm run scrape:peoples
npm run scrape:nsb
npm run scrape:seylan
```

### Step 3: Review and Publish in Cloudscape Dashboard
1. Open the Admin Operations Console (`admin/dashboard`).
2. Navigate to `/review-queue` to approve or reject pending candidates.
3. Navigate to `/staging` to publish approved offers to the public consumer API.
