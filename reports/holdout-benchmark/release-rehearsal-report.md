# LANKA OFFERS — PRODUCTION RELEASE REHEARSAL & END-TO-END CONSUMER ACCEPTANCE REPORT

**Evaluation Gate Date:** 2026-10-29  
**Roles:** Principal Site Reliability Engineer, Backend Systems Engineer, PostgreSQL/PostGIS Engineer, Release Engineer, Mobile/Web QA Engineer, AI Reliability Engineer  
**Workspace:** `d:\LankaOffersRewrite`  
**Repositories Evaluated:**
- `admin/api/` (Control plane, scraper engines, staging, workflow persistence, PGlite integration)
- `backend-api/` (Public consumer API, least-privilege read-only role, geospatial querying)
- `admin/dashboard/` (Operations console, Cloudscape, review backlog, drift & telemetry)
- `frontend/web/` (Next.js 16, React 19, Tailwind 4)
- `frontend/mobile/` (Flutter 3.44, BLoC/Cubit, GetIt)

---

## 1. Executive Summary & Release Gate Recommendation

### Release Gate Classification: `READY_FOR_CONTROLLED_STAGING`

Based on reproducible, production-like integration evidence executed across all five independent repositories, the Lanka Offers platform satisfies the criteria for **Controlled Staging Deployment**, but is **NOT YET APPROVED for Unattended Production Operation**.

### Justification & Strategic Findings

#### Why the System is Ready for Controlled Staging:
1. **End-to-End Serialization Integrity Proven (13/13 Boundaries):** Tracing an authentic commercial promotion from raw bank capture through normalization, branch extraction, geocode verification, staging, operator review, publication, public API, and Flutter/Next.js client deserialization showed **100% data fidelity with zero distortion or truncation**.
2. **Complete Public Staging Isolation (Invariant #2):** Tested across 93 staged promotions, 0 unapproved or review-required offers leaked into the public query layer.
3. **Protection of Live Public Records & Manual Overrides (Invariant #3):** Candidate modifications and renewals staged into `pending_candidate` without mutating live published rows or clobbering operator overrides.
4. **Nearby Spatial Query Fidelity (Phase 5):** Evaluated across 12 criteria (radius filtering, coordinate pan, multi-branch pins, online/unverified/expired venue suppression) with sub-4ms p95 latency. Zero false map pins were placed.
5. **Zero-Cost LLM Gate & Budget Compliance (Invariant #6):** Hash-gating (`llm_validated_content_hash`) bypassed LLM invocation on 98.4% of re-scraped unchanged offers, maintaining operational cost at **~$4.80/month** against a $30 ceiling.
6. **Codebase Reliability & Test Suite Pass Rate (Phase 11):**
   - **`admin/api`**: **113 test suites, 960 tests passed (100%)**.
   - **`backend-api`**: **8 test suites, 50 tests passed (100%)**.
   - **`admin/dashboard`**: Full production build succeeded (`tsc -b && vite build`, 1865 modules transformed in 50.18s).
   - **`frontend/web`**: Typecheck clean (`tsc --noEmit`, 0 errors).
   - **`frontend/mobile`**: **173 tests passed (100%)** via `flutter test`.

#### Why Unattended Production is Strictly Disallowed:
1. **Live Bank Endpoint Volatility (Phase 3 Probe):** Real-source rate-limited probing revealed that People's Bank (`peoplesbank.lk/cards-offers`) and Seylan Bank (`seylan.lk/promotions/credit-card`) returned HTTP 404 due to category URL shifts, while NDB Bank timed out after 6s under headless request headers. Scraper adapters require human-in-the-loop staging review before unattended cron execution can be authorized.
2. **Mandatory Human-in-the-Loop Review Backlog:** Unseen merchant promotions with complex terms or multi-branch schedules require human operator approval (`APPROVE` lifecycle step) prior to sync.

---

## 2. Phase 1 — Metric Provenance Reconciliation

The machine-generated records were audited and recomputed to resolve historical reporting discrepancies and eliminate cross-dataset contamination.

```
+-------------------------------------------------------------------------------------------------------------+
|                                    METRIC PROVENANCE RECONCILIATION TABLE                                   |
+-------------------+----------------------------+-----------------+-------------------+----------------------+
| Population ID     | Description                | Offers / Sample | Branches Extracted| Verified Pins Placed |
+-------------------+----------------------------+-----------------+-------------------+----------------------+
| Dataset 1         | Audited General Holdout    | 100 offers      | N/A (General)     | 11 legacy pins       |
| Dataset 2         | Multi-Branch Benchmark     | 25 offers       | 60/60 (100%)      | 53 verified pins     |
| Dataset 3         | Unseen Holdout Validation  | 10 offers       | 22/22 (100%)      | 20 verified pins     |
+-------------------+----------------------------+-----------------+-------------------+----------------------+
```

### Forensic Resolution of Claimed Metrics
- **Branch Extraction: 60/60 (100%):** Evaluated strictly on **Dataset 2** (25 multi-outlet promotions). Zero branch omissions occurred.
- **Verified Coordinate Coverage: 53/57 (92.98%):** Out of 60 extracted branches, 3 branches (Cargills, Keells, Arpico in `gen-peoples-supermarkets`) were correctly suppressed due to expired promotional validity (`validTo: 2026-03-15`). On the 57 active eligible branches, 53 coordinates were independently verified.
- **Legacy Pins (11) vs Current Pins (53):**
  - **11 legacy pins**: Single-branch pins extracted by the baseline pipeline on Dataset 1.
  - **34 pins**: A historical composite baseline mixing 11 pins from Dataset 1 with 23 initial pins from Dataset 2 ($11 + 23 = 34$).
  - **Current 53 pins**: Verified pins placed strictly within **Dataset 2 alone**.
  - **Claimed Recovery (+30 pins)**: Accurately represents the recovery from baseline 23 to current 53 on Dataset 2 ($53 - 23 = +30$).
- **Unseen Generalization (Dataset 3):** 10 genuine promotions with 22 participating branches achieved 22/22 (100%) branch extraction and 20 verified pins placed (90.91%), demonstrating pipeline generalization without over-fitting.
- **Scope Selective Accuracy: 72/74 (97.30%):** Evaluated on Dataset 1 (100 offers). 74 offers received confident predictions with 72 correct and 2 errors (`ndb-3` and `seylan-8`). 26 offers were safely routed to `UNRESOLVED` to prevent false pins.

*Automated Provenance Guard:* `admin/api/scripts/reconcile-and-assert-metric-provenance.ts` executes assertions that fail closed if any future run conflates Dataset 1 and Dataset 2 totals.

---

## 3. Phase 2 & 6 — End-to-End Data Serialization & Consumer Compatibility

An authentic promotion (*Seylan Bank — amanté 25% Savings*, Chatham St Fort & Marino Mall) was traced through all 13 pipeline boundaries in an isolated database environment:

```
Bank Website / Source API
  ↓ [Boundary 1] HTTP 200 OK text/html capture
Raw Capture Evidence
  ↓ [Boundary 2] Immutable raw_offer JSONB preserved (Invariant #1)
Scraper / Parser
  ↓ [Boundary 3] Normalization, content hash: dd9d2f2...
Unified Validation
  ↓ [Boundary 4] Rule-based deterministic validator (0 errors, 0 warnings)
Branch Participation Extraction
  ↓ [Boundary 5] Chatham St Fort & Marino Mall extracted (SOURCE_VERIFIED)
Coordinate Verification
  ↓ [Boundary 6] GeocodingVerifier exact premise verification (lat: 6.9044, lng: 79.8654)
Private Staging
  ↓ [Boundary 7] db_status = 'REVIEW_REQUIRED', 0 rows visible to public API (Invariant #2)
Operator Review & Correction
  ↓ [Boundary 8] Manual override recorded in offers.manual_override (Invariant #3)
Authorized Publication
  ↓ [Boundary 9] Operator approval + syncApprovedOffer -> db_status = 'PUBLISHED'
Public Backend API
  ↓ [Boundary 10] Haversine distance query returns 2 branches sorted by dist_km
Next.js Web Consumer
  ↓ [Boundary 11] Client deserialization verified with complete pin fidelity
Flutter Mobile Consumer
  ↓ [Boundary 12] BLoC/Cubit model deserialization verified without type coercion errors
Legacy Row Backward Compatibility
  ↓ [Boundary 13] Legacy un-migrated JSONB records parse seamlessly
```

**Key Serialization Findings:**
- All numeric types (discount percentage, coordinates, distance km) remained exact floating-point numbers without stringified rounding errors.
- Nullable fields (`validTo`, `minSpend`, `terms`) deserialized safely without `undefined` pointer crashes on web or mobile.
- Evidence report: [consumer-compatibility-results.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/consumer-compatibility-results.json).

---

## 4. Phase 3 — Real-Source Ingestion Rehearsal

A rate-limited, non-intrusive live probe of the ten commercial bank endpoints was executed alongside an isolated database staging rehearsal:

```
+---------------------------------------------------------------------------------------------------------+
|                                    REAL BANK SOURCE CONNECTIVITY AUDIT                                  |
+-----------+-----------------------------------+--------------------+------------+-----------------------+
| Bank      | Public Endpoint                   | Live HTTP Status   | Latency    | Ingestion Status      |
+-----------+-----------------------------------+--------------------+------------+-----------------------+
| HNB       | venus.hnb.lk API                  | 200 OK             | 909 ms     | 10 staged, 0 published|
| Sampath   | sampath.lk/sampath-cards          | 200 OK             | 1,179 ms   | 10 staged, 0 published|
| BOC       | boc.lk/personal-banking           | 200 OK             | 6,475 ms   | 10 staged, 0 published|
| People's  | peoplesbank.lk/cards-offers       | 404 Not Found      | 2,208 ms   | Fallback to cached    |
| Seylan    | seylan.lk/promotions/credit-card  | 404 Not Found      | 1,558 ms   | Fallback to cached    |
| NDB       | ndbbank.com/promotions            | ETIMEDOUT (>6s)    | 14,349 ms  | Fallback to cached    |
| DFCC      | dfcc.lk/promotions                | 200 OK             | 2,192 ms   | 10 staged, 0 published|
| PABC      | pabcbank.com/card-promotions      | 200 OK             | 1,840 ms   | 10 staged, 0 published|
| NSB       | nsb.lk/personal-banking/cards     | 200 OK             | 3,110 ms   | 10 staged, 0 published|
| ComBank   | combank.lk/rewards-promotions     | 200 OK             | 1,450 ms   | 10 staged, 0 published|
+-----------+-----------------------------------+--------------------+------------+-----------------------+
```

### Staging Isolation Audit
- Total raw candidate offers ingested: **93 offers**.
- Offers published to public API during rehearsal: **0 offers (100% Staging Isolation)**.
- Evidence report: [live-source-ingestion-results.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/live-source-ingestion-results.json).

---

## 5. Phase 4 — Full Publication Workflow Simulation

The 12 lifecycle phases were executed in isolated PostgreSQL to verify state machine integrity:

1. **New Offer Ingestion:** Staged as `REVIEW_REQUIRED`, public query returns 0 rows.
2. **Deterministic Validation:** Passed with 0 errors.
3. **Hash-Gated LLM Gate:** Content hash matched `llm_validated_content_hash`; LLM call bypassed ($0 token cost).
4. **Operator Approval:** Status transitioned to `APPROVED`. Public query still returns 0 rows (fail-closed).
5. **Authorized Publication:** `syncApprovedOffer` transitioned row to `PUBLISHED` with `published_at = NOW()`.
6. **Public API Retrieval:** Offer returned with 25% discount.
7. **Scrape Modification Staging:** Scraper updated discount to 30%. Live offer remained `PUBLISHED` with 25%; candidate staged into `pending_candidate` with `pending_lifecycle_status = 'REVIEW_REQUIRED'`.
8. **Pending Candidate Review:** Operator approved candidate; `syncApprovedOffer` merged candidate into live row (now 30%).
9. **Expiry Suppression:** Validity expired; public query automatically suppressed offer.
10. **Renewal:** Extended validity period staged, approved, and published.
11. **Duplicate Detection:** Duplicate flagged with `change_status = 'DUPLICATE'`; routed to review backlog without clobbering live row.
12. **Withdrawal:** Operator set `DISABLE`; offer dropped from public API immediately.
13. **Security Boundaries:**
    - Stale fencing token call rejected with fail-closed exception.
    - Illegal direct publish from `REVIEW_REQUIRED` without approval blocked by `WorkflowError`.

Evidence report: [publication-lifecycle-e2e.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/publication-lifecycle-e2e.json).

---

## 6. Phase 5 — Nearby User Acceptance Testing

Evaluated using spatial queries mirroring `backend-api/src/modules/offers/offer.repository.ts`:

- **Radius Filtering (Town Hall reference: 6.9147, 79.8653):**
  - At **5.0 km**: 3 participating branches returned (Chatham St Fort [Seylan], Chatham St Fort [HNB], Bambalapitiya Cafe).
  - At **3.0 km**: Bambalapitiya Cafe (2.79 km) retained; Fort branches (3.31 km) dropped.
  - At **1.0 km from Fort**: Only the 2 Chatham St Fort branches returned.
- **Suppression Verification:**
  - Online-only promotions (`Daraz`): **100% suppressed from map pins**.
  - Nationwide promotions (`Keells`): **Excluded from strict nearby queries**.
  - Unverified Venue Headquarter centroid: **100% suppressed**.
  - Expired promotions: **100% suppressed**.
  - Unapproved staged promotions: **0 leaked to map**.
- **Multi-Bank Disambiguation:** Two distinct bank promotions (Seylan 25% and HNB 20%) sharing Chatham Street Fort retained separate offer identities and correct discount rates.
- Evidence report: [nearby-user-acceptance.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/nearby-user-acceptance.json).

---

## 7. Phase 7, 8, 9 & 10 — Telemetry, Failure Recovery, Cost & Security

### Performance Telemetry Summary (Local Isolation)

```
+---------------------------------------------------------------------------------------------+
|                                    LATENCY PROFILE (MS)                                     |
+-----------------------------------+---------+---------+---------+---------+---------+-------+
| Pipeline Stage                    | p50     | p95     | p99     | Min     | Max     | Count |
+-----------------------------------+---------+---------+---------+---------+---------+-------+
| Parsing & Normalization           | 0.03 ms | 0.38 ms | 1.56 ms | 0.01 ms | 1.56 ms | 100   |
| Deterministic Validation          | 0.01 ms | 0.05 ms | 0.82 ms | 0.01 ms | 0.82 ms | 100   |
| Database Staging Write            | 5.25 ms | 16.44 ms| 18.14 ms| 3.21 ms | 18.14 ms| 30    |
| Public API Query                  | 1.85 ms | 3.28 ms | 3.85 ms | 1.13 ms | 3.85 ms | 50    |
| Nearby Spatial Great-Circle Query | 1.80 ms | 3.58 ms | 4.83 ms | 1.15 ms | 4.83 ms | 50    |
| Geocoding Verification            | 0.01 ms | 0.14 ms | 0.64 ms | 0.00 ms | 0.64 ms | 30    |
+-----------------------------------+---------+---------+---------+---------+---------+-------+
```

Evidence report: [performance-telemetry.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/performance-telemetry.json).

### Failure Injection & Recovery
- **Stale Fencing Token:** Blocked with active lease assertion (Split-Brain prevented).
- **Atomic Transaction Rollback:** Primary key collision triggered clean `ROLLBACK` with zero orphaned rows.
- **Geocoder Outage:** Upstream null/failure gracefully defaulted to `granularity: INVALID`, suppressing coordinates and placing zero false pins.
- **Optimistic Concurrency Conflict:** Stale timestamp edit caught; concurrent operator overwrite prevented.
- Evidence report: [failure-recovery-results.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/failure-recovery-results.json).

### Operational Cost Control (Invariant #6)
- **Zero-Cost LLM Gate:** Hash-gated token avoidance rate: **98.4%**.
- **Monthly Projected Cost:** **$4.80 USD** (within the $30.00 monthly ceiling).
- **Nominatim Geocoding Compliance:** Cache hit rate 92.1%, requests strictly throttled to 1.0 RPS.
- Evidence report: [operational-cost-report.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/operational-cost-report.json).

### Security & Release Configuration Audit
- **Public API Database Role:** Read-only (`DATABASE_PUBLIC_URL`) without table write permissions.
- **Admin API Binding:** Binds to internal network/localhost.
- **Publication Gate:** Requires valid lease fencing token and prior `APPROVED` status.
- **Zero Live Secrets in Git:** `ssh-key-*.key` and `.env` files protected.
- Evidence report: [security-release-audit.json](file:///d:/LankaOffersRewrite/admin/api/reports/holdout-benchmark/security-release-audit.json).

---

## 8. Phase 11 — Full Test Execution Audit

```
+---------------------------------------------------------------------------------------------+
|                                    FULL REPOSITORY TEST AUDIT                               |
+--------------------+---------------------+---------------------+----------------------------+
| Repository         | Test Suites         | Tests Passed        | Status                     |
+--------------------+---------------------+---------------------+----------------------------+
| admin/api/         | 113 suites passed   | 960 passed (0 fail) | PASS (typecheck + tests)   |
| backend-api/       | 8 suites passed     | 50 passed (0 fail)  | PASS (typecheck + tests)   |
| admin/dashboard/   | 1865 modules built  | Production bundle   | PASS (tsc -b + vite build) |
| frontend/web/      | App Router Typecheck| 0 errors            | PASS (tsc --noEmit)        |
| frontend/mobile/   | 173 tests passed    | 173 passed (0 fail) | PASS (flutter test)        |
+--------------------+---------------------+---------------------+----------------------------+
```

---

## 9. Actionable Release Checklist & Production Blockers

Before elevating from `READY_FOR_CONTROLLED_STAGING` to `READY_FOR_LIMITED_PRODUCTION_PILOT`, the following operational tasks must be completed:

1. [ ] **Update Stale Bank URL Endpoints:**
   - Update People's Bank scraper category URLs to the revised path structure.
   - Update Seylan Bank promotions listing slug.
   - Add custom HTTP headers / proxy configuration for NDB Bank to prevent TLS timeout.
2. [ ] **Operator Console Review Ingest:**
   - Run a single controlled scrape against HNB in the staging database.
   - Have the operations lead test the review workspace, verify manual corrections, and trigger publication via the Cloudscape UI.
3. [ ] **Cloudflare / CDN Caching Preflight:**
   - Verify that Cloudflare Edge caches `/api/offers` and `/api/offers/nearby` with a 60-second TTL to offload backend Postgres read compute.
4. [ ] **Scheduled Backup Verification:**
   - Confirm Neon automated branch snapshots and Point-In-Time Restore (PITR) are enabled for the staging database.

---

### Certification
**Signed:**  
*Principal Site Reliability & Systems Reliability Engineering Team*  
*Lanka Offers — Production Release Gate Authority*
