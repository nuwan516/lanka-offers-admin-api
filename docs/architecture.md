# Lanka Offers — System Architecture

## 1. System Overview

Lanka Offers is a production promotion-aggregation platform dedicated to bank-card credit and debit offers across Sri Lanka. The system is designed for Phase 1 scale (approximately 2,000 active offers) with strict requirements around data accuracy, financial terms grounding, geographic truthfulness, and operational safety.

The workspace consists of **five independent repositories** with zero cross-repository code sharing or imports:

```text
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│          Consumer Web           │       │         Consumer Mobile         │
│         (frontend/web)          │       │        (frontend/mobile)        │
│    Next.js 16 App Router / React│       │     Flutter 3.44 / BLoC / Dart  │
└────────────────┬────────────────┘       └────────────────┬────────────────┘
                 │                                         │
                 │   HTTP REST (Read-Only Public Contract) │
                 └────────────────────┬────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │      Public Backend       │
                        │       (backend-api)       │
                        │    Express / TypeScript   │
                        │    Least-Privilege DB     │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │    PostgreSQL Database    │
                        │       (Neon Cloud)        │
                        │   Role: public_api (RO)   │
                        └─────────────▲─────────────┘
                                      │
                                      │ SQL Read/Write (Operational Role)
                                      │
                        ┌─────────────┴─────────────┐
                        │      Admin Control        │
                        │        (admin/api)        │
                        │   Express / TS / Scrapers │
                        └─────────────▲─────────────┘
                                      │
                                      │ HTTP REST (Private Operations Contract)
                                      │
                        ┌─────────────┴─────────────┐
                        │      Admin Dashboard      │
                        │     (admin/dashboard)     │
                        │  React 19 / AWS Cloudscape│
                        └───────────────────────────┘
```

---

## 2. Five Independent Repositories

| Repository | Tech Stack | Role & Boundary | Verification |
|---|---|---|---|
| `backend-api/` | Node.js 20+, Express 4, TypeScript, `pg`, PM2 | Read-only public consumer REST API. Operates under least-privilege PostgreSQL user (`lanka_offers_public_api`) without write or DDL rights. Fails closed if privileged URL is supplied. | `npm run type-check`<br>`npm test`<br>`npm run build` |
| `admin/api/` | Node.js 20+, Express 5, TypeScript, Cheerio, Puppeteer, PGlite | Administrative control plane, 10 bank scraper adapters, deterministic normalization, LLM validation gates, geocoding dual-lock, staging review, publication workflows, and lease-fenced scheduler. | `npm run type-check`<br>`npm test`<br>`npm run lint` |
| `admin/dashboard/` | React 19, Vite, AWS Cloudscape Design System | Private operations console for staging review, 3-way offer diffs, manual overrides, scraper runs, geocoding verification, and safe rollback management. No consumer login by design. | `npx tsc -b`<br>`npm run build`<br>`npm run lint` |
| `frontend/web/` | Next.js 16 (App Router), React 19, Tailwind CSS 4 | Consumer web application with English, Sinhala, and Tamil localization. Connects exclusively to `backend-api` over public HTTP REST. | `npm run typecheck`<br>`npm run build`<br>`npm run test:e2e` |
| `frontend/mobile/` | Flutter 3.44, Dart 3.12, BLoC/Cubit, GetIt | Consumer cross-platform mobile application (iOS & Android). Implements offline saved offers, client-side category/bank filtering, and verified branch nearby views. | `flutter analyze`<br>`flutter test` |

---

## 3. Core Architectural Invariants

Every subsystem strictly adheres to the following twelve non-negotiable invariants:

1. **Immutable Evidence (Raw Offer Integrity):** Scrapers capture original bank payloads verbatim into `offers.raw_offer`. Raw offer fields are NEVER mutated, sanitized, or deleted by any downstream normalization, LLM tool, or manual edit.
2. **Public Staging Isolation:** The public API (`backend-api`) queries only records where `db_status = 'PUBLISHED'` and the offer validity date has not lapsed. Draft, pending, review-required, rejected, or disabled offers NEVER leak to consumers.
3. **Sacred Manual Overrides:** Scrapers and automated jobs never overwrite operator edits stored in `offers.manual_override`. Automated re-scrapes produce candidates stored in `offers.pending_candidate`, requiring human review and approval.
4. **No False Location Precision:** Geographic coordinates are never invented for `ONLINE`, `NATIONWIDE`, `SELECTED_OUTLETS`, or `UNRESOLVED` scopes. Exact coordinate pins require dual-lock verification: text evidence in the promotion plus an independently geocoded, verified participating venue.
5. **Conservative Card Eligibility:** If a promotion's bank terms are ambiguous regarding card tiers (e.g., whether Classic cards qualify alongside Platinum), the eligibility is marked `unknown`—never guessed or assumed.
6. **Zero-Cost LLM Gate:** Deterministic regex and AST rules process all incoming promotions first. LLM validation runs only on unconfident extractions. A content hash (`llm_validated_content_hash`) prevents duplicate LLM invocations when scraped data is identical.
7. **Least-Privilege Database Role:** `backend-api` connects using a restricted database user with `SELECT` permissions restricted to public columns of published tables. The public API refuses to start if given admin credentials.
8. **Faithful Discount Wording:** The API exposes no synthetic "up to" flag. "Up to N%" is displayed only if the bank's title or description explicitly contains that qualifier. Otherwise, clean percentage or flat discount terminology is rendered.
9. **Lease-Fenced Concurrency:** Background scraper runs and scheduled jobs acquire explicit PostgreSQL advisory locks or lease rows to prevent race conditions across server restarts.
10. **Reversible Rollbacks:** Scrape runs, bulk imports, and batch publications record full audit history in `offer_review_history`, enabling granular or run-level rollback without damaging subsequent manual overrides or pre-existing published offers.
11. **Client-Side Deduplication & Deterministic Paging:** Public list endpoints order offers deterministically (`valid_until ASC, id ASC`), allowing stable pagination. Frontend clients deduplicate incoming items by `id` during infinite scrolling.
12. **Synthetic Provenance Rejection:** Non-authentic or synthetic test fixtures are strictly prevented from entering staging publication workflows or public API visibility.
