import { ConcurrencyPool } from '@/infrastructure/concurrency/concurrency-pool';

describe('ConcurrencyPool', () => {
    it('limits concurrent executions', async () => {
        const pool = new ConcurrencyPool(2);
        const running: number[] = [];
        const maxConcurrent = { max: 0 };

        const task = (id: number) => async () => {
            running.push(id);
            maxConcurrent.max = Math.max(maxConcurrent.max, running.length);
            await new Promise(resolve => setTimeout(resolve, 20));
            running.splice(running.indexOf(id), 1);
            return id;
        };

        const results = await pool.all([task(1), task(2), task(3), task(4)]);
        expect(results).toEqual([1, 2, 3, 4]);
        expect(maxConcurrent.max).toBeLessThanOrEqual(2);
    });

    it('run executes a single task', async () => {
        const pool = new ConcurrencyPool(5);
        const result = await pool.run(async () => 42);
        expect(result).toBe(42);
    });

    it('rejects on error', async () => {
        const pool = new ConcurrencyPool(1);
        await expect(pool.run(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    });

    it('does not start queued tasks after one task fails', async () => {
        const pool = new ConcurrencyPool(1);
        const started: number[] = [];

        await expect(pool.all([
            async () => {
                started.push(1);
                throw new Error('fail-fast');
            },
            async () => {
                started.push(2);
                return 2;
            },
        ])).rejects.toThrow('fail-fast');

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(started).toEqual([1]);
        expect(pool.pendingCount).toBe(0);
    });

    it('reports active and pending counts', () => {
        const pool = new ConcurrencyPool(2);
        expect(pool.activeCount).toBe(0);
        expect(pool.pendingCount).toBe(0);
    });
});
