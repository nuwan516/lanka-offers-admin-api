import { FileCache } from '@/infrastructure/cache/file-cache';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('FileCache', () => {
    let tmpDir: string;
    let cache: FileCache;

    beforeEach(() => {
        tmpDir = mkdtempSync(path.join(tmpdir(), 'cache-test-'));
        cache = new FileCache(tmpDir, 500); // 500ms default TTL
    });

    afterEach(() => {
        jest.useRealTimers();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stores and retrieves data', () => {
        cache.set('test-key', { hello: 'world' });
        expect(cache.get('test-key')).toEqual({ hello: 'world' });
    });

    it('returns null for missing key', () => {
        expect(cache.get('non-existent')).toBeNull();
    });

    it('respects TTL', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        cache.set('temp', 'value', 100); // 100ms TTL
        expect(cache.get('temp')).toBe('value');
        jest.advanceTimersByTime(150);
        expect(cache.get('temp')).toBeNull();
    });

    it('deletes a key', () => {
        cache.set('del-me', 42);
        cache.delete('del-me');
        expect(cache.get('del-me')).toBeNull();
    });

    it('clears all entries', () => {
        cache.set('a', 1);
        cache.set('b', 2);
        cache.clear();
        expect(cache.stats().files).toBe(0);
    });

    it('stats reports file count', () => {
        cache.set('x', 1);
        cache.set('y', 2);
        const stats = cache.stats();
        expect(stats.files).toBe(2);
    });
});
