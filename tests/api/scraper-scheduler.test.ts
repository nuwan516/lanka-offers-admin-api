import { ScraperScheduler, DEFAULT_BANK_SCHEDULES } from '@/api/services/scraper-scheduler';
import { jobManager } from '@/api/services/job-manager';

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  },
}));

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

  it('correctly calculates Sri Lanka (Asia/Colombo) time for cron triggers (B3)', () => {
    const { getColomboTime } = require('@/api/services/scraper-scheduler');

    // 00:30 UTC is 06:00 AM Colombo (UTC+05:30)
    const utcMorning = new Date('2026-10-18T00:30:00.000Z');
    const colomboMorning = getColomboTime(utcMorning);
    expect(colomboMorning.hour).toBe(6);
    expect(colomboMorning.minute).toBe(0);

    // 18:30 UTC is 00:00 midnight next day Colombo
    const utcNight = new Date('2026-10-18T18:30:00.000Z');
    const colomboMidnight = getColomboTime(utcNight);
    expect(colomboMidnight.hour).toBe(0);
    expect(colomboMidnight.minute).toBe(0);
  });

  it('maintains strict security gates separating scheduling from auto-publishing (B4)', () => {
    const gates = scheduler.getSecurityGates();
    expect(gates.autoPublishingEnabled).toBe(false);
    expect(gates.autoApprovalEnabled).toBe(false);
    expect(gates.stagingEnabled).toBe(true);

    const status = scheduler.getStatus();
    expect(status.securityGates).toBeDefined();
    expect(status.securityGates?.autoPublishingEnabled).toBe(false);
  });

  it('updates schedule state when jobManager notifies onJobCompleted (B1)', async () => {
    await scheduler.init();
    expect(jobManager.onJobCompleted).toBeDefined();

    // Simulate scraper failure reported by job manager
    await jobManager.onJobCompleted!('hnb', 'job-test-123', 1, false, 'Connection terminated');

    const entryFailed = scheduler.getStatus().schedules.find((s) => s.bank === 'hnb')!;
    expect(entryFailed.retryCount).toBe(1);
    expect(entryFailed.lastStatus).toBe('failed');

    // Simulate scraper success reported by job manager
    await jobManager.onJobCompleted!('hnb', 'job-test-124', 0, true);

    const entrySuccess = scheduler.getStatus().schedules.find((s) => s.bank === 'hnb')!;
    expect(entrySuccess.retryCount).toBe(0);
    expect(entrySuccess.lastStatus).toBe('success');
  });
});

