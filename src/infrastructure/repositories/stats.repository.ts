import { pool } from '../db/db-client';
import { getDuplicateStats, type DuplicateStats } from '../db/duplicate-repository';
import { getCostControlConfig } from '@/config/cost-control';
import { getCurrentPeriodUsage } from '../db/offer-repository';
import { evaluateCostGuard } from '../cost-control/cost-guard';

export interface AdminStatsResponse {
  offers: Record<string, unknown>;
  runs: Record<string, unknown>;
  validation: Record<string, unknown>;
  duplicates: DuplicateStats;
}

export interface MerchantOverview {
  name: string;
  canonical_merchant: string | null;
  offer_count: number;
  bank_count: number;
  observed_names: string[];
  observed_scopes: string[];
}

export class StatsRepository {
  public async checkHealth(): Promise<boolean> {
    try {
      await pool.query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  public async getCostControlStatus() {
    const config = getCostControlConfig();
    const usageRows = await getCurrentPeriodUsage();
    const usageByService = new Map(usageRows.map((r) => [r.service, r.requestCount]));

    const services = Object.values(config.services).map((svc) => {
      const used = usageByService.get(svc.service) ?? 0;
      const decision = evaluateCostGuard(svc, used);
      return {
        service: svc.service,
        used,
        limit: svc.limit,
        percentage: decision.percentage,
        state: decision.verdict,
        enabled: svc.enabled,
        reason: decision.reason,
      };
    });

    return {
      services,
      policy: {
        llmMode: config.llm.mode,
        llmPrimaryProvider: config.llm.primaryProvider,
        llmFallbackProvider: config.llm.fallbackProvider,
        allowPaidLlmFallback: config.llm.allowPaidFallback,
        llmValidationEnabled: config.llm.validationEnabled,
        geoProviderCallsEnabled: config.geoProviderCallsEnabled,
        placesEnrichmentEnabled: config.placesEnrichmentEnabled,
      },
      periodKey: usageRows[0]?.periodKey ?? null,
    };
  }

  public async getAdminStats(): Promise<AdminStatsResponse> {
    const [offerStats, runStats, validationStats, duplicates] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE db_status = 'PUBLISHED') AS active_offers,
          COUNT(*) AS total_offers,
          COUNT(*) FILTER (WHERE llm_valid = true) AS llm_valid,
          COUNT(*) FILTER (WHERE rule_passed = false) AS rule_failed,
          COUNT(*) FILTER (WHERE llm_score IS NOT NULL) AS llm_scored,
          ROUND(AVG(llm_score) FILTER (WHERE llm_score IS NOT NULL)) AS avg_llm_score,
          COUNT(DISTINCT bank) AS banks_with_data,
          COUNT(*) FILTER (WHERE db_status IN ('DISCOVERED', 'PENDING_REVIEW', 'REVIEW_REQUIRED') OR pending_candidate IS NOT NULL) AS pending_review,
          COUNT(*) FILTER (WHERE db_status = 'APPROVED') AS pending_sync,
          COUNT(*) FILTER (WHERE geo_status = 'unresolved' OR ((geo_locations IS NULL OR geo_locations = '[]'::jsonb) AND merchant_location IS NOT NULL)) AS unresolved_geo
        FROM offers
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'running') AS running_jobs,
          COUNT(*) FILTER (WHERE status = 'failed' AND started_at > NOW() - INTERVAL '24h') AS failed_today,
          COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24h') AS runs_today,
          COALESCE(SUM(offers_found) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS scraped_today,
          COALESCE(SUM(offers_new) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS new_today,
          COALESCE(SUM(offers_changed) FILTER (WHERE started_at > NOW() - INTERVAL '24h'), 0) AS changed_today,
          MAX(started_at) AS last_run_at
        FROM scrape_runs
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE passed = false) AS validation_failures,
          COUNT(*) AS total_validated
        FROM validation_reports
      `),
      getDuplicateStats(),
    ]);

    return {
      offers: offerStats.rows[0],
      runs: runStats.rows[0],
      validation: validationStats.rows[0],
      duplicates,
    };
  }

  public async getMerchants(limit = 100): Promise<MerchantOverview[]> {
    const result = await pool.query<MerchantOverview>(`
      SELECT
        COALESCE(canonical_merchant, merchant_name) AS name,
        canonical_merchant,
        COUNT(*)::int AS offer_count,
        COUNT(DISTINCT bank)::int AS bank_count,
        ARRAY_AGG(DISTINCT merchant_name) FILTER (WHERE merchant_name IS NOT NULL) AS observed_names,
        ARRAY_AGG(DISTINCT location_scope) FILTER (WHERE location_scope IS NOT NULL) AS observed_scopes
      FROM offers
      WHERE db_status = 'PUBLISHED'
        AND COALESCE(canonical_merchant, merchant_name) IS NOT NULL
        AND COALESCE(canonical_merchant, merchant_name) <> ''
      GROUP BY COALESCE(canonical_merchant, merchant_name), canonical_merchant
      ORDER BY offer_count DESC
      LIMIT $1;
    `, [limit]);

    return result.rows;
  }
}

export const statsRepository = new StatsRepository();
