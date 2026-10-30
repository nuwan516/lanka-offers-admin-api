# Lanka Offers — Operational Runbooks & Maintenance

## 1. Daily Operating Runbook

Lanka Offers relies on a semi-automated daily routine ensuring high data freshness without sacrificing human oversight.

### Step 1: Execute Daily Ingestion Scrape
Run the authorized scrape for all banks (either via admin dashboard or CLI):
```bash
cd admin/api
npm run scrape:all
```
- The scraper runs in-process with concurrency limits (default: 3).
- Newly discovered promotions are parsed, normalized, and staged with `AUTO_STAGED` or `REVIEW_REQUIRED`.
- Existing offers with altered terms receive `pending_candidate` updates without altering published offers.

### Step 2: Operator Review Queue
1. Open the Admin Dashboard (`http://localhost:5174`).
2. Navigate to **Review Queue**.
3. Inspect `REVIEW_REQUIRED` items:
   - Check raw offer snippet against parsed fields.
   - Confirm discount wording ("Up to N%" vs "N% off").
   - Confirm merchant assignment.
   - Click **Approve** or **Reject**.
4. Check **3-Way Diffs** for existing published offers where terms changed.

### Step 3: Batch Publication Release
1. Filter review list by `APPROVED`.
2. Click **Publish Selected Offers**.
3. Verify public endpoint reflects new offers:
   ```bash
   curl -s http://localhost:3000/api/offers?limit=5 | jq .
   ```

---

## 2. Emergency Incident Procedures

### Incident A: Scraper Ingested Inaccurate Data
If a bank promotion has a misstated discount or wrong dates:
1. **Disable Offer Immediately:**
   From Dashboard, find offer by ID or unique slug and click **Disable**.
   Or via Admin API:
   ```bash
   curl -X POST http://localhost:3001/api/offers/<OFFER_ID>/disable \
     -H "Content-Type: application/json" \
     -d '{"reason": "Incorrect discount terms in source bank page"}'
   ```
   The public API (`backend-api`) will instantly cease serving the offer.

2. **Rollback an Entire Scrape Run:**
   If a broken parser polluted hundreds of offers in a single run:
   ```typescript
   import { rollbackScrapeRun } from './src/infrastructure/db/rollback-operations';
   await rollbackScrapeRun(pool, runId, 'operator-username');
   ```
   This deletes or restores staged offers for that run while preserving any independent manual overrides.

### Incident B: Scraper Process Hangs or Crashes
Scrapers use lease fencing (`lease_expires_at` in `scrape_runs`). If a scraper process terminates abruptly:
- The lease will automatically expire after 15 minutes.
- On the next `admin/api` boot or scraper invocation, stale runs are recovered and marked `failed`.
- To manually clear a stuck lease:
  ```sql
  UPDATE scrape_runs
  SET status = 'failed'
  WHERE status = 'running' AND lease_expires_at < NOW();
  ```

### Incident C: Bank Layout Change
When a bank updates its HTML layout or API:
1. The parser may extract 0 offers or throw parsing errors.
2. The scraper runner captures the failure in `scrape_runs.status = 'failed'` without affecting existing published offers.
3. Use `--cache` flag locally to test and iterate on the updated CSS selectors or JSON paths:
   ```bash
   npm run scrape:seylan --cache
   ```
4. Verify regression test suite passes before redeploying:
   ```bash
   npm test tests/banks/seylan.test.ts
   ```

---

## 3. Routine Database Maintenance

### 3.1 Expired Offer Archival
The public API filters out offers where `valid_until < NOW()`. Periodically archive expired rows to optimize table scans:
```sql
UPDATE offers
SET db_status = 'ARCHIVED'
WHERE db_status = 'PUBLISHED'
  AND valid_until < (NOW() - INTERVAL '7 days');
```

### 3.2 Health Check Monitoring
Both backend services expose an HTTP health endpoint:
- Public Backend: `GET http://localhost:3000/api/health`
- Admin Control: `GET http://localhost:3001/api/health`

Expected response:
```json
{
  "status": "ok",
  "database": "connected",
  "timestamp": "2026-10-30T04:00:00.000Z"
}
```
If the database connection is lost, HTTP status `503 Service Unavailable` is returned.
