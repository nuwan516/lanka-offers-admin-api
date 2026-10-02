import { Logger } from '@/infrastructure/logger/logger';
import * as path from 'path';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

describe('Logger', () => {
    let tmpDir: string;
    let logger: Logger;

    beforeEach(() => {
        tmpDir = mkdtempSync(path.join(tmpdir(), 'logger-test-'));
        logger = new Logger('test-bank', tmpDir);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates log directory and writes a log entry', () => {
        logger.info('Test', 'Hello world');
        const logFile = path.join(tmpDir, 'test-bank', new Date().toISOString().split('T')[0] + '.jsonl');
        expect(existsSync(logFile)).toBe(true);
        const content = readFileSync(logFile, 'utf-8').trim().split('\n');
        expect(content.length).toBe(1);
        const entry = JSON.parse(content[0]);
        expect(entry.level).toBe('INFO');
        expect(entry.bank).toBe('test-bank');
        expect(entry.tag).toBe('Test');
        expect(entry.message).toBe('Hello world');
    });

    it('appends multiple entries', () => {
        logger.info('A', 'first');
        logger.warn('B', 'second', { count: 42 });
        const logFile = path.join(tmpDir, 'test-bank', new Date().toISOString().split('T')[0] + '.jsonl');
        const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
        expect(lines.length).toBe(2);
        expect(JSON.parse(lines[1]).level).toBe('WARN');
    });

    it('readLogs returns parsed entries', () => {
        const date = new Date().toISOString().split('T')[0];
        logger.info('Test', 'log1');
        logger.error('Test', 'log2');
        const entries = Logger.readLogs('test-bank', date, tmpDir);
        expect(entries.length).toBe(2);
        expect(entries[0].level).toBe('INFO');
        expect(entries[1].level).toBe('ERROR');
    });

    it('readLogs returns empty for missing file', () => {
        const entries = Logger.readLogs('test-bank', '2099-01-01', tmpDir);
        expect(entries).toEqual([]);
    });

    it('timer logs start and completion entries', () => {
        const timer = logger.timer('HTTP', 'fetch page');
        const elapsed = timer.done({ url: 'https://example.com' });
        expect(elapsed).toBeGreaterThanOrEqual(0);

        const date = new Date().toISOString().split('T')[0];
        const entries = Logger.readLogs('test-bank', date, tmpDir);
        expect(entries[0].message).toContain('fetch page started');
        expect(entries[1].message).toContain('fetch page completed');
    });

    it('summary writes structured run stats', () => {
        logger.summary({ offers: 12, failed: 1 });
        const date = new Date().toISOString().split('T')[0];
        const entries = Logger.readLogs('test-bank', date, tmpDir);
        expect(entries[0].tag).toBe('Summary');
        expect(entries[0].data).toEqual({ offers: 12, failed: 1 });
    });

    it('lists banks, dates, recent logs, and prunes old logs', () => {
        const oldFile = path.join(tmpDir, 'test-bank', '2000-01-01.jsonl');
        writeFileSync(oldFile, JSON.stringify({
            ts: '2000-01-01T00:00:00.000Z',
            level: 'INFO',
            bank: 'test-bank',
            tag: 'Old',
            message: 'old',
            pid: 1,
        }) + '\n');

        logger.info('Test', 'recent');

        expect(Logger.listLogBanks(tmpDir)).toContain('test-bank');
        expect(Logger.listLogDates('test-bank', tmpDir)).toContain('2000-01-01');
        expect(Logger.readRecentLogs(1, tmpDir)[0].message).toBe('recent');
        expect(Logger.pruneOldLogs(30, tmpDir)).toBe(1);
        expect(existsSync(oldFile)).toBe(false);
    });
});
