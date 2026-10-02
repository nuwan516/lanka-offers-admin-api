import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { pool } from '@/infrastructure/db/db-client';
import { randomUUID } from 'crypto';

export interface ScrapeExecutionOptions {
  cache?: boolean;
  llm?: boolean;
  noValidate?: boolean;
  skipDetails?: boolean;
  concurrency?: number;
  maxCategories?: number;
}

export interface ActiveJob {
  jobId: string;
  bank: string;
  pid: number;
  child: ChildProcess;
  startedAt: string;
  options?: ScrapeExecutionOptions;
  retryCount?: number;
}

export const VALID_BANKS = [
  'hnb', 'boc', 'sampath', 'ndb', 'dfcc',
  'seylan', 'peoples', 'pabc', 'nsb', 'combank', 'all',
];

const MAX_PARALLEL_SCRAPES = 3;

export class JobManager {
  private activeJobs = new Map<string, ActiveJob>();
  private activeGeoJobs = new Map<string, { pid: number; bank: string; startedAt: string; child: ChildProcess }>();
  private projectRoot = path.resolve(__dirname, '..', '..', '..');

  public isValidBank(bank: string): boolean {
    return VALID_BANKS.includes(bank.toLowerCase());
  }

  public getActiveJobs(): Array<{ jobId: string; pid: number; bank: string; startedAt: string }> {
    return Array.from(this.activeJobs.values()).map(j => ({
      jobId: j.jobId,
      pid: j.pid,
      bank: j.bank,
      startedAt: j.startedAt,
    }));
  }

  public getActiveGeoJobs(): Array<{ pid: number; bank: string; startedAt: string }> {
    return Array.from(this.activeGeoJobs.values()).map(j => ({
      pid: j.pid,
      bank: j.bank,
      startedAt: j.startedAt,
    }));
  }

  public isBankRunning(bank: string): boolean {
    const b = bank.toLowerCase();
    if (this.activeJobs.has(b)) return true;
    if (b === 'all' && this.activeJobs.size > 0) return true;
    if (this.activeJobs.has('all')) return true;
    return false;
  }

  /**
   * Starts a scraper child process with sanitized arguments and concurrency checks.
   */
  public startScrapeJob(
    bank: string,
    options: ScrapeExecutionOptions = {},
    retryCount = 0
  ): { jobId: string; pid: number; bank: string; startedAt: string } {
    const b = bank.toLowerCase();

    if (!this.isValidBank(b)) {
      throw new Error(`Invalid bank identifier: "${bank}"`);
    }

    if (this.activeJobs.has(b)) {
      throw new Error(`A scrape job for ${b.toUpperCase()} is already running (PID: ${this.activeJobs.get(b)?.pid})`);
    }

    if (b === 'all' && this.activeJobs.size > 0) {
      throw new Error(`Cannot run 'all' while individual bank scrapers are active`);
    }

    if (this.activeJobs.has('all')) {
      throw new Error(`Cannot start ${b.toUpperCase()} while an 'all' scrape is already running`);
    }

    if (this.activeJobs.size >= MAX_PARALLEL_SCRAPES) {
      throw new Error(`Maximum concurrent scraper limit reached (${MAX_PARALLEL_SCRAPES} active)`);
    }

    const args = ['run', 'scrape', '--', `--bank=${b}`];

    if (options.cache) args.push('--cache');
    if (options.llm) args.push('--llm');
    if (options.noValidate) args.push('--no-validate');
    if (options.skipDetails) args.push('--skip-details');

    if (typeof options.concurrency === 'number' && options.concurrency >= 1 && options.concurrency <= 10) {
      args.push(`--concurrency=${Math.floor(options.concurrency)}`);
    }
    if (typeof options.maxCategories === 'number' && options.maxCategories >= 1 && options.maxCategories <= 50) {
      args.push(`--max-categories=${Math.floor(options.maxCategories)}`);
    }

    const child = spawn('npm', args, {
      cwd: this.projectRoot,
      env: { ...process.env },
      stdio: 'ignore',
      shell: true,
      detached: true,
    });

    if (!child.pid) {
      throw new Error('Failed to spawn scraper process. Ensure npm and node are accessible in system PATH.');
    }

    const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const job: ActiveJob = {
      jobId,
      bank: b,
      pid: child.pid,
      child,
      startedAt: new Date().toISOString(),
      options,
      retryCount,
    };

    this.activeJobs.set(b, job);

    child.on('close', (code) => {
      this.activeJobs.delete(b);
      console.log(`[JobManager] Scraper for ${b} exited with code ${code}`);
    });

    child.unref();

    return {
      jobId: job.jobId,
      pid: job.pid,
      bank: job.bank,
      startedAt: job.startedAt,
    };
  }

  /**
   * Safely terminates a running scrape process tree.
   */
  public async cancelScrapeJob(bank: string, actor = 'operator'): Promise<{ cancelled: boolean; bank: string; pid?: number }> {
    const b = bank.toLowerCase();
    const job = this.activeJobs.get(b);

    if (!job) {
      return { cancelled: false, bank: b };
    }

    const pid = job.pid;

    try {
      if (process.platform === 'win32') {
        // Kill whole process tree on Windows
        spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          job.child.kill('SIGTERM');
        }
      }
    } catch (e) {
      console.error(`[JobManager] Error terminating PID ${pid}:`, e);
    }

    this.activeJobs.delete(b);

    // Update database scrape_runs for this bank to mark cancelled
    try {
      await pool.query(
        `UPDATE scrape_runs
         SET status = 'failed', error_message = $2, finished_at = NOW()
         WHERE id IN (
           SELECT id FROM scrape_runs
           WHERE bank = $1 AND status = 'running'
           ORDER BY started_at DESC
           LIMIT 1
         )`,
        [b, `Cancelled by ${actor}`]
      );
    } catch (dbErr) {
      console.error(`[JobManager] Failed to update scrape_runs on cancel:`, dbErr);
    }

    console.log(`[JobManager] Cancelled scraper for ${b} (PID: ${pid}) by ${actor}`);
    return { cancelled: true, bank: b, pid };
  }

  /**
   * Retries a scrape job with traceable options.
   */
  public async retryScrapeJob(
    bank: string,
    options?: ScrapeExecutionOptions,
    actor = 'operator'
  ): Promise<{ jobId: string; pid: number; bank: string; startedAt: string }> {
    const b = bank.toLowerCase();
    if (this.activeJobs.has(b)) {
      throw new Error(`Cannot retry: a job for ${b.toUpperCase()} is currently running`);
    }

    console.log(`[JobManager] Retrying scrape for ${b} triggered by ${actor}`);
    return this.startScrapeJob(b, options, 1);
  }

  /**
   * Geocode process launcher
   */
  public startGeocodeJob(bank: string): { pid: number; bank: string; startedAt: string } {
    const b = bank.toLowerCase();
    const geoBank = b === 'all' ? 'all' : VALID_BANKS.slice(0, -1).includes(b) ? b : null;
    if (!geoBank) throw new Error(`Unknown bank for geocode: "${bank}"`);

    if (this.activeGeoJobs.has(b)) {
      throw new Error(`Geocode job for ${b} is already running`);
    }

    const scriptName = `geo:${geoBank}`;
    const child = spawn('npm', ['run', scriptName, '--', '--stats'], {
      cwd: this.projectRoot,
      env: { ...process.env },
      stdio: 'ignore',
      shell: true,
      detached: true,
    });

    if (!child.pid) {
      throw new Error('Failed to spawn geocoder process');
    }

    const job = { pid: child.pid, bank: b, startedAt: new Date().toISOString(), child };
    this.activeGeoJobs.set(b, job);

    child.on('close', (code) => {
      this.activeGeoJobs.delete(b);
      console.log(`[JobManager] Geocoder for ${b} exited with code ${code}`);
    });

    child.unref();
    return { pid: job.pid, bank: job.bank, startedAt: job.startedAt };
  }

  /**
   * Detects orphaned scrape runs from previous crashes/restarts and marks them stale/failed.
   */
  public async recoverStaleRunsOnStartup(): Promise<number> {
    try {
      const res = await pool.query(
        `UPDATE scrape_runs
         SET status = 'failed',
             error_message = 'Scraper terminated unexpectedly (server restarted)',
             finished_at = NOW()
         WHERE status = 'running'
         RETURNING id, bank`
      );
      if (res.rowCount && res.rowCount > 0) {
        console.log(`[JobManager] Recovered ${res.rowCount} stale running scrape run(s) on startup.`);
      }
      return res.rowCount ?? 0;
    } catch (e) {
      console.error('[JobManager] Failed to recover stale scrape runs:', e);
      return 0;
    }
  }

  /**
   * Graceful shutdown handler
   */
  public async shutdown(): Promise<void> {
    console.log('[JobManager] Graceful shutdown: terminating active scraper child processes...');
    for (const [bank, job] of this.activeJobs.entries()) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(job.pid), '/T', '/F']);
        } else {
          job.child.kill('SIGTERM');
        }
      } catch (err) {
        console.error(`[JobManager] Error terminating active job ${bank}:`, err);
      }
    }
    this.activeJobs.clear();
    this.activeGeoJobs.clear();
  }
}

export const jobManager = new JobManager();
