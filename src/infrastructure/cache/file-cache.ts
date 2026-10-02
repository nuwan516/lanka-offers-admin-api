import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface CacheEntry<T> {
  key: string;
  cachedAt: string;
  expiresAt: string | null; // null = never expires
  data: T;
}

export class FileCache {
  constructor(
    private cacheDir: string,
    private defaultTTL?: number,
  ) {
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  private getFilePath(key: string): string {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  get<T>(key: string): T | null {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CacheEntry<T>;
      if (entry.expiresAt && new Date(entry.expiresAt) <= new Date()) {
        this.delete(key);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    const now = new Date();
    const expiresAt = ttlMs
      ? new Date(now.getTime() + ttlMs)
      : this.defaultTTL
        ? new Date(now.getTime() + this.defaultTTL)
        : null;
    const entry: CacheEntry<T> = {
      key,
      cachedAt: now.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      data,
    };
    fs.writeFileSync(this.getFilePath(key), JSON.stringify(entry, null, 2));
  }

  delete(key: string): void {
    const filePath = this.getFilePath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  clear(): void {
    if (fs.existsSync(this.cacheDir)) {
      const files = fs.readdirSync(this.cacheDir);
      files.forEach((f) => fs.unlinkSync(path.join(this.cacheDir, f)));
    }
  }

  stats(): { files: number; size: number } {
    if (!fs.existsSync(this.cacheDir)) return { files: 0, size: 0 };
    const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.json'));
    let size = 0;
    files.forEach((f) => {
      size += fs.statSync(path.join(this.cacheDir, f)).size;
    });
    return { files: files.length, size };
  }
}
