import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FATAL = 'FATAL',
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[90m',
  [LogLevel.INFO]: '\x1b[36m',
  [LogLevel.SUCCESS]: '\x1b[32m',
  [LogLevel.WARN]: '\x1b[33m',
  [LogLevel.ERROR]: '\x1b[31m',
  [LogLevel.FATAL]: '\x1b[35;1m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  bank: string;
  tag: string;
  message: string;
  data?: unknown;
  pid: number;
}

export interface LogTimer {
  done(extra?: unknown): number;
  fail(err: unknown): number;
}

export class Logger {
  private logDir: string;

  constructor(
    private bank: string,
    rootDir = path.join(process.cwd(), 'logs'),
  ) {
    this.logDir = path.join(rootDir, bank.toLowerCase());
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  private getLogFile(): string {
    const today = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `${today}.jsonl`);
  }

  private write(level: LogLevel, tag: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      bank: this.bank,
      tag: tag || 'General',
      message,
      data,
      pid: process.pid,
    };

    // Write to file
    try {
      fs.appendFileSync(this.getLogFile(), JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('[Logger] Failed to write log:', err);
    }

    // Console output
    const ts = DIM + this.formatTimestamp(entry.ts) + RESET;
    const lbl = LEVEL_COLORS[level] + level.padEnd(7) + RESET;
    const tagStr = DIM + `[${entry.tag.substring(0, 14).padEnd(14)}]` + RESET;
    const bankStr = DIM + `[${this.bank.toUpperCase().substring(0, 8)}]` + RESET;
    let line = `${ts} ${lbl} ${bankStr} ${tagStr} ${message}`;

    if (data && typeof data === 'object') {
      const compact = JSON.stringify(data);
      if (compact.length < 120) {
        line += ` ${DIM}${compact}${RESET}`;
      }
    }
    console.log(line);
  }

  private formatTimestamp(iso: string): string {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  debug(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.DEBUG, tag, message, data);
  }
  info(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.INFO, tag, message, data);
  }
  success(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.SUCCESS, tag, message, data);
  }
  warn(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.WARN, tag, message, data);
  }
  error(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.ERROR, tag, message, data);
  }
  fatal(tag: string, message: string, data?: unknown) {
    this.write(LogLevel.FATAL, tag, message, data);
  }

  timer(tag: string, label: string): LogTimer {
    const start = Date.now();
    this.debug(tag, `${label} started`);
    return {
      done: (extra?: unknown) => {
        const elapsedMs = Date.now() - start;
        this.debug(tag, `${label} completed in ${elapsedMs}ms`, extra);
        return elapsedMs;
      },
      fail: (err: unknown) => {
        const elapsedMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        this.error(tag, `${label} failed after ${elapsedMs}ms: ${message}`);
        return elapsedMs;
      },
    };
  }

  summary(stats: Record<string, unknown>): void {
    this.info('Summary', 'Run complete', stats);
  }

  /** Read logs for a specific date (helper for dashboard) */
  static readLogs(bank: string, date: string, rootDir = path.join(process.cwd(), 'logs')): LogEntry[] {
    const logFile = path.join(rootDir, bank.toLowerCase(), `${date}.jsonl`);
    if (!fs.existsSync(logFile)) return [];
    try {
      const raw = fs.readFileSync(logFile, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as LogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is LogEntry => e !== null);
    } catch {
      return [];
    }
  }

  static listLogBanks(rootDir = path.join(process.cwd(), 'logs')): string[] {
    if (!fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir)
      .filter((entry) => fs.statSync(path.join(rootDir, entry)).isDirectory())
      .sort();
  }

  static listLogDates(bank: string, rootDir = path.join(process.cwd(), 'logs')): string[] {
    const bankDir = path.join(rootDir, bank.toLowerCase());
    if (!fs.existsSync(bankDir)) return [];
    return fs.readdirSync(bankDir)
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => entry.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  }

  static readRecentLogs(limit = 200, rootDir = path.join(process.cwd(), 'logs')): LogEntry[] {
    const today = new Date().toISOString().split('T')[0];
    const entries = Logger.listLogBanks(rootDir)
      .flatMap((bank) => Logger.readLogs(bank, today, rootDir))
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return entries.slice(-limit);
  }

  static pruneOldLogs(maxAgeDays = 30, rootDir = path.join(process.cwd(), 'logs')): number {
    if (!fs.existsSync(rootDir)) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    let pruned = 0;

    for (const bank of Logger.listLogBanks(rootDir)) {
      const bankDir = path.join(rootDir, bank);
      for (const date of Logger.listLogDates(bank, rootDir)) {
        if (new Date(date) >= cutoff) continue;
        const filePath = path.join(bankDir, `${date}.jsonl`);
        try {
          fs.unlinkSync(filePath);
          pruned++;
        } catch {
          // Best-effort maintenance helper; never crash caller.
        }
      }
    }

    return pruned;
  }
}
