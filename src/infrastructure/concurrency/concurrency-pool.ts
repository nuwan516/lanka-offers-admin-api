export class ConcurrencyPool {
  private queue: Array<{
    execute: () => Promise<void>;
    reject: (reason?: unknown) => void;
  }> = [];
  private active = 0;
  private cancelled = false;
  private cancelReason: unknown = null;

  constructor(private maxConcurrency: number) {}

  private next(): void {
    if (this.cancelled || this.active >= this.maxConcurrency || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    this.active++;
    task.execute().finally(() => {
      this.active--;
      this.next();
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(this.cancelReason);
        return;
      }

      const task = async () => {
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        }
      };
      this.queue.push({ execute: task, reject });
      this.next();
    });
  }

  /** Execute all tasks with limited concurrency */
  async all<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    try {
      return await Promise.all(tasks.map((task) => this.run(async () => {
        try {
          return await task();
        } catch (err) {
          this.cancelPending(err);
          throw err;
        }
      })));
    } catch (err) {
      this.cancelPending(err);
      throw err;
    }
  }

  cancelPending(reason: unknown = new Error('Concurrency pool cancelled')): void {
    this.cancelled = true;
    this.cancelReason = reason;

    const pending = this.queue.splice(0);
    for (const task of pending) {
      task.reject(reason);
    }
  }

  get activeCount(): number {
    return this.active;
  }
  get pendingCount(): number {
    return this.queue.length;
  }
}
