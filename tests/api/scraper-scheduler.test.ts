import { ScraperScheduler, DEFAULT_BANK_SCHEDULES } from '@/api/services/scraper-scheduler';
import { jobManager } from '@/api/services/job-manager';

jest.mock('@/api/services/job-manager', () => ({
  jobManager: {
    getActiveJobs: jest.fn().mockReturnValue([]),
    isBankRunning: jest.fn().mockReturnValue(false),
    isBankLockedInDatabase: jest.fn().mockResolvedValue(false),
    startScrapeJob: jest.fn().mockReturnValue({
      jobId: 'job-test-1',
      pid: 12345,
      bank: 'hnb',
      startedAt: new Date().toISOString(),
    }),
  },
}));

describe('ScraperScheduler — Safe Orchestration & Scheduling', () => {
  let scheduler: ScraperScheduler;

  beforeEach(() => {
    delete process.env.ENABLE_SCRAPER_SCHEDULER;
    scheduler = new ScraperScheduler();
    jest.clearAllMocks();
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  it('initializes in DISABLED/PAUSED mode by default to protect production', () => {
    const status = scheduler.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.activeSchedules).toBe(0);
  });

  it('contains schedule entries for all 10 supported banks', () => {
    const status = scheduler.getStatus();
    const scheduledBanks = status.schedules.map((s) => s.bank);
    const requiredBanks = ['hnb', 'boc', 'sampath', 'ndb', 'dfcc', 'seylan', 'peoples', 'pabc', 'nsb', 'combank'];

    expect(status.totalSchedules).toBe(10);
    for (const bank of requiredBanks) {
      expect(scheduledBanks).toContain(bank);
    }
  });

  it('assigns higher timeouts to headless browser scrapers than HTML/API scrapers', () => {
    const status = scheduler.getStatus();
    const sampath = status.schedules.find((s) => s.bank === 'sampath')!;
    const dfcc = status.schedules.find((s) => s.bank === 'dfcc')!;
    const hnb = status.schedules.find((s) => s.bank === 'hnb')!;

    // Browser scrapers need >= 20 mins
    expect(sampath.timeoutMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
    expect(dfcc.timeoutMs).toBeGreaterThanOrEqual(20 * 60 * 1000);

    // API / Cheerio scrapers need <= 15 mins
    expect(hnb.timeoutMs).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('allows toggling global scheduler state with operator audit', () => {
    const res1 = scheduler.toggleGlobal(true, 'lead-architect');
    expect(res1.enabled).toBe(true);
    expect(res1.message).toContain('lead-architect');
    expect(scheduler.getStatus().enabled).toBe(true);

    const res2 = scheduler.toggleGlobal(false, 'reliability-eng');
    expect(res2.enabled).toBe(false);
    expect(res2.message).toContain('reliability-eng');
    expect(scheduler.getStatus().enabled).toBe(false);
  });

  it('allows toggling individual schedule entries', () => {
    const hnb = scheduler.toggleSchedule('SCH-HNB', true, 'operator-1');
    expect(hnb.enabled).toBe(true);
    expect(hnb.nextRun).toBe('Scheduled per cron');

    const status = scheduler.getStatus();
    expect(status.activeSchedules).toBe(1);

    const hnbDisabled = scheduler.toggleSchedule('SCH-HNB', false, 'operator-1');
    expect(hnbDisabled.enabled).toBe(false);
    expect(hnbDisabled.nextRun).toBe('Disabled');
  });

  it('triggers manual Run Now through JobManager when bank is idle', async () => {
    (jobManager.isBankRunning as jest.Mock).mockReturnValue(false);

    const result = await scheduler.triggerRunNow('SCH-HNB', 'admin-user');

    expect(result.jobId).toBe('job-test-1');
    expect(jobManager.startScrapeJob).toHaveBeenCalledWith('hnb', expect.objectContaining({
      cache: true,
      concurrency: 3,
      timeoutMs: 10 * 60 * 1000,
    }));
  });

  it('prevents overlapping runs if the bank scraper is already active', async () => {
    (jobManager.isBankRunning as jest.Mock).mockReturnValue(true);

    await expect(scheduler.triggerRunNow('SCH-HNB', 'admin-user')).rejects.toThrow(
      'Bank HNB is already running a scraper job'
    );
    expect(jobManager.startScrapeJob).not.toHaveBeenCalled();
  });

  it('prevents execution if another instance holds the distributed database lease (B1)', async () => {
    (jobManager.isBankRunning as jest.Mock).mockReturnValue(false);
    (jobManager.isBankLockedInDatabase as jest.Mock).mockResolvedValue(true);

    await expect(scheduler.triggerRunNow('SCH-HNB', 'admin-user')).rejects.toThrow(
      'distributed lock active'
    );
    expect(jobManager.startScrapeJob).not.toHaveBeenCalled();
  });

  it('schedules bounded retry with backoff on scrape failure (B4)', () => {
    jest.useFakeTimers();

    const entry = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    expect(entry.retryCount).toBe(0);

    scheduler.handleJobFailure('SCH-HNB', 'Simulated network timeout');

    const updated = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    expect(updated.retryCount).toBe(1);
    expect(updated.lastStatus).toBe('failed');
    expect(updated.nextRun).toContain('Retry 1/2 scheduled');

    jest.useRealTimers();
  });

  it('stops retrying and trips safety limit when max retries exceeded (B4)', () => {
    const entry = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    entry.retryCount = entry.maxRetries; // 2

    scheduler.handleJobFailure('SCH-HNB', 'Persistent site outage');

    const updated = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    expect(updated.retryCount).toBe(3);
    expect(updated.nextRun).toContain('Maximum retries (2) exhausted');
  });

  it('resets retry counter upon successful run completion (B4)', () => {
    const entry = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    entry.retryCount = 2;
    entry.lastStatus = 'failed';

    scheduler.handleJobSuccess('SCH-HNB');

    const updated = scheduler.getStatus().schedules.find((s) => s.id === 'SCH-HNB')!;
    expect(updated.retryCount).toBe(0);
    expect(updated.lastStatus).toBe('success');
  });
});
