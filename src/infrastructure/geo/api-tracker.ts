import * as fs from 'fs';
import * as path from 'path';

// ─── Limits ───────────────────────────────────────────────────────────────────

export interface ApiLimit {
  free: number;
  pricePerK: number;
  name: string;
}

export const API_LIMITS: Record<'geocoding' | 'places', ApiLimit> = {
  geocoding: { free: 10_000, pricePerK: 5.0, name: 'Geocoding API' },
  places: { free: 10_000, pricePerK: 32.0, name: 'Places API (New)' },
};

// ─── Stored data shape ────────────────────────────────────────────────────────

interface MonthEntry {
  count: number;
  firstCall: string;
  lastCall: string;
  /** Last 500 queries per month for debugging. */
  queries: Array<{ q: string; at: string }>;
}

interface TrackerData {
  geocoding: Record<string, MonthEntry>;
  places: Record<string, MonthEntry>;
}

// ─── ApiTracker ───────────────────────────────────────────────────────────────

/**
 * Tracks monthly Google Maps API usage.
 * Warns when approaching the 10K free tier and estimates costs.
 */
export class ApiTracker {
  private readonly filePath: string;
  private data: TrackerData;

  constructor(cacheDir: string) {
    this.filePath = path.join(cacheDir, 'api_usage.json');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    this.data = this.load();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private load(): TrackerData {
    if (fs.existsSync(this.filePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as TrackerData;
      } catch {
        /* corrupted — start fresh */
      }
    }
    return { geocoding: {}, places: {} };
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  private monthKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  private bar(value: number, max: number, width = 20): string {
    const filled = Math.min(Math.round((value / max) * width), width);
    const empty = width - filled;
    const char = value >= max ? '█' : '▓';
    return '[' + char.repeat(filled) + '░'.repeat(empty) + ']';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Record a single API call. Returns the new monthly count. */
  record(type: 'geocoding' | 'places', query: string): number {
    const month = this.monthKey();
    if (!this.data[type][month]) {
      this.data[type][month] = {
        count: 0,
        firstCall: new Date().toISOString(),
        lastCall: new Date().toISOString(),
        queries: [],
      };
    }
    const entry = this.data[type][month];
    entry.count++;
    entry.lastCall = new Date().toISOString();
    if (entry.queries.length < 500) {
      entry.queries.push({ q: query.substring(0, 100), at: new Date().toISOString() });
    }
    this.save();
    return entry.count;
  }

  /** Get usage count for the current month. */
  getMonthlyUsage(type: 'geocoding' | 'places'): number {
    const month = this.monthKey();
    return this.data[type]?.[month]?.count ?? 0;
  }

  /** Returns a warning string if approaching/over free limit, else null. */
  checkLimit(type: 'geocoding' | 'places'): string | null {
    const usage = this.getMonthlyUsage(type);
    const limit = API_LIMITS[type];

    if (usage >= limit.free) {
      const overBy = usage - limit.free;
      const cost = ((overBy / 1000) * limit.pricePerK).toFixed(2);
      return `  ⚠️  ${limit.name}: ${usage}/${limit.free} — OVER FREE LIMIT! $${cost} billed`;
    }
    if (usage >= limit.free * 0.8) {
      return `  ⚠️  ${limit.name}: ${usage}/${limit.free} — approaching free limit (80%)`;
    }
    if (usage >= limit.free * 0.5) {
      return `  ℹ️  ${limit.name}: ${usage}/${limit.free} — 50% of free tier used`;
    }
    return null;
  }

  /** Returns a formatted multiline report string. */
  getReport(): string {
    const month = this.monthKey();
    const lines: string[] = [];
    lines.push(`  API Usage Tracker — ${month}`);
    lines.push('  ' + '─'.repeat(50));

    for (const [type, limit] of Object.entries(API_LIMITS) as [
      'geocoding' | 'places',
      ApiLimit,
    ][]) {
      const usage = this.getMonthlyUsage(type);
      const pct = ((usage / limit.free) * 100).toFixed(1);
      const bar = this.bar(usage, limit.free);
      const cost =
        usage > limit.free
          ? `$${(((usage - limit.free) / 1000) * limit.pricePerK).toFixed(2)} billed`
          : 'free';
      lines.push(
        `  ${limit.name.padEnd(20)} ${bar} ${String(usage).padStart(6)}/${limit.free} (${pct}%) — ${cost}`,
      );
    }

    // History
    const allMonths = new Set<string>();
    Object.values(this.data).forEach((typeData) =>
      Object.keys(typeData).forEach((m) => allMonths.add(m)),
    );
    const sortedMonths = [...allMonths].sort().reverse();

    if (sortedMonths.length > 1) {
      lines.push('\n  History:');
      for (const m of sortedMonths.slice(0, 6)) {
        const geo = this.data.geocoding?.[m]?.count ?? 0;
        const plc = this.data.places?.[m]?.count ?? 0;
        lines.push(`    ${m}: Geocoding ${geo}, Places ${plc}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Estimate the cost of new API calls for this session.
   * (Only charged once the free tier is exhausted.)
   */
  getSessionCost(
    geocodeNew: number,
    placesNew: number,
  ): { geocoding: number; places: number; total: number } {
    const geocodingCost = geocodeNew * (API_LIMITS.geocoding.pricePerK / 1000);
    const placesCost = placesNew * (API_LIMITS.places.pricePerK / 1000);
    return {
      geocoding: geocodingCost,
      places: placesCost,
      total: geocodingCost + placesCost,
    };
  }
}
