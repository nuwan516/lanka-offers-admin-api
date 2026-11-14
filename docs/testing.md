# Lanka Offers — Testing Strategy & Test Suites

## 1. Overview & Philosophy

Lanka Offers maintains an exhaustive automated testing suite (> 1,200 tests across the 5 repositories). The testing strategy emphasizes:
1. **Isolated In-Memory Real PostgreSQL:** Database logic is tested using `@electric-sql/pglite` (WebAssembly Postgres), executing real SQL schemas, constraints, transactions, and foreign keys without requiring an external database daemon.
2. **Immutable Bank Source Fixtures:** Bank HTML and JSON fixtures are captured from authentic endpoints and frozen in `tests/fixtures/`.
3. **No Cross-Repo Test Imports:** Each repository's test suite operates completely independently, mocking external HTTP boundaries or using contract fixtures.

---

## 2. Test Architecture by Repository

| Repository | Test Runner | Scope & Test Types | Command |
|---|---|---|---|
| `backend-api/` | Jest (ts-jest) | Unit (SQL builders, config fail-closed, role validation), Integration (HTTP endpoints), Contract (public response shape), Smoke tests. | `npm test` |
| `admin/api/` | Jest (ts-node / PGlite) | Unit (bank parsers, normalization, quality gate), Integration (staging, rollback safety, lease fencing), Validation (LLM schema, financial semantics), Security (provenance, role boundaries). | `npm test` |
| `admin/dashboard/` | Vitest + Testing Library | Component and workflow tests for Cloudscape UI: Review queue, Scraper controls, 3-way diff view, Schedule. | `npm test` |
| `frontend/web/` | Playwright | End-to-end integration tests: Offer discovery, search, category filters, detail views, pagination, language toggle (en/si/ta), mobile responsive viewport. | `npm run test:e2e` |
| `frontend/mobile/` | Flutter Test (Dart) | BLoC/Cubit state transitions, entity mappings, card matching algorithms, detail view paging, timezone-aware expiry calculations. | `flutter test` |

---

## 3. The PGlite Real-Postgres Harness

Located in `admin/api/src/test/real-postgres-harness.ts`:

### How it Works
1. Spawns an isolated in-memory PostgreSQL WASM instance.
2. Applies the full `schema.sql` DDL (creating tables, indexes, enums, triggers).
3. Provides a clean `pg.Pool` or `pg.Client` interface to test suites.
4. Executes real transactions, isolation checks, rollback verifications, and advisory locks.
5. Destroys the instance on test teardown, guaranteeing zero test pollution between suites.

---

## 4. Feature-Based Test Suites in `admin/api`

Test suites are categorized into standard feature domains:

```text
admin/api/tests/
├── unit/                 # Bank parsers, address normalizers, period extractors
├── integration/          # Staging, rollback safety, postgres performance, lifecycle
│   ├── rollback-safety.test.ts
│   ├── source-provenance.test.ts
│   ├── benchmark-postgres-performance.test.ts
│   ├── pagination-reconciliation.test.ts
│   ├── participating-branches.test.ts
│   ├── scraper-real-source-ingestion.test.ts
│   ├── publication-lifecycle.test.ts
│   └── endpoint-health.test.ts
├── validation/           # Financial semantics, structured reliability, LLM schemas
│   ├── financial-semantics.test.ts
│   ├── structured-reliability.test.ts
│   ├── accuracy-recovery.test.ts
│   └── differential-validation.test.ts
├── security/             # Role boundary enforcement, synthetic isolation
├── fixtures/             # Immutable raw bank payloads (HTML, JSON)
└── helpers/              # PGlite test harness, mock data generators
```

---

## 5. Verification Commands

Run all test suites across the project:

```bash
# 1. Public Backend API
cd backend-api && npm test

# 2. Admin API & Scrapers
cd ../admin/api && npm test

# 3. Admin Dashboard UI
cd ../dashboard && npm test

# 4. Web Frontend (Playwright)
cd ../../frontend/web && npm run test:e2e

# 5. Mobile Flutter Application
cd ../mobile && flutter test
```
