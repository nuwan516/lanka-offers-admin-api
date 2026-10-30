# Lanka Offers — Security Architecture & Hardening

## 1. Least-Privilege Database Access

The primary security control isolating production data from public consumers is strict PostgreSQL role segregation:

```text
[ Public Consumer API ] (backend-api)
          │
          ▼
Role: lanka_offers_public_api
├── SELECT on published views/tables only
├── ZERO INSERT, UPDATE, DELETE permissions
├── ZERO DDL permissions
└── Fails closed if privileged credentials supplied

[ Admin Control Plane ] (admin/api)
          │
          ▼
Role: lanka_offers_admin
├── Full read/write on staging, audit, and runs
├── DDL permissions for migrations
└── Protected within private network boundary
```

### 1.1 Database Role Setup Script
Located in `backend-api/database/security/setup_roles.sql`:
```sql
-- Create restricted public read role
CREATE ROLE lanka_offers_public_api WITH LOGIN PASSWORD '...';

-- Grant minimal permissions
GRANT CONNECT ON DATABASE lanka_offers TO lanka_offers_public_api;
GRANT USAGE ON SCHEMA public TO lanka_offers_public_api;
GRANT SELECT ON TABLE offers TO lanka_offers_public_api;

-- Revoke dangerous privileges
REVOKE ALL ON TABLE scrape_runs FROM lanka_offers_public_api;
REVOKE ALL ON TABLE offer_review_history FROM lanka_offers_public_api;
REVOKE ALL ON SCHEMA public FROM lanka_offers_public_api CASCADE;
```

### 1.2 Fail-Closed Boot Verification
On startup, `backend-api/src/config/env.ts` and `db-client.ts` execute a preflight query:
1. Verifies the connection role is `lanka_offers_public_api`.
2. Attempts a canary write to a dummy table.
3. If write succeeds or role is `postgres`/`admin`, process immediately aborts (`process.exit(1)`) to prevent accidental privilege leakage.

---

## 2. Source Provenance & Synthetic Isolation (Invariant #12)

To prevent synthetic test data, mock fixtures, or untrusted inputs from contaminating production databases:

- **Server-Side Provenance Engine (`admin/api/src/domain/source-provenance.ts`):** Validates the origin URL and bank hostname against an authoritative whitelist.
- **Fixture Guarding:** Synthetic test fixtures are tagged with `synthetic_provenance: true`. The staging insertion pipeline asserts that `synthetic_provenance` is undefined or false before permitting persistence.

---

## 3. Public API Sanitization & Hardening

1. **SQL Injection Prevention:** 100% of database queries use parameterized placeholders (`$1, $2, ...`). No raw string concatenation is permitted in query builders.
2. **Deterministic Limit Capping:** List queries enforce `Math.min(parsedLimit, 500)` to prevent memory exhaustion or denial-of-service via oversized pages.
3. **CORS Restrictions:** Configured via `cors` middleware, defaulting to verified web and mobile domains.
4. **Header Hardening:**
   - Public API sends `Cache-Control: no-store` to prevent stale proxy caching of rapidly changing financial promotions.
   - Standard security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).

---

## 4. Secrets & Credentials Hygiene

- All environment files (`.env`, `.env.local`, `.env.production`) are excluded by `.gitignore`.
- SSH deployment keys (`ssh-key-*.key`) are strictly forbidden from version control and CI logs.
- Sensitive environment configurations fail loudly if default insecure passwords are detected in production mode.
