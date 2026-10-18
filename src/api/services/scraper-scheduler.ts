/**
 * Lanka Offers — Controlled Scraper Scheduler & Orchestration Engine
 *
 * Requirements satisfied:
 * - Disabled by default (ENABLE_SCRAPER_SCHEDULER=false) to protect production stability.
 * - Bank-specific schedules for all 10 banks with staggered timing.
 * - Timeouts tailored to source complexity (headless browser vs HTML/API).
 * - No overlapping same-bank runs and global concurrency guards via JobManager.
 * - Bounded backoff retry policy on failure.
 * - Audit logging of operator toggles and manual run triggers.
 * - Graceful shutdown and timer cleanup.
 */

import { jobManager } from './job-manager';
import { getBankConfig } from '@/config/banks';
import { pool } from '@/infrastructure/db/db-client';

export interface ScheduleEntry {
  id: string;
  name: string;
  bank: string;
  cron: string;
  description: string;
  enabled: boolean;
  timeoutMs: number;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: 'idle' | 'running' | 'success' | 'failed';
  retryCount: number;
  maxRetries: number;
  backoffMinutes: number;
  concurrency?: number;
}

export interface SchedulerSecurityGates {
  schedulerEnabled: boolean;
  scrapingEnabled: boolean;
  stagingEnabled: boolean;
  autoApprovalEnabled: boolean;
  autoPublishingEnabled: boolean;
}

export interface SchedulerStatus {
  enabled: boolean;
  activeScrapes: number;
  totalSchedules: number;
  activeSchedules: number;
  schedules: ScheduleEntry[];
  securityGates?: SchedulerSecurityGates;
}

/**
 * B3: Evaluates date & time in Sri Lanka (Asia/Colombo, UTC+05:30) timezone
 * regardless of host OS or VM timezone (e.g. UTC Oracle Cloud VM).
 */
export function getColomboTime(date: Date = new Date()): { hour: number; minute: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  return { hour, minute, dayOfWeek: date.getDay() };
}

export const DEFAULT_BANK_SCHEDULES: ScheduleEntry[] = [
  {
    id: 'SCH-HNB',
    name: 'HNB Ingestion Run',
    bank: 'hnb',
    cron: '0 6 * * *',
    description: 'Daily JSON-API scrape at 06:00',
    enabled: false,
    timeoutMs: 10 * 60 * 1000, // 10 min
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 3,
  },
  {
    id: 'SCH-BOC',
    name: 'BOC Ingestion Run',
    bank: 'boc',
    cron: '30 6 * * *',
    description: 'Daily HTML scrape at 06:30',
    enabled: false,
    timeoutMs: 12 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 2,
  },
  {
    id: 'SCH-SAMPATH',
    name: 'Sampath Ingestion Run',
    bank: 'sampath',
    cron: '0 7 * * *',
    description: 'Daily headless-browser Nuxt scrape at 07:00',
    enabled: false,
    timeoutMs: 25 * 60 * 1000, // 25 min for browser automation
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 10,
    concurrency: 2,
  },
  {
    id: 'SCH-SEYLAN',
    name: 'Seylan Ingestion Run',
    bank: 'seylan',
    cron: '30 7 * * *',
    description: 'Daily HTML scrape with detail parallelization at 07:30',
    enabled: false,
    timeoutMs: 15 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 3,
  },
  {
    id: 'SCH-PEOPLES',
    name: "People's Bank Ingestion Run",
    bank: 'peoples',
    cron: '0 8 * * *',
    description: 'Daily mixed HTML/PDF scrape at 08:00',
    enabled: false,
    timeoutMs: 15 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 2,
  },
  {
    id: 'SCH-NDB',
    name: 'NDB Ingestion Run',
    bank: 'ndb',
    cron: '30 8 * * *',
    description: 'Daily headless-browser Next.js scrape at 08:30',
    enabled: false,
    timeoutMs: 25 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 10,
    concurrency: 2,
  },
  {
    id: 'SCH-DFCC',
    name: 'DFCC Ingestion Run',
    bank: 'dfcc',
    cron: '0 9 * * *',
    description: 'Daily headless-browser scrape at 09:00',
    enabled: false,
    timeoutMs: 25 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 10,
    concurrency: 2,
  },
  {
    id: 'SCH-PABC',
    name: 'Pan Asia (PABC) Ingestion Run',
    bank: 'pabc',
    cron: '30 9 * * *',
    description: 'Daily headless-browser scrape at 09:30',
    enabled: false,
    timeoutMs: 20 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 10,
    concurrency: 2,
  },
  {
    id: 'SCH-NSB',
    name: 'NSB Ingestion Run',
    bank: 'nsb',
    cron: '0 10 * * *',
    description: 'Daily WordPress HTML prose scrape at 10:00',
    enabled: false,
    timeoutMs: 12 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 2,
  },
  {
    id: 'SCH-COMBANK',
    name: 'Commercial Bank Ingestion Run',
    bank: 'combank',
    cron: '30 10 * * *',
    description: 'Daily HTML multi-category scrape at 10:30',
    enabled: false,
    timeoutMs: 15 * 60 * 1000,
    lastRun: null,
    nextRun: null,
    lastStatus: 'idle',
    retryCount: 0,
    maxRetries: 2,
    backoffMinutes: 5,
    concurrency: 3,
  },
];

export class ScraperScheduler {
  private globalEnabled: boolean;
  private schedules: Map<string, ScheduleEntry> = new Map();
  private checkIntervalTimer: NodeJS.Timeout | null = null;
  private retryTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.globalEnabled = process.env.ENABLE_SCRAPER_SCHEDULER === 'true';
    for (const item of DEFAULT_BANK_SCHEDULES) {
      this.schedules.set(item.id, { ...item });
    }
  }

  public async init(): Promise<void> {
    try {
      // Load approved configuration from database if available
      const rows = await pool.query<{
        id: string;
        bank: string;
        enabled: boolean;
        cron_expr: string;
        timeout_ms: number;
        max_retries: number;
        last_status: string;
        retry_count: number;
        last_run_at: Date | null;
      }>('SELECT * FROM scheduler_config');

      if (rows && rows.rows && rows.rows.length > 0) {
        for (const row of rows.rows) {
          if (row.id === 'GLOBAL') {
            // Guard: Global execution authorization requires explicit approval
            if (process.env.ENABLE_SCRAPER_SCHEDULER === 'true' && row.enabled) {
              this.globalEnabled = true;
            }
          } else {
            const entry = this.schedules.get(row.id);
            if (entry) {
              entry.enabled = row.enabled;
              entry.lastStatus = (row.last_status as any) || entry.lastStatus;
              entry.retryCount = row.retry_count ?? entry.retryCount;
              if (row.last_run_at) entry.lastRun = new Date(row.last_run_at).toISOString();
              entry.nextRun = row.enabled ? 'Scheduled per cron' : 'Disabled';
            }
          }
        }
      }
    } catch {
      // Seamless in-memory fallback during unit tests / offline DB
    }

    // B1: Register completion listener on jobManager for verified lifecycle updates
    jobManager.onJobCompleted = async (bank, jobId, exitCode, success, errorMessage) => {
      const entry = Array.from(this.schedules.values()).find((s) => s.bank === bank.toLowerCase());
      if (entry) {
        if (success) {
          this.handleJobSuccess(entry.id);
        } else {
          this.handleJobFailure(entry.id, errorMessage || `Process exited with code ${exitCode}`);
        }
      }
    };

    if (this.globalEnabled) {
      console.log('[ScraperScheduler] Scheduler initialized in ACTIVE mode (ENABLE_SCRAPER_SCHEDULER=true)');
      this.startCheckLoop();
    } else {
      console.log('[ScraperScheduler] Scheduler initialized in DISABLED/PAUSED mode by default (ENABLE_SCRAPER_SCHEDULER=false)');
    }
  }

  public getSecurityGates(): SchedulerSecurityGates {
    return {
      schedulerEnabled: this.globalEnabled,
      scrapingEnabled: process.env.ENABLE_SCRAPER_SCHEDULER === 'true' || this.globalEnabled,
      stagingEnabled: true,
      autoApprovalEnabled: process.env.ENABLE_AUTO_APPROVAL === 'true',
      autoPublishingEnabled: process.env.ENABLE_AUTO_PUBLISHING === 'true',
    };
  }

  public getStatus(): SchedulerStatus {
    const list = Array.from(this.schedules.values());
    return {
      enabled: this.globalEnabled,
      activeScrapes: jobManager.getActiveJobs().length,
      totalSchedules: list.length,
      activeSchedules: list.filter((s) => s.enabled).length,
      schedules: list,
      securityGates: this.getSecurityGates(),
    };
  }

  public toggleGlobal(enabled: boolean, operator = 'operator'): { enabled: boolean; message: string } {
    this.globalEnabled = enabled;

    // Persist to durable database configuration
    pool.query(
      `INSERT INTO scheduler_config (id, enabled, updated_at, updated_by)
       VALUES ('GLOBAL', $1, NOW(), $2)
       ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [enabled, operator]
    ).catch(() => {});

    if (enabled && !this.checkIntervalTimer) {
      this.startCheckLoop();
      console.log(`[ScraperScheduler] Scheduler enabled globally by ${operator}`);
      return { enabled: true, message: `Scheduler globally enabled by ${operator}` };
    } else if (!enabled && this.checkIntervalTimer) {
      this.stopCheckLoop();
      console.log(`[ScraperScheduler] Scheduler disabled globally by ${operator}`);
      return { enabled: false, message: `Scheduler globally disabled by ${operator}` };
    }
    return { enabled: this.globalEnabled, message: `Scheduler state unchanged (${this.globalEnabled ? 'enabled' : 'disabled'})` };
  }

  public toggleSchedule(id: string, enabled: boolean, operator = 'operator'): ScheduleEntry {
    const entry = this.schedules.get(id);
    if (!entry) {
      throw new Error(`Schedule not found: ${id}`);
    }
    entry.enabled = enabled;
    entry.nextRun = enabled ? 'Scheduled per cron' : 'Disabled';
    console.log(`[ScraperScheduler] Schedule ${id} (${entry.bank}) toggled to ${enabled ? 'ENABLED' : 'DISABLED'} by ${operator}`);

    // Persist to durable database configuration
    pool.query(
      `INSERT INTO scheduler_config (id, bank, enabled, cron_expr, timeout_ms, max_retries, concurrency, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       ON CONFLICT (id) DO UPDATE 
         SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [id, entry.bank, enabled, entry.cron, entry.timeoutMs, entry.maxRetries, entry.concurrency ?? 2, operator]
    ).catch(() => {});

    return { ...entry };
  }

  public async triggerRunNow(id: string, operator = 'operator'): Promise<{ jobId: string; pid: number; bank: string; startedAt: string }> {
    const entry = this.schedules.get(id);
    if (!entry) {
      throw new Error(`Schedule not found: ${id}`);
    }

    if (jobManager.isBankRunning(entry.bank)) {
      throw new Error(`Bank ${entry.bank.toUpperCase()} is already running a scraper job`);
    }

    // Check distributed database lock across all active API instances
    if (typeof jobManager.isBankLockedInDatabase === 'function') {
      const isLockedDistributed = await jobManager.isBankLockedInDatabase(entry.bank);
      if (isLockedDistributed) {
        throw new Error(`Bank ${entry.bank.toUpperCase()} is currently running on another worker/instance (distributed lock active)`);
      }
    }

    console.log(`[ScraperScheduler] Manual Run Now triggered for ${entry.bank} by ${operator}`);
    entry.lastRun = new Date().toISOString();
    entry.lastStatus = 'running';

    try {
      const job = jobManager.startScrapeJob(entry.bank, {
        cache: true,
        concurrency: entry.concurrency,
        timeoutMs: entry.timeoutMs,
      });

      // Update durable state in scheduler_config
      pool.query(
        `UPDATE scheduler_config 
         SET last_run_at = NOW(), last_status = 'running', retry_count = 0 
         WHERE id = $1`,
        [id]
      ).catch(() => {});

      return job;
    } catch (err) {
      entry.lastStatus = 'failed';
      throw err;
    }
  }

  /**
   * B4: Exponential backoff with jitter retry handler
   */
  public handleJobFailure(id: string, errorMessage?: string): void {
    const entry = this.schedules.get(id);
    if (!entry) return;

    entry.retryCount++;
    entry.lastStatus = 'failed';

    if (entry.retryCount <= entry.maxRetries) {
      const baseMinutes = entry.backoffMinutes || 5;
      // Exponential backoff with jitter: delay = base * 2^(retry-1) min + 0-30s jitter
      const delayMs = Math.min(baseMinutes * Math.pow(2, entry.retryCount - 1), 60) * 60 * 1000 + Math.floor(Math.random() * 30000);
      const retryDate = new Date(Date.now() + delayMs);
      entry.nextRun = `Retry ${entry.retryCount}/${entry.maxRetries} scheduled at ${retryDate.toISOString()}`;
      console.warn(
        `[ScraperScheduler] Bank ${entry.bank.toUpperCase()} scrape failed (${errorMessage || 'unknown error'}). Scheduled retry ${entry.retryCount}/${entry.maxRetries} in ${Math.round(delayMs / 60000)}m (with jitter).`
      );

      if (this.retryTimers.has(id)) {
        clearTimeout(this.retryTimers.get(id)!);
      }

      const timer = setTimeout(() => {
        this.retryTimers.delete(id);
        if (!jobManager.isBankRunning(entry.bank)) {
          console.log(`[ScraperScheduler] Executing scheduled retry ${entry.retryCount} for ${entry.bank}...`);
          try {
            jobManager.startScrapeJob(entry.bank, {
              cache: true,
              concurrency: entry.concurrency,
              timeoutMs: entry.timeoutMs,
            }, entry.retryCount);
          } catch (err) {
            console.error(`[ScraperScheduler] Retry execution error for ${entry.bank}:`, err);
          }
        }
      }, delayMs);

      timer.unref();
      this.retryTimers.set(id, timer);
    } else {
      entry.nextRun = `Maximum retries (${entry.maxRetries}) exhausted. Next run per cron.`;
      console.error(
        `[ScraperScheduler] Bank ${entry.bank.toUpperCase()} exceeded max retries (${entry.maxRetries}). Halting until next scheduled window.`
      );
    }

    pool.query(
      `UPDATE scheduler_config 
       SET last_status = 'failed', retry_count = $2 
       WHERE id = $1`,
      [id, entry.retryCount]
    ).catch(() => {});
  }

  /**
   * B4: Handle job success
   */
  public handleJobSuccess(id: string): void {
    const entry = this.schedules.get(id);
    if (!entry) return;
    entry.retryCount = 0;
    entry.lastStatus = 'success';
    entry.nextRun = entry.enabled ? 'Scheduled per cron' : 'Disabled';

    pool.query(
      `UPDATE scheduler_config 
       SET last_status = 'success', retry_count = 0 
       WHERE id = $1`,
      [id]
    ).catch(() => {});
  }

  private startCheckLoop(): void {
    if (this.checkIntervalTimer) return;
    // Check every 60 seconds
    this.checkIntervalTimer = setInterval(() => {
      this.tick();
    }, 60 * 1000);
  }

  private stopCheckLoop(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.globalEnabled) return;

    // B3: Strictly evaluate schedule in Sri Lanka (Asia/Colombo) time
    const now = new Date();
    const { hour: currentHour, minute: currentMinute } = getColomboTime(now);

    for (const entry of this.schedules.values()) {
      if (!entry.enabled) continue;

      // Simple cron parser for standard 'M H * * *' format
      const parts = entry.cron.split(' ');
      if (parts.length === 5) {
        const cronMinute = parseInt(parts[0], 10);
        const cronHour = parseInt(parts[1], 10);

        if (cronHour === currentHour && cronMinute === currentMinute) {
          // Time to execute!
          if (!jobManager.isBankRunning(entry.bank)) {
            const isLocked = await jobManager.isBankLockedInDatabase(entry.bank).catch(() => false);
            if (isLocked) {
              console.warn(`[ScraperScheduler] Skipping scheduled run for ${entry.bank}: active distributed lease held by another worker`);
              continue;
            }

            console.log(`[ScraperScheduler] Cron triggered for ${entry.bank} at ${now.toISOString()} (Colombo: ${currentHour}:${currentMinute.toString().padStart(2, '0')})`);
            entry.lastRun = now.toISOString();
            entry.lastStatus = 'running';
            try {
              jobManager.startScrapeJob(entry.bank, {
                cache: true,
                concurrency: entry.concurrency,
                timeoutMs: entry.timeoutMs,
              });
            } catch (err) {
              console.error(`[ScraperScheduler] Failed to trigger scheduled run for ${entry.bank}:`, err);
              entry.lastStatus = 'failed';
            }
          }
        }
      }
    }
  }

  public shutdown(): void {
    this.stopCheckLoop();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    console.log('[ScraperScheduler] Scheduler shutdown completed');
  }
}

export const scraperScheduler = new ScraperScheduler();
