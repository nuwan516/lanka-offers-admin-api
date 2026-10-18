import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { pool } from '@/infrastructure/db/db-client';
import { randomUUID } from 'crypto';

export interface ScrapeExecutionOptions {
  cache?: boolean;
  llm?: boolean;
  noValidate?: boolean;
  skipDetails?: boolean;
  concurrency?: number;
  maxCategories?: number;
  timeoutMs?: number;
}

export interface ActiveJob {
  jobId: string;
  bank: string;
  pid: number;
  child: ChildProcess;
  startedAt: string;
  options?: ScrapeExecutionOptions;
  retryCount?: number;
  timeoutTimer?: NodeJS.Timeout;
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
    const timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : Number(process.env.SCRAPER_JOB_TIMEOUT_MS) || 15 * 60 * 1000; // configurable via SCRAPER_JOB_TIMEOUT_MS with 15m default

    const timeoutTimer = setTimeout(() => {
      console.warn(
        `[JobManager] Scraper for ${b} exceeded maximum timeout (${Math.round(timeoutMs / 1000)}s). Terminating...`
      );
      this.cancelScrapeJob(b, 'timeout-watchdog').catch((err) =>
        console.error(`[JobManager] Error in timeout watchdog cancel for ${b}:`, err)
      );
    }, timeoutMs);

    const job: ActiveJob = {
      jobId,
      bank: b,
      pid: child.pid,
      child,
      startedAt: new Date().toISOString(),
      options,
      retryCount,
      timeoutTimer,
    };

    this.activeJobs.set(b, job);

    // Acquire database-backed distributed execution lease
    this.acquireDistributedLease(b, jobId, timeoutMs).catch((err) => {
      console.warn(`[JobManager] Non-fatal distributed lease acquisition warning for ${b}:`, err);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      this.activeJobs.delete(b);
      this.releaseDistributedLease(b, jobId).catch(() => {});
      console.log(`[JobManager] Scraper for ${b} exited with code ${code}`);
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      this.activeJobs.delete(b);
      this.releaseDistributedLease(b, jobId).catch(() => {});
      console.error(`[JobManager] Scraper process error for ${b}:`, err);
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
  public async cancelScrapeJob(
    bank: string,
    actor = 'operator'
  ): Promise<{ cancelled: boolean; bank: string; pid?: number }> {
    const b = bank.toLowerCase();

    // If 'all' is cancelled and multiple individual scrapers are active, cancel all of them
    if (b === 'all' && this.activeJobs.size > 0 && !this.activeJobs.has('all')) {
      console.log(`[JobManager] Cancelling all ${this.activeJobs.size} active scraper jobs triggered by ${actor}...`);
      const activeBanks = Array.from(this.activeJobs.keys());
      for (const activeBank of activeBanks) {
        await this.cancelScrapeJob(activeBank, actor);
      }
      return { cancelled: true, bank: 'all' };
    }

    const job = this.activeJobs.get(b);

    if (!job) {
      // Reconcile database if an orphaned running job exists
      try {
        const updateRes = await pool.query(
          `UPDATE scrape_runs
           SET status = 'failed', error_message = $2, finished_at = NOW()
           WHERE bank = $1 AND status = 'running'`,
          [b, `Cancelled by ${actor} (reconciled orphaned run)`]
        );
        if (updateRes.rowCount && updateRes.rowCount > 0) {
          console.log(`[JobManager] Reconciled ${updateRes.rowCount} orphaned running run(s) for ${b} on cancel request.`);
          return { cancelled: true, bank: b };
        }
      } catch (dbErr) {
        console.error(`[JobManager] Failed to reconcile scrape_runs on cancel:`, dbErr);
      }
      return { cancelled: false, bank: b };
    }

    if (job.timeoutTimer) {
      clearTimeout(job.timeoutTimer);
    }

    const pid = job.pid;

    try {
      if (process.platform === 'win32') {
        // Kill whole process tree on Windows
        const killProc = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
        killProc.on('error', (err) => console.warn(`[JobManager] taskkill error for PID ${pid}:`, err.message));
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
    await this.releaseDistributedLease(b, job.jobId).catch(() => {});

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

    child.on('error', (err) => {
      this.activeGeoJobs.delete(b);
      console.error(`[JobManager] Geocoder process error for ${b}:`, err);
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

      // Reconcile and clean up any expired or dangling scraper leases
      await pool.query(
        `UPDATE scraper_leases
         SET released_at = NOW()
         WHERE released_at IS NULL AND expires_at < NOW()`
      );

      return res.rowCount ?? 0;
    } catch (e) {
      console.error('[JobManager] Failed to recover stale scrape runs:', e);
      return 0;
    }
  }

  /**
   * Durably acquires a database-backed distributed execution lease.
   * Prevents multi-instance collisions across processes/nodes.
   */
  public async acquireDistributedLease(bank: string, jobId: string, timeoutMs: number): Promise<boolean> {
    const b = bank.toLowerCase();
    const instanceId = `${process.env.INSTANCE_ID || os.hostname()}:${process.pid}`;
    try {
      const res = await pool.query(
        `INSERT INTO scraper_leases (bank, job_id, instance_id, acquired_at, expires_at, released_at)
         VALUES ($1, $2, $3, NOW(), NOW() + ($4 || ' milliseconds')::interval, NULL)
         ON CONFLICT (bank) DO UPDATE
           SET job_id = EXCLUDED.job_id,
               instance_id = EXCLUDED.instance_id,
               acquired_at = NOW(),
               expires_at = EXCLUDED.expires_at,
               released_at = NULL
           WHERE scraper_leases.expires_at < NOW() OR scraper_leases.released_at IS NOT NULL
         RETURNING bank, job_id`,
        [b, jobId, instanceId, timeoutMs]
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      // In offline/test environments where table doesn't exist, allow fallback to in-memory lock
      console.warn(`[JobManager] Database lease check failed (falling back to in-memory lock):`, err instanceof Error ? err.message : String(err));
      return true;
    }
  }

  /**
   * Releases the durable database lease when the scraper finishes or fails.
   */
  public async releaseDistributedLease(bank: string, jobId: string): Promise<void> {
    const b = bank.toLowerCase();
    try {
      await pool.query(
        `UPDATE scraper_leases
         SET released_at = NOW()
         WHERE bank = $1 AND job_id = $2 AND released_at IS NULL`,
        [b, jobId]
      );
    } catch (err) {
      console.warn(`[JobManager] Failed to release distributed lease for ${b}:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Queries if a bank is locked by another instance in the database.
   */
  public async isBankLockedInDatabase(bank: string): Promise<boolean> {
    const b = bank.toLowerCase();
    try {
      const res = await pool.query(
        `SELECT job_id, instance_id, expires_at
         FROM scraper_leases
         WHERE bank = $1 AND released_at IS NULL AND expires_at >= NOW()
         LIMIT 1`,
        [b]
      );
      return (res.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Graceful shutdown handler
   */
  public async shutdown(): Promise<void> {
    console.log('[JobManager] Graceful shutdown: terminating active scraper child processes...');
    for (const [bank, job] of this.activeJobs.entries()) {
      try {
        await this.releaseDistributedLease(bank, job.jobId).catch(() => {});
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
