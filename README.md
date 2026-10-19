# Lanka Offers Admin API and Scraper Engine

Private control plane and ingestion engine. It scrapes ten Sri Lankan banks, normalizes and validates offers, stages them for human review, and publishes approved offers to the shared Neon PostgreSQL database that the public API reads. It is not exposed publicly and has no login by design; run it on a private network only.

Supported banks (`src/config/banks.ts`): `hnb`, `boc`, `peoples`, `nsb`, `sampath`, `seylan`, `ndb`, `dfcc`, `pabc`, `combank`.

## Architecture

```
src/
  api/             Express server, routes, middleware; services: job-manager (isolated scraper child
                   processes), scraper-scheduler (PostgreSQL lease + heartbeat + generation fencing),
                   duplicate-merge-service
  banks/           One adapter per bank + base-scraper, fetcher, runner, bank-rules-loader (DB parser rules)
  parsing/         Period (Sri Lankan date phrases) and normalization / content hashing
  domain/          Pure logic: lifecycle state machine, effective offer (manual override), 3-way diff,
                   location scope, merchant canonicalizer, duplicate detector, quality decision
  geo/             Address and geospatial resolution
  infrastructure/  db (client, schema.sql, repositories, migrations), browser, http, pdf, cache,
                   cost-control, concurrency, logger
  cli/             scrape, import:dryrun, LLM revalidation and other operator commands
  test/            PGlite-backed PostgreSQL harness used by tests/integration
tests/             Jest suites (bank fixtures, domain, CLI isolation, scheduler, real-Postgres via PGlite)
```

Pipeline: scrape -> normalize -> deterministic validation (optional LLM validation, gated by content hash) -> duplicate detection -> quality decision -> staging -> human review/approval -> publish. Dry-run, staging import, publishing and scheduled execution are separate operations.

## Invariants

- `offers.raw_offer` is immutable source evidence.
- `offers.manual_override` is never overwritten by a scrape; candidate changes to published offers go to `pending_candidate`.
- Public readers only see `db_status = 'PUBLISHED'` and unexpired offers.
- Unchanged `llm_validated_content_hash` means the previous LLM result is reused.
- No invented coordinates for `ONLINE`, `NATIONWIDE`, `SELECTED_OUTLETS` or `UNRESOLVED` scopes.
- Unattended scraping, auto-approval and auto-publishing stay off unless explicitly enabled.

## Setup

```bash
npm install
cp .env.example .env     # then fill in values; never commit .env
npm run migrate
npm run api              # admin API
```

Variable names are listed in `.env.example` (database URLs, LLM/geocoding switches and monthly budgets, duplicate and quality thresholds, `API_PORT`, `SCRAPER_JOB_TIMEOUT_MS`). The admin API uses the privileged database role; the public API must use the restricted `lanka_offers_public_api` role instead.

Booting the API does **not** change the schema by default. `AUTO_MIGRATE` is false; run `npm run migrate` for an explicit migration, or set `AUTO_MIGRATE=true` only against a disposable local database. Startup still performs stale-run recovery on the `scrape_runs` table.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Full suite including PGlite integration tests. The script sets `--experimental-vm-modules` through `node` directly, so it works on Windows and Linux. |
| `npm run test:integration` | Real-Postgres (PGlite) suites only |
| `npm run type-check` / `npm run lint` | Type check / ESLint |
| `npm run scrape:<bank>` / `scrape:all` | Run a bank scraper via the CLI |
| `npm run import:dryrun` | Dry-run export without touching the database |
| `npm run browser:install` | Install the browser used by browser-based adapters |

## Known limitations

- Routes are split by area under `src/api/routes/`; some route handlers still issue SQL directly rather than going through repositories.
- Several operator commands (`geo:*`, `llm:revalidate:*`) are bank-specific and not yet generalized.
