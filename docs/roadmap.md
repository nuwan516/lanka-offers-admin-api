# Lanka Offers — Future Platform Roadmap

**Status:** planning only. Nothing in this document is implemented, migrated, deployed or activated. No code, schema or infrastructure was changed to produce it.

**How to read it:** sections 1 and 2 describe what exists today (verified in the repositories). Everything from section 3 onward is a proposal. Where a fact about an outside service could not be verified from official sources, it is marked **[verify]** and must be confirmed before any decision depends on it.

**Companion docs:** [CROSS_REPOSITORY_ARCHITECTURE.md](../CROSS_REPOSITORY_ARCHITECTURE.md) (current structure and the accuracy rules both consumer apps follow).

---

## 1. Existing architecture assessment (verified)

### 1.1 The five repositories today

| Repository | What it does now | Who can reach it | Database role |
|---|---|---|---|
| `backend-api/` | Public, **read-only** Express API: `GET /api/health`, `/api/banks`, `/api/offers`, `/api/offers/:id`, `/api/offers/nearby`, `/api/merchants[...]`. Modules: offers, banks, merchants, health. | The internet, through Cloudflare. No authentication. | `lanka_offers_public_api` (SELECT only); production **fails closed** without `DATABASE_PUBLIC_URL`. |
| `admin/api/` | Ten bank scrapers, normalization, deterministic validation, optional LLM validation, duplicate detection, staging, review, manual overrides, publishing, PostgreSQL-lease scheduler. | Bound to `127.0.0.1` by default; no login by design. | Privileged operational role. |
| `admin/dashboard/` | Private Cloudscape console: runs, review workspace, duplicates, schedule, rules, sync. | Trusted operator only. | None (talks to admin API). |
| `frontend/web/` | Next.js 16 consumer site, English/Sinhala/Tamil. All data is fetched client-side from `/api/*`, proxied by a Next rewrite to the public API. | The internet. | None. |
| `frontend/mobile/` | Flutter consumer app (Home, Explore, Saved, Settings). Saved offers, card preferences and language live on the device. | The internet. | None. |

Infrastructure: Neon PostgreSQL, one Oracle Cloud VM running the public API under PM2 (`instances: 'max'`, cluster mode, 500 MB restart limit), Cloudflare in front, GitHub Actions deploying by SSH (`git reset --hard origin/main`, build, `pm2 restart`, health check).

### 1.2 The data model today

One central table, `offers`, owned by the bank-ingestion pipeline: `unique_id` (bank-prefixed), `bank` (text code), `title`, `category`, `card_type`, `merchant_name`, `canonical_merchant`, `discount_percentage` (text), `valid_from`/`valid_to` (dates), `card_eligibility` (JSONB), `geo_locations` (JSONB array), `location_scope`, immutable `raw_offer` (JSONB, NOT NULL), `content_hash`, validation columns, and a lifecycle `db_status` (`DISCOVERED → VALIDATED → REVIEW_REQUIRED → APPROVED → PUBLISHED → EXPIRED/DISABLED/REJECTED`). Review fields (`manual_override`, `pending_candidate`) are never overwritten by scrapes. Supporting tables: `scrape_runs`, `scraper_leases`, `scheduler_config`, `offer_review_history`, `offer_sync_runs`, `validation_reports`, `offer_duplicate_candidates`, `rule_configs`, `parser_golden_cases`, `external_api_usage`, `geo_cache`, `bank_parser_rules`.

Indexes already exist for the published read path (bank, category, scope, merchant, `valid_to`), a GIN index on `geo_locations`, trigram indexes on title and merchant (search), and a PostGIS `geom` column with a GiST index.

### 1.3 Facts that constrain the expansion

These came from reading the code, not from assumptions.

1. **There are no user accounts anywhere.** The public API has no authentication; the admin API and dashboard rely on being private. Saved offers and card preferences are device-local. Any merchant feature is the first place identity is needed.
2. **The public API is read-only by security design.** Its database role cannot write, and that boundary is a release invariant. Merchant writes must not be added to that process or role.
3. **Bank-offer correctness is the product's trust.** The pipeline guarantees provenance (`raw_offer`), review, manual-override protection and published-only exposure. Consumers (web and Flutter) assume everything from `/api/offers` is a bank offer.
4. **`/api/offers` has no `source_type`.** If merchant promotions were simply inserted into `offers`, existing apps would present them as bank offers. This is the single most important compatibility risk.
5. **No rate limiting, HTTP cache headers or compression** were found in the public API source. Protection today is whatever Cloudflare provides.
6. **Connection pressure is real.** `db-client.ts` opens a pool of up to 20 connections per process, and PM2 runs one process per CPU core (`instances: 'max'`). Total connections scale with core count. Neon pooled connections (the `-pooler` host) go through PgBouncer in transaction mode, which cannot hold session state such as session advisory locks; direct connections are limited by compute size **[verify the limit for your Neon plan with `SHOW max_connections;`]**. Which URL `DATABASE_PUBLIC_URL` uses is not recorded in the repository and should be checked.
7. **Nearby search is computed in SQL over JSONB** (haversine over `jsonb_array_elements(geo_locations)` with a bounding-box prefilter). It works at current volume (hundreds of published offers). The PostGIS `geom` column exists but the nearby query does not use it. This is a deliberate later optimisation, not a current problem.
8. **Location precision is unknown to the API.** The geocoder marks a city-centre match as `resolved`; both consumer apps treat a bare place name as area-only. A real `location_precision` field is needed before merchant-supplied locations are mixed in.
9. **The public API serves no images.** Scraped payloads keep an `images` field inside `raw_offer`, but it is not exposed, so the apps show typographic fallbacks. Merchant logos and creatives would be the first image workload.
10. **No analytics** exist on the web or mobile apps, so there is currently no usage baseline.
11. **Merchant identity partly exists.** The admin API has a merchant canonicalizer (Sri Lankan merchant catalog and aliases) and `canonical_merchant` on offers. A merchant profile can be linked to it instead of starting from nothing.
12. **i18n is established** (en/si/ta in web JSON files and Flutter string maps) with the rule that Sinhala/Tamil copy is reviewed by native speakers.

### 1.4 What is implemented versus proposed

| Capability | Today |
|---|---|
| Bank offers, review, publishing | Implemented |
| Search, bank filter, nearby, detail, three languages | Implemented |
| Merchant accounts, profiles, seller offers, events | **Not implemented** |
| Sponsored placements, banners, campaign tracking | **Not implemented** |
| Subscriptions, payments, invoices | **Not implemented** |
| Brand partnerships | **Not implemented** (no agreements exist; the product must not imply any) |
| Analytics, push notifications | **Not implemented** |
| Firebase of any kind | **Not used** |

---

## 2. Long-term product vision

Lanka Offers becomes the place a Sri Lankan consumer opens to find any discount, and the first place a small business thinks of to be found. The trust the bank-offer product earns (accurate wording, honest locations, visible sources) is the asset; the expansion is only worthwhile if it does not spend that trust.

**Four source types** (conceptual categories, not a database-enum change today):

| Source type | Who provides it | Trust level shown to users | How it is checked |
|---|---|---|---|
| `BANK` | Scraped from official bank sources | "Bank offer" with original source link | Existing deterministic and human review pipeline |
| `MERCHANT` | A registered, verified local business | "From the business" plus a verified-business badge | Business verification, then offer moderation |
| `SPONSORED` | Anyone who pays for placement (campaigns, events, banners) | Always labelled **Sponsored** | Campaign moderation; never mixed into bank ordering |
| `OFFICIAL_PARTNER` | A brand under a signed agreement | "Official partner" only while an agreement is active | Contract record + brand approval |

**Non-negotiable product rules**

1. A sponsored or merchant item can never be mistaken for a bank offer. Distinct label, distinct card styling, separate sections in lists, and bank filters never include non-bank items.
2. Bank-offer wording rules (no invented "up to", no invented caps, area-only locations) apply to merchant offers too: merchants supply structured fields, not marketing prose that the app re-interprets.
3. Paying changes *visibility*, never *verification*. A sponsor still passes moderation.
4. No claim of an official partnership exists in code, copy or data unless a signed agreement is recorded.
5. Consumer apps stay fast and quiet: no popups on first visits, no repeated prompts.

---

## 3. Seller registration, verification and the business portal

### 3.1 Where it lives

A merchant needs a public-internet, authenticated, **writing** surface. The two existing writers (admin API, privileged and private) and the existing public reader (read-only) are both wrong homes. Decision:

- **Seller API** — a new *module* in the `backend-api` repository, started as a **second PM2 process** with its own entrypoint, its own port, and its **own database role** (`lanka_offers_merchant_api`) that can write only merchant-owned tables and read the minimum else. The public read-only process and role are untouched. This adds no repository and no new platform; it adds a process boundary, which is the part that matters for least privilege.
- **Seller portal UI** — a route group (`/business/*`) in `frontend/web` with its own layout, noindex, and its own bundle. It can be moved to a separate subdomain deployment later without changing the repository.
- **Admin side** — new pages in `admin/dashboard` and new routes in `admin/api` for merchant applications, campaigns, reports and partners. The seller portal never shares the admin dashboard, its network exposure or its trust model; public sign-up is never added to it.

**When to split into a separate service/repository:** only when one of these is measured, not anticipated: the seller API needs a different release cadence from the public API; its load or failure mode threatens public read latency; or a second team owns it.

### 3.2 Roles and permissions

| Role | Scope | Can |
|---|---|---|
| `consumer` (future, optional) | Own saved items/preferences | Nothing merchant-related |
| `merchant_owner` | One business | Everything for that business including billing and team |
| `merchant_editor` | One business | Offers, events, profile; not billing/team |
| `merchant_viewer` | One business | Read-only reports |
| `platform_reviewer` | All | Review applications, offers, creatives; cannot touch billing |
| `platform_admin` | All | Everything incl. suspensions, partner agreements |
| `partner_manager` | Assigned partner orgs | Manage partner brand content (partnership phase) |

Authorization is enforced server-side from rows in Postgres (membership table), never from client-supplied claims. Identity-provider custom claims, if used, are a cache of Postgres state, not the source of truth.

### 3.3 Registration and verification flow

```
Visitor ── "Promote your business" page ──► interest form (Phase B)
                                          │
Sign up (email, then phone OTP) ──► verify contact ──► create business (individual or company)
        │
        ├─ Business details: legal/trading name, category, address(es), contact, website/social
        ├─ Evidence: BR certificate or NIC (individual), shopfront/branch photos, a bank statement name match is NOT collected
        ├─ Locations: branch addresses with map pin placed by the owner (precision recorded)
        ▼
Status: DRAFT → SUBMITTED → NEEDS_INFO ⇄ SUBMITTED → VERIFIED | REJECTED | SUSPENDED
        │                                   (platform_reviewer, with reasons and audit trail)
        ▼
VERIFIED business may submit offers/events (each one moderated; trusted merchants can graduate to lighter review)
```

**Verification levels** (shown honestly): `EMAIL_PHONE_VERIFIED` (can draft only), `DOCUMENT_VERIFIED` (can publish after moderation), `PARTNER_VERIFIED` (signed agreement). Re-verification is triggered by address/ownership changes or reports.

**Fraud and abuse controls (cheap, deterministic first):** one phone/email per account; duplicate-business detection by normalized name + address + phone (reuse the existing duplicate-detector approach); blocklists; offer sanity rules (discount ≤ configured ceiling, validity ≤ N months, no placeholder text); mandatory structured fields; report button on every merchant offer; rate limits on submission; automatic suspension of an offer after N reports pending review; manual review queue. No expensive AI moderation; an LLM, if ever used, only to *suggest* a flag, behind the same content-hash cost gate the platform already uses.

### 3.4 Notifications

Transactional email first (verification, status changes, expiry reminders, invoices). SMS only for phone verification and critical account events **[verify provider options and per-message cost in Sri Lanka]**. Push to the merchant is a later convenience. In-portal status is the source of truth; every notification is reproducible from state.

---

## 4. The "Promote your business" conversion experience

**Principle:** earn the right to ask. Show it only after a user has clearly gotten value, once, and respect "no".

| Surface | Trigger | Behaviour |
|---|---|---|
| Web, contextual card | After the user has viewed ≥3 offer details or run ≥2 searches in a session, shown inline at the end of a results list (not over content) | Dismissible; dismissal remembered for 30 days in local storage |
| Web, footer + header link | Always | Quiet link "For businesses" |
| Web, bottom sheet | Only on a *return* visit (stored visit count ≥3), once per 30 days | Dismissible, no re-prompt after two dismissals |
| Mobile, inline card | After ≥3 offer detail views, at the bottom of the Explore list | Same dismissal memory on device |
| Mobile, Settings | Always | "Promote your business" row opening the landing page |
| Never | First session, during search typing, on offer detail pages, on an error state, in the map view | |

**Landing page** (`/business`): one clear value proposition, who it is for, the four campaign types in plain language, what verification involves, honest "pilot" framing (no invented audience numbers), a short interest form (business name, category, district, contact, what they want to promote, consent checkbox). Sinhala/Tamil versions reviewed by native speakers.

**Funnel and measurement** (first-party, aggregate, privacy-preserving): card impression → click → landing view → form start → form submit → contacted → verified → first offer live → first paid campaign. Phase B success criteria are defined on this funnel (section 13).

---

## 5. Subscriptions and payments

### 5.1 Plan shape (assumptions, not prices)

No market price is asserted here. Prices are set after the Phase B interest data and conversations with real merchants.

| Plan | Intent | Typical entitlements (to be tuned) |
|---|---|---|
| Free profile | Be findable | Verified profile, ≤ N active offers, basic stats |
| Trial | Prove value | Time-limited extra offers and one sponsored slot |
| Starter | Small shop | More offers, events per month, photos, basic report |
| Growth | Chains/multi-branch | Branch limits up, scheduled campaigns, sponsored credits, exports |
| Premium / Enterprise | Large brands | Priority review, category sponsorship, bulk feed, account manager |
| Pay-per-campaign | Occasional promoter | One-off sponsored placement or event package |

Entitlements live in data (`plans`, `plan_entitlements`), checked in one service function (`can(merchant, 'create_offer')`), so changing a plan never requires a deploy.

### 5.2 Payment architecture (conceptual)

- **Start without a gateway.** Phase D can open with invoices paid by bank transfer or LankaQR and **manual confirmation by the admin**: it validates willingness to pay with no integration cost and matches how many Sri Lankan small businesses pay. A gateway is added when volume makes manual confirmation a chore.
- **Provider selection is an open item.** Candidates include PayHere and bank-operated payment gateways. Secondary sources describe PayHere as a Sri Lankan gateway with recurring/preapproval APIs and a sandbox, but its official merchant requirements, current fees and recurring terms could not be confirmed from official pages, and the one fee figure found (an older "Rs. 30 + 3.3%" model) is dated **[verify everything with the provider before choosing; get written confirmation on recurring billing, refunds, webhooks, settlement time and merchant onboarding documents]**. Compare at least two providers and one bank gateway on those points.
- **Data model:** `subscriptions` (state machine), `invoices` (immutable once issued, sequential numbering, tax fields as configured), `payments` (one row per provider attempt, provider reference unique), `payment_events` (append-only webhook log), `credit_notes`/`refunds`, and a double-entry-style `ledger_entries` table for accounting and audit. Money is stored as integer minor units with an explicit currency.
- **Webhooks:** verify the provider's signature scheme exactly as documented, reject replays (event id unique), process idempotently, answer fast and do the work in a background job, never trust the browser redirect as proof of payment, and reconcile daily against the provider's report.
- **Subscription state machine:** `TRIALING → ACTIVE → PAST_DUE → (RETRYING) → SUSPENDED | CANCELED | EXPIRED`. Failed payment: grace period, reminders, retries per provider capability, then downgrade to the free profile (offers beyond the free limit become hidden, not deleted). Cancellation takes effect at period end. Refunds follow a written policy and create credit notes.
- **Compliance:** card data never touches Lanka Offers servers (hosted checkout only). Tax and invoicing rules must be confirmed with an accountant **[verify]**.

---

## 6. Dynamic banners and campaign advertising

### 6.1 Concept

A small, Lanka-Offers-managed placement system, not a general ad exchange.

**Placements (slots):** `home_top`, `home_inline`, `explore_inline`, `category_top`, `bank_browse_inline`, `nearby_sponsored`, `event_highlight`, `app_home_card`, `seasonal_hero`. Each slot defines allowed formats, sizes and maximum items.

**Campaign model:** a campaign has an owner (merchant or partner), objective, schedule, budget cap, placements, targeting (language, district/geo radius, category, bank context), frequency cap, status, and one or more **creatives** (title, short text, image variants for desktop and mobile, CTA, destination, translations en/si/ta). Destination must be a Lanka Offers page (merchant profile, offer, event) or an approved external URL.

### 6.2 Serving

```
Client ──► GET /api/placements?slot=home_inline&lang=si&district=Kandy&category=Dining
Server: eligible = active ∧ in schedule ∧ approved ∧ budget left ∧ plan entitles ∧ targets match
        rank = deterministic weights (priority, remaining budget pacing), tie-break by least-recently shown
        return up to slot.max items, each with: creative, label="Sponsored", click token
Client renders with a visible "Sponsored" tag; no silent insertion into bank lists
```

Rules that keep it honest: the label is rendered by the client from the response field `sponsored: true` and cannot be turned off by a creative; a sponsored item is never placed inside the bank-offer ranking; no countdown/fake urgency; no autoplay; one sponsored item per list screen by default; sponsored items respect the user's language.

### 6.3 Tracking

First-party, minimal, aggregate: batched `POST /api/events` of `{placement, campaign, creative, type: impression|click, ts}` with no user identifier beyond a rotating anonymous session id used only for frequency capping. Impressions counted when ≥50% visible for ≥1 s (client-side). Server de-duplicates, rate-limits, and flags obviously automated traffic. Reports aggregate per day. Raw events are pruned on a schedule; only aggregates are kept long-term.

### 6.4 Moderation

Every creative passes review (platform_reviewer) before it can serve: text accuracy, no misleading claims, no bank logos or "official partner" wording unless the agreement exists, image safety, correct language. Approved creatives are immutable; edits create a new version needing re-approval.

---

## 7. Event promotion

Events are a separate first-class type, never presented as bank discounts.

- **Fields:** title, organizer (business), category (festival, exhibition, concert, market, education, tourism, launch, restaurant promotion), start/end timestamps in Sri Lanka time, venue (name, address, map pin with recorded precision), ticket info (free/paid, external ticket link, price text as entered), status (`DRAFT, SUBMITTED, APPROVED, LIVE, ENDED, CANCELED`), language versions, images.
- **Eligibility:** only verified businesses; paid packages control featured placement, not approval.
- **Display:** an "Events" section distinct from offers; map pins use a different marker and the same precision rule (no pin without a confirmed address).
- **Lifecycle:** auto-end after the end timestamp; cancel/reschedule notifies saved followers (future).
- **Flutter note:** the Flutter project still contains inactive event code (`events_*`, `Event` entity) from before the API-only rewrite; it should be reviewed and either reused or deleted when events are built.

---

## 8. Official brand partnerships

Treat this as a **sales and contract process supported by software**, not a feature to ship early.

- **Partner organization** record (legal name, brands, contacts, account manager, status `PROSPECT → NEGOTIATING → SIGNED → ACTIVE → ENDED`), **agreement** record (document reference, start/end, scope, fees, exclusivity, approval rules). The "Official partner" label is derived from an `ACTIVE` agreement and disappears automatically when it ends.
- **Brand-controlled content:** brand users (role `partner_manager`) submit deals; a platform reviewer still checks them, but with a faster path defined in the agreement.
- **Integration options for larger brands:** manual CSV upload first; a signed bulk-feed endpoint (authenticated, per-partner key, idempotent upsert, validation report) later. Each imported deal keeps `source_ref` provenance, mirroring `raw_offer` for banks.
- **Reporting:** monthly PDF/CSV of impressions, clicks, offer views, saves, and (where measurable) redemptions — only metrics the platform can actually measure; no redemption numbers are claimed without a mechanism.
- **Guardrail:** no code, copy, seed data or marketing may state or imply an official partnership until the agreement row exists and is active.

---

## 9. Neon PostgreSQL versus Firebase

### 9.1 Decision

**Neon PostgreSQL stays the system of record for everything transactional**: bank offers, merchants, memberships, subscriptions, payments, ledger, campaigns, moderation, events, partner agreements, and aggregates. These are relational, need transactions and constraints, share the geospatial and publishing logic already built, and already have the least-privilege role model. **Firestore is not adopted** for any of them.

Firebase is used **selectively and only after Phase B shows merchant interest**:

| Firebase product | Verdict | Reasoning |
|---|---|---|
| **Authentication** | Adopt at Phase C, behind an abstraction | Hand-rolling merchant passwords, email verification, phone OTP and recovery is the highest-risk thing a small team can build. A hosted provider is safer and cheaper in engineering time. **[verify Authentication pricing and phone/SMS cost for Sri Lanka before committing; the sources consulted did not include pricing.]** |
| **Cloud Messaging** | Adopt when push is needed (Phase D+) | Free transport for the Flutter app; needs a notification-preference table and consent. |
| **Analytics** | Optional, Flutter only, after consent design | A first-party aggregate endpoint covers the funnel and campaign needs without a third-party SDK; add Firebase Analytics only if a clear need appears. |
| **Remote Config** | Optional | Useful to tune the promotional drawer rules without an app release. |
| **Storage** | Do not default to it | Compare with Cloudflare R2 or Cloudflare Images (Cloudflare is already in the stack) on cost, egress and resizing **[verify current pricing for both]**. |

### 9.2 Identity abstraction (so the provider can change)

Do not make `firebase_uid` the primary key. Use `merchant_users(id UUID, email, phone, status, …)` and `auth_identities(provider, subject, user_id, UNIQUE(provider, subject))`. The API resolves any provider token to a `merchant_users.id`; swapping providers later means adding identities, not rewriting accounts.

### 9.3 Verifying Firebase identity tokens securely in the backend

The browser or Flutter app signs in with the Firebase client SDK and sends the **ID token** to the seller API over HTTPS. Firebase's documented server-side method is the Admin SDK's `verifyIdToken`, which checks format, signature and expiry and returns the decoded token with the `uid` (a service account is required, and custom tokens minted by the Admin SDK must not be passed to it). The seller API must:

1. Verify every request's token server-side with the Admin SDK; never trust a `uid`, email or role sent by the client.
2. Assert the token's audience and issuer match this Firebase project, the token is unexpired, and for sensitive actions pass `checkRevoked` so disabled or signed-out users are rejected.
3. Require a verified email (and, where the flow depends on it, a verified phone) from the *token claims*, not from the request body.
4. Map `uid` to `merchant_users` via `auth_identities`; reject if no mapping or the user is suspended. Load roles from Postgres memberships on each request (cache briefly).
5. Keep the service-account key out of the repository and the frontends; store it as a server secret with minimal IAM; rotate on a schedule.
6. If cookies are used (Firebase session cookies), set `HttpOnly`, `Secure`, `SameSite`, short lifetime, and add CSRF protection to state-changing routes; otherwise send the ID token in the `Authorization` header and never in URLs or logs.
7. Rate-limit auth-adjacent endpoints and log verification failures (without logging tokens).
8. Expect short-lived ID tokens (refresh on the client); do not extend their lifetime on the server.

Primary reference: Firebase's "Verify ID tokens" documentation.

### 9.4 Why a hybrid beats either extreme

Postgres-only would mean building auth and push plumbing by hand; Firebase-everything would split transactional truth across two databases and abandon constraints, joins and the existing security model. The hybrid keeps one source of truth and rents only the commodity parts.

---

## 10. Architecture and data model proposals

### 10.1 Placement in the five repositories

| Concern | Repository | How |
|---|---|---|
| Public reads of all source types | `backend-api` (public process) | Additive `source_type` and a new mixed endpoint; bank-only remains the default |
| Seller writes, auth, billing webhooks, campaign serving writes | `backend-api` (seller process, own role) | New modules `merchants`, `catalog`, `campaigns`, `billing`, `events` |
| Review, moderation, partner management, reports | `admin/api` + `admin/dashboard` | New routes/pages; same private trust model |
| Seller portal and promote-your-business pages | `frontend/web` | `/business/*` route group; `/business` landing |
| Merchant interest, consumer-side sponsored/event UI, drawer | `frontend/web`, `frontend/mobile` | New components; reuse the existing semantics layer |
| Background jobs (expiry, invoicing, aggregation, pruning) | `admin/api` jobs infrastructure first | Reuse the PostgreSQL lease/fencing scheduler instead of a queue service |

No new repositories and no microservices. Separate **processes** and **database roles** inside existing repositories provide the security boundary.

### 10.2 Common discovery model without disturbing `offers`

Keep `offers` exactly as the bank pipeline owns it. Add new tables for the new sources and expose one **read model** to consumers:

```
offers (BANK, unchanged)  ┐
promotions (MERCHANT)      ├──► discovery_items  (SQL VIEW first; denormalized table if needed)
sponsored_items (SPONSORED)│        common projection + source_type + label_kind + verification_level
partner_deals (OFFICIAL)   ┘
```

Common projection: `id`, `source_type` (`BANK|MERCHANT|SPONSORED|OFFICIAL_PARTNER`), `title`, `merchant_ref`, `discount` (structured: `kind: PERCENT|AMOUNT|TEXT`, `value`, `qualifier: EXACT|UP_TO|UNSPECIFIED`), `valid_from`, `valid_to`, `locations` (each with `precision: BRANCH|AREA`), `category`, `eligibility` (bank only), `source_ref`, `verification_level`, `label`. Structured discounts remove the need for the "is there an 'up to' in the title" inference for non-bank sources (bank offers keep the existing inference until an additive field exists).

Compatibility rules: `GET /api/offers` keeps returning **BANK only**, byte-compatible; new clients opt in via `source_type=` or the new `GET /api/discovery`. `source_type` is added to responses additively. The public role gets `SELECT` on the view only.

### 10.3 Conceptual tables (examples, not migrations)

```text
merchant_users(id, email, phone, status, created_at)            auth_identities(provider, subject, user_id)
businesses(id, owner_user_id, kind[INDIVIDUAL|COMPANY], legal_name, trading_name, category, status,
           verification_level, canonical_merchant_id NULL, created_at)
business_members(business_id, user_id, role)                      business_documents(id, business_id, type, storage_key, status)
business_locations(id, business_id, name, address, lat, lng, precision, status)
business_reviews(id, business_id, reviewer_id, decision, reasons, created_at)      -- append-only audit

promotions(id, business_id, title, discount_kind, discount_value, discount_qualifier, valid_from, valid_to,
           terms, status, moderation_state, created_at)           promotion_locations(promotion_id, location_id)
events(id, business_id, title, starts_at, ends_at, venue_location_id, ticket_info, status, ...)
plans(id, code, interval, entitlements JSONB, active)             subscriptions(id, business_id, plan_id, status, period_start, period_end, cancel_at)
invoices(id, number, business_id, amount_minor, currency, status, issued_at)      payments(id, invoice_id, provider, provider_ref UNIQUE, status)
payment_events(id, provider, event_id UNIQUE, payload, received_at, processed_at) ledger_entries(id, account, debit_minor, credit_minor, ref)
campaigns(id, owner_type, owner_id, objective, starts_at, ends_at, budget_minor, status)
creatives(id, campaign_id, locale, title, body, image_desktop, image_mobile, cta, destination, status, version)
placements(slot, max_items, formats)                              campaign_targets(campaign_id, kind, value)
event_daily(campaign_id, creative_id, slot, day, impressions, clicks)             -- aggregates only
partners(id, legal_name, status, account_manager)                 partner_agreements(id, partner_id, starts_on, ends_on, terms_ref, status)
reports(id, target_type, target_id, reason, status, created_at)   moderation_actions(id, target_type, target_id, actor_id, action, reason)
notifications(id, user_id, kind, payload, sent_at)                audit_log(id, actor, action, target, at, detail)
```

Row-level ownership checks (`business_members`) are enforced in the seller API; the seller role has no access to `offers`, `scrape_*` or admin tables.

### 10.4 Conceptual API surface

```text
Public (read-only process)
  GET  /api/offers                      unchanged, BANK only        GET /api/offers?source_type=MERCHANT   (opt-in)
  GET  /api/discovery                   mixed feed with labels      GET /api/businesses/:slug  /api/events  /api/events/:id
  GET  /api/placements?slot=&lang=&district=&category=             POST /api/events/track   (batched, rate-limited)
  POST /api/business-interest           waitlist form (rate-limited, no account)

Seller (separate process, authenticated)
  POST /seller/session (verify token)   GET/PATCH /seller/me          POST/GET/PATCH /seller/businesses
  POST /seller/businesses/:id/submit    POST /seller/businesses/:id/documents (signed upload URL)
  CRUD /seller/promotions, /seller/events, /seller/locations           GET /seller/reports/summary
  GET  /seller/subscription             POST /seller/subscription/checkout   POST /seller/subscription/cancel
  POST /webhooks/payments/:provider     (signature-verified, idempotent)

Admin (private, existing admin API)
  GET  /admin/businesses?status=SUBMITTED   POST /admin/businesses/:id/decision
  GET  /admin/promotions?moderation=PENDING  POST /admin/promotions/:id/decision
  CRUD /admin/campaigns, /admin/creatives/:id/decision, /admin/partners, /admin/agreements
  GET  /admin/reports   POST /admin/moderation-actions   GET /admin/payments  POST /admin/invoices/:id/mark-paid
```

### 10.5 Consumer integration

Web and Flutter keep one rendering path per source type behind the existing semantics layer (`lib/offers.ts`, `OfferSemantics`), extended with `source_type`-aware label and styling; the bank card is unchanged. A "Sponsored"/"From the business"/"Official partner" label is part of the card, not an optional decoration. Nearby and map apply the same precision rule to merchant locations (a pin needs `precision: BRANCH`).

---

## 11. Seller and admin dashboards

### 11.1 Seller dashboard (`/business/*`)

Overview (status, active/expiring offers, verification state, what to do next) · Offers (create from a structured form with live preview in all three languages, submit, status, expiry, renew) · Events · Campaigns (choose slot, dates, creative, see estimated reach honestly as a range, submit for review) · Locations (map picker with precision) · Subscription and billing (plan, usage vs entitlement, invoices, payment method via hosted checkout) · Analytics (impressions, clicks, offer views per day; no vanity numbers) · Verification (documents, status, reviewer messages) · Support (contact form and status). Mobile-first, because most Sri Lankan small-business owners use phones; the form must work on a small screen and with Sinhala/Tamil input.

### 11.2 Platform admin additions (existing dashboard, same conventions as the redesigned review workspace)

- **Merchant applications queue:** evidence viewer, duplicate-business warnings, approve/needs-info/reject with required reasons (confirmation dialogs and audit history already patterned in the dashboard).
- **Promotion and creative moderation:** side-by-side previews in all languages and both device sizes; policy checklist; reasons.
- **Reports and abuse:** investigate reports, suspend a business or offer, restore.
- **Campaign management:** approve, pause, adjust, see pacing and delivery.
- **Partnerships:** prospects, agreements with dates, label status derived from agreements.
- **Billing ops:** invoices, manual payment confirmation (Phase D), failed-payment follow-up, refunds with reasons.
- **Quality policy:** thresholds (max discount, max validity), blocklists, trusted-merchant graduation.

Every consequential action is confirmed, states its effect, and is written to `audit_log`. The existing rule holds: nothing publishes automatically.

---

## 12. Security, privacy and moderation requirements

**Security**
- Separate database roles per process: public (SELECT on views), seller (writes merchant tables only), admin (privileged). No shared credentials, no fallback to a more privileged role.
- Authentication on every seller route; server-side authorization from Postgres; object-level ownership checks on every id (prevents IDOR); input validation with schemas; output projections (never return rows directly).
- Uploads: signed, size- and type-limited, scanned or re-encoded, served from a different origin/CDN path, never executed; images resized server-side.
- Rate limiting and bot protection at Cloudflare plus per-route limits in the API (the public API currently has none in code; add as Phase A hardening). Cache headers and compression for public GETs.
- Secrets in environment/secret stores only. The existing practice of never committing `.env` or the SSH key continues.
- Webhook signature verification, replay protection, idempotency (section 5).
- Dependency and container hygiene proportional to a small team: lockfiles, automated advisory alerts.
- The current database connection uses `rejectUnauthorized: false` for non-local hosts; plan to move to verified TLS for all roles as part of Phase A hardening.

**Privacy** (Sri Lanka's Personal Data Protection Act applies to merchant and consumer data **[verify obligations and timelines with counsel]**)
- Collect the minimum; document purposes; explicit consent for marketing and for the analytics events; privacy policy and terms in all three languages before any account exists.
- Merchant documents are the most sensitive data: restricted access, access logging, retention limit after verification, deletion on request where permitted.
- Consumer location is used only to answer a query and is not stored (current behaviour, kept).
- Event tracking is aggregate with no persistent user id; raw events pruned.
- Data export and deletion procedures for merchants.

**Moderation and fraud:** layered as in sections 3.3 and 6.4; a written content policy (prohibited categories, misleading-claim rules, comparative-claim rules); response-time targets for reports; a clear appeals path; reviewers' decisions are always reasoned and logged.

**Consumer protection:** clear sponsored labelling, no fake scarcity, no hidden fees in merchant offers (terms field required), an obvious "report this offer" action. **[verify advertising and consumer-protection requirements with counsel.]**

---

## 13. Phased roadmap

Complexity: S ≈ days, M ≈ 2–4 weeks, L ≈ 1–3 months for one or two developers. These are planning magnitudes, not commitments.

### Phase A — Improve bank-offer discovery

| | |
|---|---|
| **Business goals** | A consumer product people trust and return to; a usage baseline. |
| **Essential features** | Finish data accuracy (additive API `location_precision`, `discount_qualifier`, structured caps if the sources allow); public-API hardening (rate limits, cache headers, compression, verified TLS, connection budget); first-party aggregate usage measurement; merge the web/mobile/dashboard work now in review; i18n review by native speakers; crash/error reporting. |
| **Database** | Additive columns/fields on read projections only; usage aggregate table. |
| **API** | Additive fields; `Cache-Control`/ETag; rate-limit headers. |
| **Web / Flutter** | Already redesigned; remove placeholder gaps; consume new fields. |
| **Admin** | Operational dashboards already improved; add data-quality counters. |
| **Security/privacy** | TLS verification, privacy policy, minimal analytics consent. |
| **Complexity** | M |
| **Cost drivers** | Developer time; negligible infrastructure. |
| **Dependencies** | Stable CI for five repos; decision on which usage tool (first-party endpoint vs Cloudflare analytics) **[verify availability/cost]**. |
| **Success criteria** | Measured weekly active users and returning-visitor rate; p95 API latency recorded; zero known data-accuracy defects in a manual audit of a sample; web and app crash-free rate recorded. |

### Phase B — Validate merchant interest

| | |
|---|---|
| **Business goals** | Learn whether businesses want this, and what they would pay for, before building SaaS. |
| **Essential features** | `/business` landing page (en/si/ta); drawer/card per section 4; interest form; admin list of submissions; manual follow-up; short interviews. |
| **Database** | `business_interest(id, name, category, district, contact, intent, consent, created_at, status)`; `ui_events` aggregates. |
| **API** | `POST /api/business-interest` (rate-limited, honeypot). Runs in the existing public process only if it can use a *write-limited role* — otherwise the seller process is started now with a single write path and nothing else (preferred; it creates the boundary early at tiny cost). |
| **Web** | Landing page, contextual card, bottom sheet, footer link. |
| **Flutter** | Inline card + Settings row opening the web landing page in the browser (no in-app signup). |
| **Admin** | Interest list with status and notes. |
| **Security/privacy** | Consent checkbox, spam protection, contact data retention policy. |
| **Complexity** | S–M |
| **Cost drivers** | Developer time; email/SMS for follow-up (manual). |
| **Dependencies** | Phase A usage baseline; legal copy. |
| **Success criteria (set the thresholds up front, e.g. in the first week)** | Defined targets for: interest-form submissions, share that are real and reachable businesses, number of discovery calls booked, number willing to try a pilot, and any stated willingness to pay. If the targets are missed, stop here and revisit — do not build Phase C. |

### Phase C — Merchant MVP

| | |
|---|---|
| **Business goals** | Real local-business offers live, verified and moderated, for free. |
| **Essential features** | Seller process and role; identity (Firebase Auth behind the abstraction, **[verify pricing/SMS]**); business profile; documents; locations with precision; manual verification; promotions with structured discounts; moderation queue; `discovery_items` view; consumer "From the business" cards and filter; report button. |
| **Database** | `merchant_users`, `auth_identities`, `businesses`, `business_members`, `business_documents`, `business_locations`, `business_reviews`, `promotions`, `promotion_locations`, `reports`, `moderation_actions`, `audit_log`, view `discovery_items`. |
| **API** | Seller routes; admin decision routes; public `source_type` and `/api/discovery`; object storage signed uploads. |
| **Web** | `/business/*` portal; labelled merchant cards; business profile pages. |
| **Flutter** | Merchant cards in Explore with the label; business detail view; no merchant login in the app yet. |
| **Admin** | Applications queue, promotion moderation, reports. |
| **Security/privacy** | Token verification (section 9.3), per-role DB access, document handling, rate limits, privacy policy and terms. |
| **Complexity** | L |
| **Cost drivers** | Auth provider, SMS/email, object storage and image bandwidth, moderation time (the real cost), support. |
| **Dependencies** | Phase B success; legal terms; storage choice; native-speaker copy. |
| **Success criteria** | Target number of verified businesses and live offers; median verification time; share of submissions approved; reports per 1,000 views; no bank-offer regression (contract tests on `/api/offers` unchanged). |

### Phase D — Paid promotions

| | |
|---|---|
| **Business goals** | First revenue from sponsored placement and subscriptions without eroding trust. |
| **Essential features** | Plans and entitlements; invoices; **manual payment confirmation first**, gateway second; campaigns, creatives, placements, scheduling; "Sponsored" labelling; impression/click aggregates; merchant reports; pacing and frequency caps; renewal/cancel/downgrade. |
| **Database** | `plans`, `plan_entitlements`, `subscriptions`, `invoices`, `payments`, `payment_events`, `ledger_entries`, `campaigns`, `creatives`, `placements`, `campaign_targets`, `event_daily`. |
| **API** | Checkout and webhook endpoints (when the gateway is added); `/api/placements`; `/api/events/track`; admin billing and campaign routes. |
| **Web** | Billing pages; sponsored slots; campaign builder with preview. |
| **Flutter** | Sponsored cards in the agreed slots; no in-app purchase (web checkout only). |
| **Admin** | Billing ops, campaign approval, delivery monitoring. |
| **Security/privacy** | Webhook verification, ledger integrity, PCI scope kept at hosted checkout, fraud/click-spam controls. |
| **Complexity** | L |
| **Cost drivers** | Gateway fees **[verify]**, creatives bandwidth, aggregation jobs, chargebacks/refunds, finance admin time. |
| **Dependencies** | Phase C live merchants; provider confirmed in writing; accountant guidance. |
| **Success criteria** | Paying merchants and recurring revenue vs the cost of running the platform; renewal rate; sponsored click-through within an honest range; complaint rate about sponsored content; zero payment reconciliation discrepancies. |

### Phase E — Events and partner brands

| | |
|---|---|
| **Business goals** | New content types and larger agreements. |
| **Essential features** | Events (submission, moderation, section, map), event packages; partner organizations, agreements, `OFFICIAL_PARTNER` items with derived labels; bulk CSV and signed bulk feed; partner reports; account-manager workflow. |
| **Database** | `events`, `partners`, `partner_agreements`, `partner_deals`, feed import tables. |
| **API** | Public events endpoints; partner feed endpoint; admin partner routes. |
| **Web / Flutter** | Events section, event detail, partner badge; Flutter event code reviewed/reused. |
| **Admin** | Partner pipeline and agreement tracking; event moderation. |
| **Security/privacy** | Per-partner API keys, import validation, contract records. |
| **Complexity** | L |
| **Cost drivers** | Sales and account-management time, event imagery, support. |
| **Dependencies** | Phase D revenue; signed agreements for any partner claim. |
| **Success criteria** | Number of signed agreements (counted, not projected); events listed and attended-intent clicks; partner retention. |

### Phase F — Scale infrastructure

| | |
|---|---|
| **Business goals** | Keep performance and cost steady as usage grows. |
| **Essential features** | Firebase Cloud Messaging and (optionally) Remote Config; denormalized `discovery_index`; read replica or caching if measured; PostGIS-based nearby; queue service only if the lease-based scheduler is outgrown; CDN for images; consumer accounts only if a measured need exists. |
| **Database** | Index table, replicas, partitioned event aggregates. |
| **API / clients** | Push registration, notification preferences, cache layers. |
| **Complexity** | M–L, each item justified by a measurement |
| **Cost drivers** | Database tier, replica, CDN egress, push volume. |
| **Dependencies** | Real load or cost data. |
| **Success criteria** | Latency and error budgets held at the next 10× of usage; cost per active user stable or falling. |

### MVP versus later

**Must-have for a credible merchant MVP (Phase C):** verified business profile, manual verification, structured offer submission, moderation, clear labels, report button, separate seller process/role, privacy policy and terms.
**Defer:** self-serve payments, automated pacing, bulk feeds, push, consumer accounts, in-app merchant login, AI moderation, analytics SDKs, anything needing a queue service.

---

## 14. Scalability and cost analysis

### 14.1 Cost drivers (no prices claimed)

Database (compute tier, connections, storage, replicas) · object storage and image transformation · CDN/egress for images and creatives · API compute on the existing VM · authentication (active users, SMS/OTP for phone verification) · transactional email/SMS · push · payment gateway fees and refunds · background jobs (aggregation, expiry, invoicing) · fraud/abuse tooling · analytics storage · moderation and support labour (usually the largest real cost at small scale).

### 14.2 What changes at each stage

| Stage | What gets stressed | Likely response (smallest first) |
|---|---|---|
| **100 merchants**, tens of thousands of consumers | Moderation queue; connection budget; image storage begins | Keep one VM and one Neon database; pooled connections for the public process; cap per-process pool × PM2 instances so total stays well under the plan's connection limit; manual verification; email only |
| **1,000 merchants** | Moderation throughput; search over a larger `discovery_items`; image bandwidth; invoices/renewals | Trusted-merchant fast lane; trigram/GiST indexes already exist; cache `GET` responses at Cloudflare; CDN-cached images; scheduled jobs on the existing lease scheduler; start Phase D automation |
| **10,000 merchants** | Review labour; geo queries; aggregate volume; support | Denormalized `discovery_index` table; use the PostGIS `geom` instead of JSONB haversine; read replica if measured; partition `event_daily`; self-serve verification tiers; support tooling |
| **100,000 monthly active consumers** | API request volume (cacheable reads dominate); campaign impressions; notifications | Edge caching for list/detail/placement GETs; batch and sample impression events; push via FCM; keep sponsored selection deterministic and cached per slot/district; revisit instance count vs connections |

**Estimating cost honestly:** model it as `requests × payload`, `images × size × views`, `merchants × review minutes`, `payments × fee + refunds`, using measured numbers from Phases A–C, then price against current provider pages. Before then, any dollar figure would be invention.

### 14.3 Things deliberately not done

Kubernetes, microservices per feature, a separate queue/broker, Firestore for transactional data, AI-heavy moderation or ranking, a data warehouse, real-time bidding. Each can be reconsidered only when a measurement shows the simpler option failing.

---

## 15. Key technical risks and tradeoffs

| Risk | Why it matters | Mitigation |
|---|---|---|
| Merchant offers shown as bank offers | Destroys the product's trust and breaks existing apps | Keep `/api/offers` BANK-only; opt-in `source_type`; labelled cards; contract tests that fail if non-bank items appear in bank responses |
| Weakening the read-only public boundary | Security invariant | Separate seller process and role; public role gets view-only SELECT |
| Moderation labour outgrows the team | Fake or low-quality listings | Structured fields, deterministic checks, trusted lane, reports, suspension; limit growth to review capacity |
| Hand-rolled auth | Highest-risk code for a small team | Hosted identity behind an abstraction; server-side token verification |
| Provider facts assumed | Wrong gateway/fee/recurring assumptions | Mark **[verify]**; written confirmation before building; start with manual payments |
| Premature platform building | Months spent before demand is proven | Phase B gate with predefined thresholds |
| Connection exhaustion | Cluster-mode pools multiply connections | Pooled endpoint, per-process pool cap, measured budget |
| Geocoder precision mixing with merchant pins | False "branch" claims | `precision` on every location; the existing area-only rule |
| Sponsored placement eroding trust | Users stop believing the feed | Hard label, slot discipline, no fake urgency, complaint-rate metric as a launch gate |
| Legal/tax/privacy unknowns | Compliance exposure | Counsel and accountant review **[verify]** before Phase C (privacy, terms) and Phase D (invoicing/tax) |
| Official-partnership claims | Misrepresentation | Derived label tied to an active agreement record only |
| Single VM / PM2 as a single point of failure | Availability | Health checks exist; add uptime monitoring in Phase A; revisit hosting only when revenue depends on uptime |

---

## 16. Immediate, no-regret next steps (still planning-level)

1. Merge and release the in-review web, mobile, dashboard and admin changes; keep five repositories independent.
2. Phase A hardening items that need no business decision: rate limiting, cache headers, compression, verified TLS, connection budget check (`SHOW max_connections;`, which URL `DATABASE_PUBLIC_URL` uses).
3. Write the Phase B success thresholds down before building the landing page.
4. Start the **[verify]** list in parallel: payment providers (written answers), Firebase Authentication and SMS cost, object storage pricing, Sri Lankan privacy/advertising/tax obligations.
5. Draft the content policy and merchant terms with counsel so Phase C is not blocked on paperwork.

## Sources consulted for outside-service facts

- Firebase, [Verify ID Tokens](https://firebase.google.com/docs/auth/server/verify-id-tokens) — server-side verification with the Admin SDK, service account requirement, ID token versus custom token.
- Neon, [Connection pooling](https://neon.com/docs/connect/connection-pooling) — PgBouncer pooled endpoint (`-pooler`), transaction-mode limitations, direct versus pooled connections.
- PayHere — only secondary sources were reachable ([overview](https://akurateco.com/payment-methods/payhere-lk), [integration package](https://github.com/Visanduma/laravel-payhere), [older fee article](https://readme.lk/payhere-lankan-payment-gateway-returns/)); official merchant terms and current fees were **not** confirmed.
- Not verified at all: Firebase Authentication pricing, SMS/OTP cost in Sri Lanka, Cloudflare R2/Images pricing, other Sri Lankan gateways, PDPA specifics, tax/invoicing rules.
