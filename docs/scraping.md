# Lanka Offers — Bank Scraper Pipeline

## 1. Overview

The scraping subsystem is located entirely in `admin/api/src/banks/` and `admin/api/src/cli/scrape.ts`. It automates the discovery, extraction, and normalization of credit and debit card promotions from ten licensed commercial banks operating in Sri Lanka.

```text
Bank Web Portal / API
         │
         ▼
[ Bank-Specific Scraper Adapter ] ─── (Cheerio HTTP or Puppeteer Headless)
         │
         ▼
[ Raw Evidence Preservation ] ──────── (Verbatim capture into raw_offer JSON)
         │
         ▼
[ Deterministic Normalization ] ───── (Dates, Discard Rules, Discounts, Terms)
         │
         ▼
[ Location Scope Classifier ] ─────── (ONLINE, NATIONWIDE, SELECTED_OUTLETS, SPECIFIC_OUTLETS)
         │
         ▼
[ Duplicate Detection Engine ] ────── (Jaccard similarity + Canonical Merchant)
         │
         ▼
[ Quality Decision Gate ] ─────────── (AUTO_STAGED, REVIEW_REQUIRED, REJECTED)
         │
         ▼
PostgreSQL Staging (offers table)
```

---

## 2. Supported Bank Adapters

| Bank Code | Bank Name | Ingestion Mechanism | Technology | Details |
|---|---|---|---|---|
| `hnb` | Hatton National Bank | JSON REST API / Web Endpoints | Axios / Node HTTP | High-structure JSON feeds, rich card details, categorized. |
| `boc` | Bank of Ceylon | HTML scraping | Cheerio | Table and grid structures, multi-page promotional lists. |
| `sampath` | Sampath Bank | JSON API + HTML Detail Pages | Axios + Cheerio | Hybrid structure with promotional cards linking to detailed terms. |
| `peoples` | People's Bank | HTML + PDF terms | Cheerio + PDF-parse | Scrapes promotional portals and downloads terms PDF attachments when necessary. |
| `seylan` | Seylan Bank | HTML scraping | Cheerio | Concurrent category fetcher with structured merchant grids. |
| `ndb` | NDB Bank | Headless SPA scraping | Puppeteer-core | Dynamic client-rendered card offers, lazy-loaded image links. |
| `dfcc` | DFCC Bank | Headless SPA scraping | Puppeteer-core | JavaScript-rendered tables, modal detail views. |
| `pabc` | Pan Asia Bank | Headless SPA scraping | Puppeteer-core | Dynamically injected promotional cards. |
| `nsb` | National Savings Bank | HTML WordPress prose | Cheerio | Freeform text extraction, date-pattern regex normalizers. |
| `combank` | Commercial Bank of Ceylon | HTML scraping | Cheerio | High-volume promo pages with tabular merchant layouts. |

---

## 3. Ingestion Lifecycle & Data Contracts

### 3.1 Raw Evidence Preservation (Invariant #1)
Every scraper produces a payload conforming to `RawOffer`:
```typescript
interface RawOffer {
  title: string;
  sourceUrl: string;
  bank: string;
  description?: string;
  category?: string;
  validityRaw?: string;
  discountRaw?: string;
  cardTypeRaw?: string;
  locationRaw?: string;
  termsRaw?: string;
  extractedAt: string;
  [key: string]: unknown;
}
```
This payload is persisted verbatim in `offers.raw_offer` and is **never modified** or overwritten by subsequent pipelines.

### 3.2 Deterministic Normalization
Raw strings pass through bank-agnostic parsers in `admin/api/src/parsing/`:
- **Period Engine (`src/parsing/period/`):** Extracts `valid_from` and `valid_until` into UTC dates, normalizing Sri Lanka timezone (Asia/Colombo, UTC+05:30) midnight boundaries.
- **Transaction Parser (`src/parsing/transaction/`):** Identifies minimum spend, maximum discount caps, and transaction ranges.
- **Card Tier Matcher:** Normalizes credit/debit levels (e.g., Infinite, Signature, World, Platinum, Gold, Classic). If eligibility is ambiguous, status is set to `unknown` (Invariant #5).
- **Merchant Canonicalizer:** Resolves localized merchant aliases (e.g., "Keells Super", "Keells", "John Keells") to authoritative merchant entities.

### 3.3 Location Scope Classification (Invariant #4)
Promotions are classified into one of seven location scopes (`src/domain/location-scope.ts`):
1. `ONLINE`: E-commerce websites, delivery apps, virtual services (no physical coordinates).
2. `NATIONWIDE`: All island-wide branches of a merchant (coordinates attached only to independently verified branch lists).
3. `SELECTED_OUTLETS`: Specific participating outlets explicitly named in the offer terms.
4. `SPECIFIC_OUTLET`: A single named venue.
5. `AIRPORT_DUTY_FREE`: Transit and airport duty-free concessions.
6. `UNRESOLVED`: Ambiguous location information.
7. `FOREIGN`: Promotions valid only outside Sri Lanka.

Exact coordinate pins are NEVER assigned without dual-lock verification.

---

## 4. Execution Modes & CLI Usage

From `admin/api/`:

### Authorized Scrape (Updates Database Staging)
```bash
# Scrape single bank
npm run scrape:hnb
npm run scrape:sampath
npm run scrape:boc

# Scrape all 10 banks sequentially
npm run scrape:all
```

### Dry Run (Zero DB Mutations)
```bash
# Run scrape and dump JSON to stdout/local output without inserting into PostgreSQL
npm run import:dryrun
```

### Options & Flags
- `--bank=<bank_code>`: Target a specific bank (`hnb`, `boc`, `combank`, etc.) or `all`.
- `--cache`: Read/write local HTML/JSON cache to avoid redundant network hits during testing.
- `--concurrency=<N>`: Limit simultaneous page fetches (default: 3).
- `--headless`: Run browser-based scrapers without UI window (default in production).
