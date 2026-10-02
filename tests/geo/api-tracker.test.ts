import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ApiTracker } from '@/infrastructure/geo/api-tracker';

let tmpDir: string;
let tracker: ApiTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-tracker-test-'));
  tracker = new ApiTracker(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ApiTracker', () => {
  it('starts at 0 for all types', () => {
    expect(tracker.getMonthlyUsage('geocoding')).toBe(0);
    expect(tracker.getMonthlyUsage('places')).toBe(0);
  });

  it('increments after record()', () => {
    tracker.record('geocoding', 'Colombo, Sri Lanka');
    tracker.record('geocoding', 'Kandy, Sri Lanka');
    tracker.record('places', 'SPAR Sri Lanka');

    expect(tracker.getMonthlyUsage('geocoding')).toBe(2);
    expect(tracker.getMonthlyUsage('places')).toBe(1);
  });

  it('persists across instances', () => {
    tracker.record('geocoding', 'test');
    tracker.record('geocoding', 'test2');

    const tracker2 = new ApiTracker(tmpDir);
    expect(tracker2.getMonthlyUsage('geocoding')).toBe(2);
  });

  it('returns null checkLimit when under 50%', () => {
    expect(tracker.checkLimit('geocoding')).toBeNull();
    expect(tracker.checkLimit('places')).toBeNull();
  });

  it('getReport() contains expected sections', () => {
    tracker.record('geocoding', 'addr1');
    tracker.record('places', 'chain1');

    const report = tracker.getReport();
    expect(report).toContain('API Usage Tracker');
    expect(report).toContain('Geocoding API');
    expect(report).toContain('Places API');
  });

  it('getSessionCost() estimates cost correctly', () => {
    const cost = tracker.getSessionCost(1000, 100);
    // 1000 geocode @ $5/1K = $5
    expect(cost.geocoding).toBeCloseTo(5.0);
    // 100 places @ $32/1K = $3.2
    expect(cost.places).toBeCloseTo(3.2);
    expect(cost.total).toBeCloseTo(8.2);
  });
});
