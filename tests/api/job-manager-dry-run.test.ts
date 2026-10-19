import { EventEmitter } from 'events';

const mockPool = { query: jest.fn() };
const mockSpawn = jest.fn();

jest.mock('@/infrastructure/db/db-client', () => ({
  pool: mockPool,
  withTransaction: jest.fn(),
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { JobManager } from '@/api/services/job-manager';

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
  child.pid = pid;
  child.unref = () => undefined;
  return child;
}

describe('JobManager dry-run', () => {
  let jm: JobManager;
  let child: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    // startScrapeJob arms a 25-minute watchdog and a heartbeat; fake timers keep
    // them from holding the process open after the test.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockPool.query.mockReset();
    // Lease acquisition and any other DB call resolve harmlessly.
    mockPool.query.mockResolvedValue({ rows: [{ lease_generation: 1 }], rowCount: 1 });
    child = fakeChild();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue(child);
    jm = new JobManager();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const spawnedArgs = (): string[] => mockSpawn.mock.calls[0][1] as string[];

  it('passes --dry-run to the scraper CLI when requested', () => {
    jm.startScrapeJob('hnb', { dryRun: true });

    expect(spawnedArgs()).toContain('--dry-run');
    expect(spawnedArgs()).toContain('--bank=hnb');
  });

  it('does not pass --dry-run for a normal scrape', () => {
    jm.startScrapeJob('hnb', {});

    expect(spawnedArgs()).not.toContain('--dry-run');
  });

  it('only an explicit true enables dry-run (truthy values do not)', () => {
    jm.startScrapeJob('hnb', { dryRun: 'yes' as unknown as boolean });

    expect(spawnedArgs()).not.toContain('--dry-run');
  });

  it('does not notify the scheduler or read stale run rows when a dry-run exits', async () => {
    const onCompleted = jest.fn().mockResolvedValue(undefined);
    jm.onJobCompleted = onCompleted;

    jm.startScrapeJob('hnb', { dryRun: true });
    mockPool.query.mockClear();
    child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCompleted).not.toHaveBeenCalled();
    const sql = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes('scrape_runs'))).toBe(false);
  });

  it('still notifies the scheduler after a real scrape', async () => {
    const onCompleted = jest.fn().mockResolvedValue(undefined);
    jm.onJobCompleted = onCompleted;
    mockPool.query.mockResolvedValue({ rows: [{ status: 'completed', error_message: null }], rowCount: 1 });

    jm.startScrapeJob('hnb', {});
    child.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCompleted).toHaveBeenCalledWith('hnb', expect.any(String), 0, true, undefined);
  });
});
