# Lanka Offers — Admin Operations & Review Workflow

## 1. Overview

The administrative control plane comprises the private **Admin Dashboard** (`admin/dashboard`) and the **Admin API** (`admin/api`). 

### Key Operating Principles
- **No Public Authentication by Design:** The admin console is an internal operations tool intended to run behind private VPC boundaries or local loopback (`localhost:5174`).
- **Human-in-the-Loop Review:** No scraped offer is ever published automatically to the public consumer API. Every promotion requires explicit operator approval and a deliberate publication sync.
- **Protection of Manual Overrides:** Human edits are sacred (Invariant #3) and cannot be overwritten by re-scrapes.

---

## 2. Core Operational Workflows

### 2.1 Scraper Execution (Dry Run vs Live)
From the **Scraper Controls** page:
1. **Dry Run (Diagnostic):** Runs scrapers against live bank websites, dumps extracted records and normalization metrics to memory/disk, but executes zero SQL insertions or updates.
2. **Authorized Scrape:** Inserts newly discovered promotions into the `offers` table in `AUTO_STAGED` or `REVIEW_REQUIRED` state and creates an entry in `scrape_runs`. Existing published offers with modified terms generate a `pending_candidate` entry rather than overwriting live data.

### 2.2 The Review Queue
Operators navigate to the **Offer Review** workspace:
- Filters available: by Bank, by Category, by Lifecycle State (`REVIEW_REQUIRED`, `AUTO_STAGED`), by Confidence Score.
- Each item presents the normalized candidate alongside the immutable `raw_offer` evidence for direct visual verification.
- **Actions:**
  - **Approve:** Advances state to `APPROVED`, queued for the next publication release.
  - **Reject:** Sets state to `REJECTED`, removing the candidate from review queues.
  - **Manual Edit:** Opens the override dialog.

### 2.3 3-Way Diff Workspace
When a re-scrape detects updated terms for an already published offer, the dashboard renders a 3-way visual diff:
```text
┌─────────────────────────┬─────────────────────────┬─────────────────────────┐
│     Live Published      │    Scraped Candidate    │     Effective Result    │
│       (Current DB)      │    (Pending Update)     │   (If Override Applied) │
├─────────────────────────┼─────────────────────────┼─────────────────────────┤
│ Title: 20% at Keells    │ Title: 25% at Keells    │ Title: 25% at Keells    │
│ Valid Until: 2026-10-31 │ Valid Until: 2026-11-15 │ Valid Until: 2026-11-15 │
│ Manual Note: Verified   │ (empty)                 │ Manual Note: Verified   │
└─────────────────────────┴─────────────────────────┴─────────────────────────┘
```
The operator can accept the candidate updates, reject them, or apply fine-grained manual overrides.

### 2.4 Controlled Publication Sync
Publishing is a discrete batch step:
1. The operator selects approved offers in the queue.
2. Clicks **Publish Selected Offers**.
3. The Admin API executes a database transaction updating `db_status = 'PUBLISHED'`.
4. Only now do the promotions become visible to `backend-api` and consumer clients.

---

## 3. Safe Rollback Operations

Located in `admin/api/src/infrastructure/db/rollback-operations.ts`:

### Capabilities
- **Scrape Run Rollback (`rollbackScrapeRun`):** Reverts all newly inserted offers created during a specific scrape run without disturbing subsequent manual edits or pre-existing published records.
- **Publication Batch Rollback (`rollbackPublicationBatch`):** Transitions a set of published offers back to `APPROVED` or `STAGED` state if an error is identified post-release.
- **Audit Verification:** Every rollback action logs an entry to `offer_review_history` recording the operator, timestamp, and previous state.
