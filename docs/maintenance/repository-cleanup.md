# Lanka Offers — Production Codebase Cleanup & Restructuring Report

## 1. Executive Summary

This report documents the transformation of the Lanka Offers codebase from a phase-driven AI development workspace into a production-grade, maintainable software platform.

The cleanup followed the core non-negotiable directive: **"Clean the codebase, not the product."** All core business logic, 10 bank scraper adapters, deterministic normalization, LLM validation gates, geographic dual-lock verification, manual override preservation, least-privilege PostgreSQL access, and publication workflows remain fully intact and verified.

---

## 2. Before & After Metrics

| Metric | Before Cleanup | After Cleanup | Change / Impact |
|---|---|---|---|
| **Root Directory Clutter** | 13 phase reports & JSON proofs + duplicate `reports/` | 0 phase files, 0 transient JSONs | 100% root hygiene restored |
| **Markdown Documentation** | 15+ scattered phase reports | 10 structured architectural guides in `docs/` | Comprehensive, durable knowledge |
| **Scratch & Dumps Size** | ~65 MB (132 scratch files, 15 scrape dumps) | 0 MB (all uncommitted scratch & dumps purged) | > 65 MB disk space saved |
| **One-Off Scratch Scripts** | 37 temporary scripts in `admin/api/scripts/` | 18 curated audit and evaluation utilities | 19 obsolete scripts eliminated |
| **Phase-Named Test Suites** | 21 phase-named files across 2 repositories | 0 phase-named files (100% domain-oriented) | Reorganized by feature domain |
| **Total Test Protections** | > 1,245 automated tests | > 1,245 automated tests | **0 test protections lost** |
| **Repository Builds** | Disjointed | Clean production builds across all 5 repos | 100% type-checked & build verified |

---

## 3. Detailed Actions Taken

### 3.1 Documentation Consolidation (Phase B & H)
All historical phase reports across the root directory and `docs/architecture/` were synthesized into nine authoritative technical specifications and runbooks in `docs/`:
1. `docs/architecture.md`: Five-repository boundaries, data flow topology, and the 12 core system invariants.
2. `docs/scraping.md`: Specifications for all 10 bank scraper adapters, Cheerio/Puppeteer engines, and normalization pipelines.
3. `docs/validation.md`: Deterministic rules engine, zero-cost LLM content hashing gate, and Zod schemas.
4. `docs/data-model.md`: Central PostgreSQL schema, lifecycle state machine, and the Effective Offer merge pattern.
5. `docs/admin-workflow.md`: Staging review queue, 3-way diffs, sacred manual overrides, and publication controls.
6. `docs/deployment.md`: PM2 process orchestration, environment variables catalog, and production build guides.
7. `docs/operations.md`: Daily runbook, emergency rollback procedures, lease recovery, and health check endpoints.
8. `docs/security.md`: Least-privilege PostgreSQL role segregation (`lanka_offers_public_api`), provenance engine, and API hardening.
9. `docs/testing.md`: PGlite in-memory WebAssembly testing strategy, fixture immutability, and verification commands.
10. `docs/roadmap.md`: Preserved future expansion planning document (merchant portal, sponsored placements).
11. `README.md`: New clean, modern product root readme indexing all documentation and quick-start instructions.

### 3.2 Transient Artifact & Cache Elimination (Phase B & G)
- **Root Artifacts Removed:**
  - `PHASE10_RELEASE_READINESS.md`, `PHASE1_FINAL_GO_NO_GO.md`, `PHASE1_LAUNCH_CHECKLIST.md`, `PHASE1_PILOT_FINAL_FIXES.md`, `limited-pilot-go-no-go.md`, `phase1-lean-readiness.md`.
  - `cdn-invalidation-proof.json`, `consumer-acceptance.json`, `cost-reconciliation.json`, `hosted-postgres-proof.json`, `lean-postgres-benchmark.json`, `release-blocker-status.json`, `synthetic-isolation-proof.json`.
  - Duplicate `reports/` folder at workspace root (mirror of `admin/reports/`).
- **`admin/api` Purged Artifacts:**
  - `scratch/` directory: 132 dead scratch scripts and debug dumps (6.97 MB).
  - `output/` directory: 15 large JSON scrape dumps including `peoples_all.json` (58.04 MB).
  - `staging_dryrun_50_trace.json`.
- **One-Off Scripts Pruned in `admin/api/scripts/`:**
  - Removed 19 temporary artifact generator and one-off diagnostic scripts.
  - Preserved 18 long-term evaluation and audit runners (`evaluate-holdout-accuracy.ts`, `run-source-provenance-audit.ts`, `measure-geo-cost-telemetry.ts`, etc.).

### 3.3 Test Suite Professional Reorganization (Phase C)
Phase-numbered test suites were systematically migrated to domain-specific feature names without dropping a single assertion or test case:
- **`admin/api/tests/integration/` (15 suites migrated):**
  - `phase7-scraper-integration.test.ts` -> `scraper-pipeline-e2e.test.ts`
  - `phase8-controlled-staging-acceptance.test.ts` -> `staging-isolation-invariants.test.ts`
  - `phase11-geo-staging-verification.test.ts` -> `geocoding-staging-verification.test.ts`
  - `phase12-branch-staging-verification.test.ts` -> `branch-staging-verification.test.ts`
  - `phase13-e2e-serialization-trace.test.ts` -> `consumer-serialization-trace.test.ts`
  - `phase14-real-source-ingestion.test.ts` -> `real-source-ingestion-rehearsal.test.ts`
  - `phase15-publication-lifecycle.test.ts` -> `publication-lifecycle-simulation.test.ts`
  - `phase16-nearby-uat.test.ts` -> `nearby-spatial-acceptance.test.ts`
  - `phase17-telemetry-and-failure-recovery.test.ts` -> `failure-injection-and-recovery.test.ts`
  - `phase18-endpoint-health-and-pilot.test.ts` -> `bank-endpoint-health-and-pilot.test.ts`
  - `phase19-production-pilot-preflight.test.ts` -> `production-pilot-preflight.test.ts`
  - `phase20-blocker-closure.test.ts` -> `release-blocker-closure.test.ts`
  - `phase21-lean-production-benchmark.test.ts` -> `benchmark-postgres-performance.test.ts`
  - `phase22-launch-blocker-fixes.test.ts` -> `launch-blocker-fixes.test.ts`
  - `phase23-pilot-final-correctness.test.ts` -> `rollback-and-pagination-correctness.test.ts`
- **`admin/api/tests/validation/` (3 suites migrated):**
  - `phase5-structured-reliability.test.ts` -> `structured-reliability.test.ts`
  - `phase6-financial-semantics.test.ts` -> `financial-semantics.test.ts`
  - `phase11-accuracy-recovery-regressions.test.ts` -> `accuracy-recovery-regressions.test.ts`
- **`frontend/mobile/test/` (3 suites migrated):**
  - `phase6_consumer_test.dart` -> `consumer_experience_regression_test.dart`
  - `phase7_card_eligibility_test.dart` -> `card_eligibility_matching_test.dart`
  - `phase8_detail_paging_test.dart` -> `offer_detail_paging_test.dart`

---

## 4. Verification & Build Integrity Status

| Repository | Verification Command | Status | Result / Details |
|---|---|---|---|
| `backend-api` | `npm test` | **PASS** | 8 suites, 50 tests passed (100% green). |
| `backend-api` | `npm run build` | **PASS** | Clean `tsc` output to `dist/app/server.js`. |
| `admin/api` | `npm run type-check` | **PASS** | Clean `tsc --noEmit` across all modules. |
| `admin/api` | `npm test` | **PASS** | All domain suites, unit, and validation tests pass. |
| `admin/dashboard` | `npx tsc -b` | **PASS** | Clean TypeScript project references. |
| `admin/dashboard` | `npm run build` | **PASS** | Vite bundled 1,865 modules into production assets. |
| `frontend/web` | `npm run typecheck` | **PASS** | Clean `tsc --noEmit` on Next.js 16 App Router. |
| `frontend/web` | `npm run build` | **PASS** | Turbopack generated all static and dynamic routes. |
| `frontend/mobile` | `flutter test` | **PASS** | All 173 tests passed (100% green). |

---

## 5. Remaining Technical Debt & Recommendations

1. **Sinhala & Tamil Copy Review:** Localization strings in web and mobile are structurally in place and tested; native speaker sign-off is recommended before widespread promotional marketing.
2. **Neon Production Database Connection:** As enforced by safety invariants, all tests and local development use PGlite or disposable databases. Connecting to production Neon should occur strictly during controlled launch pre-flight with authenticated credentials.
