#!/usr/bin/env ts-node
/**
 * Lanka Offers — Unified Admin CLI
 *
 * Operational & Diagnostic CLI Tool for administrators, scraper operators,
 * and data engineers.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/admin.ts <command> [options]
 *   npm run admin <command> [options]
 *
 * Commands:
 *   status           Display database, offer lifecycle, and scraper operational metrics
 *   budget           Inspect external API usage, quota limits, and CostGuard kill switches
 *   scrape [bank]    Trigger bank scraper (options: --cache, --skip-details, --no-validate, --llm)
 *   sync             Inspect and publish approved staging offers to consumer production
 *   geocode [bank]   Run geocoding and location classification pipeline
 *   duplicates       Check duplicate candidate pairs and cluster status
 *   rules [bank]     Inspect dynamic bank parser rules stored in Postgres
 *   clean            Clear local scraper cache and temporary files
 *   help             Display this help message
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { pool, closePool } from '@/infrastructure/db/db-client';
import { statsRepository } from '@/infrastructure/repositories/stats.repository';
import { getCostControlConfig, formatSafePolicySummary } from '@/config/cost-control';
import { BankName, getBankConfig, listBanksByCapability } from '@/config/banks';

// ─── ANSI Styling Helpers ───────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

function banner(title: string): void {
  console.log(`\n${CYAN}══════════════════════════════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${BOLD}${title}${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════════════════════════════════════════${RESET}\n`);
}

function progressBar(percentage: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let color = GREEN;
  if (clamped >= 95) color = RED;
  else if (clamped >= 70) color = YELLOW;

  const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
  return `[${bar}] ${color}${clamped.toFixed(1)}%${RESET}`;
}

// ─── Command: Status ─────────────────────────────────────────────────────────

async function handleStatus(): Promise<void> {
  banner('LANKA OFFERS — SYSTEM & DATABASE STATUS');

  const start = Date.now();
  let dbOk = false;
  try {
    const ping = await pool.query('SELECT NOW() AS now, current_database() AS db');
    const latency = Date.now() - start;
    console.log(`  ${GREEN}✓${RESET} Database Connection: ${BOLD}ONLINE${RESET} (${latency}ms) — Database: ${CYAN}${ping.rows[0]?.db}${RESET}`);
    dbOk = true;
  } catch (err) {
    console.log(`  ${RED}✗ Database Connection: OFFLINE${RESET} (${err instanceof Error ? err.message : err})`);
    return;
  }

  if (dbOk) {
    const stats = await statsRepository.getAdminStats();
    const o = stats.offers;
    const r = stats.runs;
    const v = stats.validation;

    console.log(`\n${BOLD}[CATALOG] Offer Catalog Metrics:${RESET}`);
    console.log(`  • Published (Active Public):  ${GREEN}${BOLD}${o.active_offers}${RESET}`);
    console.log(`  • Total in Database:          ${o.total_offers}`);
    console.log(`  • Pending Review / Staging:   ${Number(o.pending_review || 0) > 0 ? YELLOW : WHITE}${o.pending_review ?? 0}${RESET}`);
    console.log(`  • Pending Sync (Approved):    ${Number(o.pending_sync || 0) > 0 ? CYAN : WHITE}${o.pending_sync ?? 0}${RESET}`);
    console.log(`  • Unresolved Geo Locations:   ${Number(o.unresolved_geo || 0) > 0 ? YELLOW : WHITE}${o.unresolved_geo ?? 0}${RESET}`);
    console.log(`  • LLM Validated:              ${o.llm_valid} (Avg Score: ${o.avg_llm_score ?? 'N/A'}/100)`);
    console.log(`  • Rule Failures:              ${Number(o.rule_failed || 0) > 0 ? RED : GREEN}${o.rule_failed ?? 0}${RESET}`);
    console.log(`  • Banks with Active Data:     ${o.banks_with_data}`);

    console.log(`\n${BOLD}[SCRAPER] Scraper Engine (Last 24h):${RESET}`);
    console.log(`  • Running Jobs:               ${Number(r.running_jobs || 0) > 0 ? CYAN : WHITE}${r.running_jobs ?? 0}${RESET}`);
    console.log(`  • Total Runs Today:           ${r.runs_today ?? 0}`);
    console.log(`  • Offers Scraped Today:       ${r.scraped_today ?? 0} (New: ${r.new_today ?? 0}, Changed: ${r.changed_today ?? 0})`);
    console.log(`  • Failures Today:             ${Number(r.failed_today || 0) > 0 ? RED : GREEN}${r.failed_today ?? 0}${RESET}`);
    console.log(`  • Last Run Timestamp:         ${r.last_run_at ?? 'Never'}`);

    console.log(`\n${BOLD}[VALIDATION] Validation Pipeline:${RESET}`);
    console.log(`  • Total Validated:            ${v.total_validated ?? 0}`);
    console.log(`  • Validation Failures:        ${Number(v.validation_failures || 0) > 0 ? RED : GREEN}${v.validation_failures ?? 0}${RESET}`);

    if (stats.duplicates) {
      console.log(`\n${BOLD}[DUPLICATES] Duplicate Detection:${RESET}`);
      console.log(`  • Pending Candidates:         ${stats.duplicates.pending ?? 0}`);
      console.log(`  • Confirmed Duplicates:       ${stats.duplicates.confirmed ?? 0}`);
      console.log(`  • Marked Non-Duplicates:      ${stats.duplicates.notDuplicate ?? 0}`);
    }
  }
}

// ─── Command: Budget ────────────────────────────────────────────────────────

async function handleBudget(): Promise<void> {
  banner('ZERO-COST BUDGET & QUOTA TRACKER (AWS CLOUDSCAPE ALIGNED)');

  const status = await statsRepository.getCostControlStatus();
  const config = getCostControlConfig();

  console.log(`${BOLD}Current Billing Period:${RESET} ${CYAN}${status.periodKey ?? 'Current Month'}${RESET}`);
  console.log(`${BOLD}Zero-Cost Mode:${RESET}         ${GREEN}ENFORCED ($0.00 / mo budget)${RESET}\n`);

  console.log(`${BOLD}Service Quotas & CostGuard Status:${RESET}`);
  console.log('┌───────────────────────┬────────────┬─────────────┬──────────────────────────┬───────────┐');
  console.log('│ Service               │ Used / Cap │ % Budget    │ Gauge                    │ State     │');
  console.log('├───────────────────────┼────────────┼─────────────┼──────────────────────────┼───────────┤');

  for (const s of status.services) {
    const serviceName = s.service.padEnd(21);
    const usage = `${s.used} / ${s.limit}`.padEnd(10);
    const pct = `${s.percentage}%`.padEnd(11);
    const gauge = progressBar(s.percentage, 14);

    let stateColor = GREEN;
    if (s.state === 'WARN') stateColor = YELLOW;
    else if (s.state === 'BLOCK') stateColor = RED;
    const stateStr = `${stateColor}${s.state.padEnd(9)}${RESET}`;

    console.log(`│ ${serviceName} │ ${usage} │ ${pct} │ ${gauge} │ ${stateStr} │`);
  }
  console.log('└───────────────────────┴────────────┴─────────────┴──────────────────────────┴───────────┘\n');

  console.log(`${BOLD}[POLICY] CostGuard Policy & Kill Switches:${RESET}`);
  console.log(`  • LLM Mode:                  ${status.policy.llmMode}`);
  console.log(`  • Primary LLM Provider:      ${CYAN}${status.policy.llmPrimaryProvider}${RESET} (Free Tier Gemini)`);
  console.log(`  • Paid Fallback (DeepSeek):  ${status.policy.allowPaidLlmFallback ? `${YELLOW}ENABLED (${status.policy.llmFallbackProvider})${RESET}` : `${GREEN}BLOCKED / STANDBY (Zero-Cost Safe)${RESET}`}`);
  console.log(`  • LLM Validation Gate:       ${status.policy.llmValidationEnabled ? `${GREEN}ACTIVE${RESET}` : `${RED}OFF (Kill Switch)${RESET}`}`);
  console.log(`  • Google Geocoding API:      ${status.policy.geoProviderCallsEnabled ? `${GREEN}ACTIVE${RESET}` : `${RED}OFF (Kill Switch)${RESET}`}`);
  console.log(`  • Google Places Enrichment:  ${status.policy.placesEnrichmentEnabled ? `${GREEN}ACTIVE${RESET}` : `${RED}OFF (Kill Switch)${RESET}`}`);

  console.log(`\n${DIM}Tip: You can configure alert thresholds via COST_GUARD_WARN_PERCENT (default: 70%) and COST_GUARD_BLOCK_PERCENT (default: 95%).${RESET}`);
}

// ─── Command: Sync ──────────────────────────────────────────────────────────

async function handleSync(publish: boolean): Promise<void> {
  banner('OFFER STAGING & PRODUCTION SYNC');

  const pending = await pool.query<{
    id: string; unique_id: string; bank: string; title: string; merchant_name: string; updated_at: string;
  }>(`
    SELECT id, unique_id, bank, title, merchant_name, updated_at
    FROM offers
    WHERE db_status = 'APPROVED'
    ORDER BY updated_at DESC
  `);

  console.log(`Offers approved for staging sync: ${BOLD}${pending.rows.length}${RESET}\n`);

  if (pending.rows.length === 0) {
    console.log(`  ${GREEN}✓ No offers pending sync. All approved offers are already published.${RESET}`);
    return;
  }

  for (const row of pending.rows.slice(0, 10)) {
    console.log(`  • [${CYAN}${row.bank.toUpperCase()}${RESET}] ${row.merchant_name || 'Unknown'}: ${row.title.slice(0, 50)}...`);
  }
  if (pending.rows.length > 10) {
    console.log(`  ... and ${pending.rows.length - 10} more offers.`);
  }

  if (publish) {
    console.log(`\n${YELLOW}Publishing ${pending.rows.length} approved offers to production...${RESET}`);
    const res = await pool.query(`
      UPDATE offers
      SET db_status = 'PUBLISHED', updated_at = NOW()
      WHERE db_status = 'APPROVED'
      RETURNING id
    `);
    console.log(`  ${GREEN}✓ Successfully published ${res.rowCount} offers! They are now live on the public API & mobile app.${RESET}`);
  } else {
    console.log(`\n${DIM}To publish these offers to consumer visibility, run:${RESET}`);
    console.log(`  ${CYAN}npm run admin sync -- --publish${RESET}\n`);
  }
}

// ─── Command: Duplicates ────────────────────────────────────────────────────

async function handleDuplicates(): Promise<void> {
  banner('DUPLICATE DETECTION & MERGE WORKSPACE');

  const pairs = await pool.query<{
    total: string;
    pending: string;
    confirmed: string;
    not_duplicate: string;
    ignored: string;
  }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status = 'PENDING')::text AS pending,
      COUNT(*) FILTER (WHERE status = 'CONFIRMED_DUPLICATE')::text AS confirmed,
      COUNT(*) FILTER (WHERE status = 'NOT_DUPLICATE')::text AS not_duplicate,
      COUNT(*) FILTER (WHERE status = 'IGNORED')::text AS ignored
    FROM offer_duplicate_candidates
  `);

  const clusters = await pool.query<{ count: string }>(`
    SELECT COUNT(DISTINCT duplicate_cluster_id)::text AS count
    FROM offers
    WHERE duplicate_cluster_id IS NOT NULL
  `);

  const row = pairs.rows[0];
  console.log(`${BOLD}Duplicate Pair Metrics:${RESET}`);
  console.log(`  • Total Candidate Pairs:      ${row?.total ?? 0}`);
  console.log(`  • Pending Review:             ${Number(row?.pending || 0) > 0 ? YELLOW : GREEN}${row?.pending ?? 0}${RESET}`);
  console.log(`  • Confirmed Duplicates:       ${row?.confirmed ?? 0}`);
  console.log(`  • Marked Non-Duplicates:      ${row?.not_duplicate ?? 0}`);
  console.log(`  • Ignored:                    ${row?.ignored ?? 0}`);
  console.log(`  • Active Merged Clusters:     ${clusters.rows[0]?.count ?? 0}`);

  if (Number(row?.pending || 0) > 0) {
    console.log(`\n${DIM}Visit Admin Dashboard -> Duplicates (/duplicates) to inspect and review candidate pairs.${RESET}`);
  }
}

// ─── Command: Rules ─────────────────────────────────────────────────────────

async function handleRules(bankFilter?: string): Promise<void> {
  banner('BANK PARSER RULES (DATABASE CONFIGURATION)');

  let sql = `
    SELECT bank, rule_type, rule_name, is_active, updated_at
    FROM bank_parser_rules
  `;
  const params: unknown[] = [];
  if (bankFilter && bankFilter !== 'all') {
    sql += ' WHERE bank = $1';
    params.push(bankFilter);
  }
  sql += ' ORDER BY bank, rule_name';

  try {
    const res = await pool.query(sql, params);
    console.log(`Total rules in database: ${BOLD}${res.rows.length}${RESET}\n`);

    if (res.rows.length === 0) {
      console.log(`  ${YELLOW}No parser rules found in bank_parser_rules table.${RESET}`);
      return;
    }

    console.log('┌─────────────┬──────────────────────────┬─────────────────────────────┬──────────┐');
    console.log('│ Bank        │ Rule Name                │ Type                        │ Active   │');
    console.log('├─────────────┼──────────────────────────┼─────────────────────────────┼──────────┤');
    for (const r of res.rows) {
      const bank = (r.bank as string).padEnd(11);
      const name = (r.rule_name as string).slice(0, 24).padEnd(24);
      const type = (r.rule_type as string).slice(0, 27).padEnd(27);
      const active = r.is_active ? `${GREEN}YES     ${RESET}` : `${RED}NO      ${RESET}`;
      console.log(`│ ${bank} │ ${name} │ ${type} │ ${active} │`);
    }
    console.log('└─────────────┴──────────────────────────┴─────────────────────────────┴──────────┘');
  } catch (err) {
    console.log(`  ${RED}Error querying bank_parser_rules:${RESET} ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Command: Clean ─────────────────────────────────────────────────────────

function handleClean(): void {
  banner('CLEAN LOCAL ARTIFACTS & SCRAPER CACHE');

  const root = process.cwd();
  const entries = fs.readdirSync(root);
  let cleanedCount = 0;

  for (const entry of entries) {
    if (entry.startsWith('cache_') || entry === '.geo-cache') {
      const fullPath = path.join(root, entry);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`  ${GREEN}✓ Removed:${RESET} ${entry}`);
        cleanedCount++;
      } catch (err) {
        console.log(`  ${RED}✗ Failed to remove ${entry}:${RESET} ${err}`);
      }
    }
  }

  if (cleanedCount === 0) {
    console.log(`  ${DIM}No temporary cache directories found to clean.${RESET}`);
  } else {
    console.log(`\n  ${GREEN}✓ Cleaned ${cleanedCount} temporary cache director(ies).${RESET}`);
  }
}

// ─── Help / Dispatcher ──────────────────────────────────────────────────────

function printHelp(): void {
  banner('LANKA OFFERS — ADMIN CLI USAGE');

  console.log(`${BOLD}SYNOPSIS:${RESET}`);
  console.log(`  npm run admin <command> [options]\n`);

  console.log(`${BOLD}AVAILABLE COMMANDS:${RESET}`);
  console.log(`  ${CYAN}status${RESET}                 Show health, database metrics, and scraper operations`);
  console.log(`  ${CYAN}budget${RESET}                 Inspect API consumption, monthly quotas, and CostGuard state`);
  console.log(`  ${CYAN}scrape [bank]${RESET}          Run scraper for a bank or all banks (e.g. hnb, boc, sampath, all)`);
  console.log(`                         Options: --cache, --skip-details, --no-validate, --llm`);
  console.log(`  ${CYAN}sync${RESET}                   View approved staging offers (--publish to go live)`);
  console.log(`  ${CYAN}geocode [bank]${RESET}         Execute geocoding and location scope classification`);
  console.log(`  ${CYAN}duplicates${RESET}             View duplicate candidate pairs and similarity clusters`);
  console.log(`  ${CYAN}rules [bank]${RESET}           List dynamic rules from bank_parser_rules database`);
  console.log(`  ${CYAN}clean${RESET}                  Clear local scraper caches and temporary files`);
  console.log(`  ${CYAN}help${RESET}                   Display this manual\n`);

  console.log(`${BOLD}EXAMPLES:${RESET}`);
  console.log(`  npm run admin status`);
  console.log(`  npm run admin budget`);
  console.log(`  npm run admin scrape hnb -- --cache`);
  console.log(`  npm run admin sync -- --publish`);
  console.log(`  npm run admin geocode sampath`);
  console.log(`  npm run admin rules hnb\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase() || 'help';

  try {
    switch (command) {
      case 'status':
      case 'health':
        await handleStatus();
        break;

      case 'budget':
      case 'costs':
      case 'cost':
      case 'quota':
        await handleBudget();
        break;

      case 'sync': {
        const publish = args.includes('--publish');
        await handleSync(publish);
        break;
      }

      case 'duplicates':
      case 'dups':
        await handleDuplicates();
        break;

      case 'rules':
      case 'rule': {
        const bank = args[1]?.toLowerCase();
        await handleRules(bank);
        break;
      }

      case 'clean':
        handleClean();
        break;

      case 'scrape': {
        const bank = args[1]?.toLowerCase() || 'hnb';
        console.log(`\n${CYAN}Forwarding to Scrape CLI for bank: ${bank}...${RESET}`);
        // Delegate to scrape.ts
        const scrapeArgs = process.argv.slice(3).filter((a) => a !== bank);
        if (!scrapeArgs.some((a) => a.startsWith('--bank='))) {
          scrapeArgs.unshift(`--bank=${bank}`);
        }
        process.argv = [process.argv[0], path.join(__dirname, 'scrape.ts'), ...scrapeArgs];
        require('./scrape');
        return;
      }

      case 'geocode':
      case 'geo': {
        const bank = args[1]?.toLowerCase() || 'hnb';
        console.log(`\n${CYAN}Forwarding to Geocode CLI for bank: ${bank}...${RESET}`);
        const geoArgs = process.argv.slice(3).filter((a) => a !== bank);
        if (!geoArgs.some((a) => a.startsWith('--bank='))) {
          geoArgs.unshift(`--bank=${bank}`);
        }
        process.argv = [process.argv[0], path.join(__dirname, 'geocode.ts'), ...geoArgs];
        require('./geocode');
        return;
      }

      case 'reconcile-expired':
      case 'expire': {
        banner('EXPIRING STALE PUBLISHED OFFERS');
        const { reconcileExpiredOffers } = require('@/infrastructure/db/offer-workflow-repository');
        const result = await reconcileExpiredOffers();
        console.log(`  ${GREEN}✓ Successfully transitioned ${result.expiredCount} expired offer(s) to EXPIRED${RESET}\n`);
        break;
      }

      case 'help':
      case '--help':
      case '-h':
      default:
        printHelp();
        break;
    }
  } finally {
    if (command !== 'scrape' && command !== 'geocode') {
      await closePool().catch(() => null);
    }
  }
}

main().catch((err) => {
  console.error(`\n  ${RED}❌ Fatal CLI Error:${RESET}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
