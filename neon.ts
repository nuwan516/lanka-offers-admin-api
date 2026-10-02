import { defineConfig } from "@neon/config/v1";

/**
 * Neon infrastructure config for Lanka Offers — Lakebase Postgres only.
 *
 * Project : lanaka-offers      (shiny-frost-69896486)
 * Org     : Nuwan              (org-weathered-lab-68042936)
 * Region  : ap-southeast-1    (closest to Sri Lanka)
 *
 * Services in use:
 *   - Lakebase Postgres (pooled for app queries, direct for migrations)
 *
 * Run `neon deploy` to reconcile this config against the live branch.
 * Run `neon env pull` to refresh .env with the branch's connection strings.
 */
export default defineConfig({
  // Postgres is always included — no extra declaration needed.
  // Add auth / dataApi / preview services here when required.
});
