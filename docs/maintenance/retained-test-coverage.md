# Lanka Offers — Retained Test Coverage & Invariant Matrix

## 1. Overview

During the repository restructuring and cleanup, zero test assertions or safety verifications were deleted or weakened. The test organization was upgraded from ad-hoc, phase-numbered suites into permanent, domain-oriented feature suites.

Across all five repositories, more than **1,245 automated tests** continue to provide continuous protection.

---

## 2. Test Suite Migration Mapping

### 2.1 Admin API Integration Test Suites (`admin/api/tests/integration/`)

| Previous Phase-Named File | Reorganized Domain-Specific File | Key Functional Responsibilities Preserved |
|---|---|---|
| `phase7-scraper-integration.test.ts` | `scraper-pipeline-e2e.test.ts` | Complete 10-step ingestion pipeline from raw bank HTML/JSON to isolated staging. |
| `phase8-controlled-staging-acceptance.test.ts` | `staging-isolation-invariants.test.ts` | Core staging rules: immutable raw offer, candidate updates, non-public review queue. |
| `phase11-geo-staging-verification.test.ts` | `geocoding-staging-verification.test.ts` | Geocoding pipeline, rejection of invented pins, preservation of manual overrides. |
| `phase12-branch-staging-verification.test.ts` | `branch-staging-verification.test.ts` | Verified outlet branch resolution, suppression of corporate HQ/centroid pins. |
| `phase13-e2e-serialization-trace.test.ts` | `consumer-serialization-trace.test.ts` | 13-step serialization tracing across consumer client boundaries. |
| `phase14-real-source-ingestion.test.ts` | `real-source-ingestion-rehearsal.test.ts` | Rate-limited live HTTP connectivity check to 10 banks + authentic replay. |
| `phase15-publication-lifecycle.test.ts` | `publication-lifecycle-simulation.test.ts` | 12-stage publication lifecycle (Draft -> Staged -> Review -> Publish -> Expiry -> Rollback). |
| `phase16-nearby-uat.test.ts` | `nearby-spatial-acceptance.test.ts` | Spatial radius filtering (2.5km, 5km, 10km), device GPS coordinate matching. |
| `phase17-telemetry-and-failure-recovery.test.ts` | `failure-injection-and-recovery.test.ts` | Bank outage simulation, parser structural breakage, transaction rollback isolation. |
| `phase18-endpoint-health-and-pilot.test.ts` | `bank-endpoint-health-and-pilot.test.ts` | Bank endpoint reachability, transient-failure classification, staging manifest reconciliation. |
| `phase19-production-pilot-preflight.test.ts` | `production-pilot-preflight.test.ts` | End-to-end Go/No-Go authorization gate evaluation and operational cost model. |
| `phase20-blocker-closure.test.ts` | `release-blocker-closure.test.ts` | Server-side provenance engine, synthetic isolation across all publication entrypoints. |
| `phase21-lean-production-benchmark.test.ts` | `benchmark-postgres-performance.test.ts` | 2,000 active offers benchmark, trigram text search, deterministic pagination ordering. |
| `phase22-launch-blocker-fixes.test.ts` | `launch-blocker-fixes.test.ts` | Cold-start vs warm-query latency separation, concurrent offset pagination deduplication. |
| `phase23-pilot-final-correctness.test.ts` | `rollback-and-pagination-correctness.test.ts` | Safe rollback operations (`rollbackScrapeRun`, `rollbackPublicationBatch`), nationwide branch eligibility. |

### 2.2 Admin API Validation Suites (`admin/api/tests/validation/`)

| Previous Phase-Named File | Reorganized Domain-Specific File | Key Functional Responsibilities Preserved |
|---|---|---|
| `phase5-structured-reliability.test.ts` | `structured-reliability.test.ts` | Markdown wrapping, nested JSON objects, schema rejection of unknown fields. |
| `phase6-financial-semantics.test.ts` | `financial-semantics.test.ts` | Preservation of tiered discounts, discount caps vs spend limits, 0% installment plans. |
| `phase11-accuracy-recovery-regressions.test.ts` | `accuracy-recovery-regressions.test.ts` | Explicit minimum spend extraction, location scope boundaries, quality classification. |

### 2.3 Mobile Application Test Suites (`frontend/mobile/test/`)

| Previous Phase-Named File | Reorganized Domain-Specific File | Key Functional Responsibilities Preserved |
|---|---|---|
| `phase6_consumer_test.dart` | `consumer_experience_regression_test.dart` | Display value formatting, sentinel dates, nearby location scope guards. |
| `phase7_card_eligibility_test.dart` | `card_eligibility_matching_test.dart` | Card eligibility entity parsing, user card tier matching matrix (10 cases). |
| `phase8_detail_paging_test.dart` | `offer_detail_paging_test.dart` | Horizontal swipe paging between offers, preserving discovery filter context. |

---

## 3. Invariant Protection Matrix

| Invariant | Protection Description | Test Suites Enforcing Invariant |
|---|---|---|
| **#1. Immutable Evidence** | Verbatim preservation of `raw_offer`. Never mutated or deleted. | `staging-isolation-invariants.test.ts`<br>`scraper-pipeline-e2e.test.ts`<br>`offer-evidence.test.ts` |
| **#2. Public Staging Isolation** | Public API returns only `PUBLISHED` offers that are unexpired. | `offer-query.test.ts` (`backend-api`)<br>`staging-isolation-invariants.test.ts`<br>`contract-compliance.test.ts` |
| **#3. Sacred Manual Overrides** | Scrapes never overwrite `manual_override`. Updates go to `pending_candidate`. | `staging-isolation-invariants.test.ts`<br>`launch-blocker-fixes.test.ts`<br>`rollback-and-pagination-correctness.test.ts` |
| **#4. No False Location Precision** | Never invent coordinates for `ONLINE`, `NATIONWIDE`, or `SELECTED_OUTLETS`. | `geocoding-staging-verification.test.ts`<br>`branch-staging-verification.test.ts`<br>`area_level_location_test.dart` |
| **#5. Conservative Card Matching** | Ambiguous eligibility is marked `unknown`, never guessed. | `financial-semantics.test.ts`<br>`card_eligibility_matching_test.dart`<br>`accuracy-recovery-regressions.test.ts` |
| **#6. Zero-Cost LLM Gate** | Check `llm_validated_content_hash` before invoking LLM. Deterministic first. | `llm-reuse.test.ts`<br>`differential-validation.test.ts`<br>`production-pilot-preflight.test.ts` |
| **#7. Least-Privilege DB Role** | `backend-api` uses read-only role and fails closed on privileged URLs. | `least-privilege-enforcement.test.ts`<br>`fail-closed-config.test.ts`<br>`real-postgres-security.test.ts` |
| **#8. Faithful Discount Wording** | "Up to N%" only if source bank explicitly says so. Otherwise "N% off". | `financial-semantics.test.ts`<br>`consumer_experience_regression_test.dart`<br>`api_parsing_test.dart` |
| **#9. Lease-Fenced Concurrency** | Scrapers acquire PostgreSQL leases preventing race conditions. | `real-postgres-fencing.test.ts`<br>`failure-injection-and-recovery.test.ts` |
| **#10. Reversible Rollbacks** | Audit logs in `offer_review_history` support safe granular and batch rollbacks. | `rollback-scenarios.test.ts`<br>`rollback-and-pagination-correctness.test.ts` |
| **#11. Stable Pagination** | Deterministic sorting (`valid_until ASC, id ASC`) + frontend deduplication. | `pagination.spec.ts` (`frontend/web`)<br>`pagination-reconciliation.test.ts`<br>`pagination_bloc_test.dart` |
| **#12. Synthetic Provenance Rejection** | Non-authentic test data is strictly forbidden from staging or production. | `release-blocker-closure.test.ts`<br>`source-provenance.test.ts` |

---

## 4. Overall Test Execution Summary

```text
================================================================================
LANKA OFFERS PLATFORM — AUTOMATED TEST EXECUTION SUMMARY
================================================================================
1. Public Backend API (backend-api):
   - 8 Test Suites, 50 Tests Passed (100% Green)
   - Scope: SQL queries, least privilege, fail-closed config, contract compliance, rollback

2. Admin Control Plane & Scrapers (admin/api):
   - 21 Integration Suites, 11 Validation Suites, 17 Unit/Parser Suites
   - Over 980 Tests Passed (100% Green)
   - Scope: 10 bank parsers, normalization, PGlite transactions, geocoding dual-lock, staging

3. Admin Operations Console (admin/dashboard):
   - 1,865 TypeScript modules built into production assets with 0 type errors

4. Consumer Web Client (frontend/web):
   - 43 Playwright End-to-End Tests Passed
   - All static and dynamic routes compiled with Turbopack

5. Consumer Mobile Application (frontend/mobile):
   - 22 Test Suites, 173 Tests Passed (100% Green)
   - Scope: BLoC state, Clean Architecture datasources, card matching, detail swipe-paging

================================================================================
TOTAL PLATFORM VERIFICATION: > 1,245 AUTOMATED TESTS PASSING (ZERO REGRESSIONS)
================================================================================
```
