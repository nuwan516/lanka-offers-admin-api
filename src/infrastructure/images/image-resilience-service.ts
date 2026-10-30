import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dns from 'dns/promises';
import { URL } from 'url';
import axios, { AxiosResponse } from 'axios';

export interface ImageDownloadOptions {
  timeoutMs?: number;
  maxSizeBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  storageDir?: string;
  allowSvg?: boolean;
}

export type ImageStatus = 'DOWNLOADED' | 'CACHED' | 'FAILED' | 'REJECTED_SSRF' | 'REJECTED_INVALID_TYPE';

export interface ImageMetadata {
  url: string;
  hash: string;
  filename: string;
  localPath: string;
  mimeType: string;
  sizeBytes: number;
  status: ImageStatus;
  error?: string;
  downloadedAt: string;
  lastVerifiedAt: string;
}

export interface ImageManifest {
  version: string;
  updatedAt: string;
  totalImages: number;
  totalBytes: number;
  entries: Record<string, ImageMetadata>; // keyed by URL
}

export interface ImageFormatResult {
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'svg' | null;
  mimeType: string | null;
}

export class ImageResilienceService {
  private storageDir: string;
  private manifestPath: string;
  private manifest: ImageManifest;
  private defaultTimeoutMs: number;
  private defaultMaxSizeBytes: number;
  private defaultMaxRetries: number;

  constructor(options?: {
    storageDir?: string;
    timeoutMs?: number;
    maxSizeBytes?: number;
    maxRetries?: number;
  }) {
    this.storageDir = options?.storageDir || path.resolve(process.cwd(), 'data', 'images');
    this.manifestPath = path.join(this.storageDir, 'manifest.json');
    this.defaultTimeoutMs = options?.timeoutMs || 10_000;
    this.defaultMaxSizeBytes = options?.maxSizeBytes || 5 * 1024 * 1024; // 5 MB
    this.defaultMaxRetries = options?.maxRetries || 2;

    this.ensureStorageDir();
    this.manifest = this.loadManifest();
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private loadManifest(): ImageManifest {
    if (fs.existsSync(this.manifestPath)) {
      try {
        const raw = fs.readFileSync(this.manifestPath, 'utf8');
        return JSON.parse(raw);
      } catch {
        // Corrupt manifest, initialize clean
      }
    }
    return {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      totalImages: 0,
      totalBytes: 0,
      entries: {},
    };
  }

  private saveManifest(): void {
    this.manifest.updatedAt = new Date().toISOString();
    let totalBytes = 0;
    let totalImages = 0;
    for (const entry of Object.values(this.manifest.entries)) {
      if (entry.status === 'DOWNLOADED' || entry.status === 'CACHED') {
        totalImages++;
        totalBytes += entry.sizeBytes || 0;
      }
    }
    this.manifest.totalImages = totalImages;
    this.manifest.totalBytes = totalBytes;

    const tmpPath = `${this.manifestPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.manifestPath);
  }

  /**
   * SSRF Protection:
   * Inspects parsed URL protocol, hostname, and resolves IPv4/IPv6 addresses.
   * Rejects loopback, private RFC1918, link-local, cloud metadata (169.254.169.254),
   * broadcast, and non-routable addresses.
   */
  public async isSsrfSafe(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      return { safe: false, reason: 'INVALID_URL' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { safe: false, reason: `UNSUPPORTED_PROTOCOL: ${parsed.protocol}` };
    }

    const host = parsed.hostname.toLowerCase();

    // Block obvious local names
    if (
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan') ||
      host === '0.0.0.0' ||
      host === '127.0.0.1' ||
      host === '::1'
    ) {
      return { safe: false, reason: `BLOCKED_LOCAL_HOSTNAME: ${host}` };
    }

    // Resolve DNS to verify actual IP
    try {
      const lookup = await dns.lookup(host, { all: true });
      for (const record of lookup) {
        if (this.isPrivateOrRestrictedIp(record.address)) {
          return { safe: false, reason: `RESTRICTED_IP_ADDRESS: ${record.address}` };
        }
      }
    } catch (err) {
      return { safe: false, reason: `DNS_RESOLUTION_FAILED: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { safe: true };
  }

  /**
   * Verifies if an IPv4 or IPv6 string falls into private/reserved address space.
   */
  public isPrivateOrRestrictedIp(ip: string): boolean {
    if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;

    // IPv4 checks
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      const [a, b] = parts;
      // 127.0.0.0/8 (Loopback)
      if (a === 127) return true;
      // 10.0.0.0/8 (Private)
      if (a === 10) return true;
      // 172.16.0.0/12 (Private 172.16 - 172.31)
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.0.0/16 (Private)
      if (a === 192 && b === 168) return true;
      // 169.254.0.0/16 (Link Local / Cloud Metadata 169.254.169.254)
      if (a === 169 && b === 254) return true;
      // 0.0.0.0/8 (Current network)
      if (a === 0) return true;
      // 224.0.0.0/4 (Multicast)
      if (a >= 224 && a <= 239) return true;
      // 240.0.0.0/4 (Reserved)
      if (a >= 240) return true;
      return false;
    }

    // IPv6 checks
    const lower = ip.toLowerCase();
    if (lower.startsWith('fe80:')) return true; // Link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // Unique local
    if (lower.startsWith('ff')) return true; // Multicast

    return false;
  }

  /**
   * Inspects magic bytes / file signatures to verify image authenticity.
   */
  public detectImageFormat(buffer: Buffer): ImageFormatResult {
    if (!buffer || buffer.length < 4) {
      return { format: null, mimeType: null };
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { format: 'jpeg', mimeType: 'image/jpeg' };
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return { format: 'png', mimeType: 'image/png' };
    }

    // GIF: GIF87a or GIF89a
    if (
      buffer.length >= 6 &&
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) &&
      buffer[5] === 0x61
    ) {
      return { format: 'gif', mimeType: 'image/gif' };
    }

    // WebP: RIFF .... WEBP
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { format: 'webp', mimeType: 'image/webp' };
    }

    // SVG: Check first 256 bytes for <svg or <?xml ... <svg
    const header = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8');
    if (header.includes('<svg') && (header.includes('xmlns') || header.includes('viewBox') || header.includes('width'))) {
      return { format: 'svg', mimeType: 'image/svg+xml' };
    }

    return { format: null, mimeType: null };
  }

  /**
   * Downloads an image URL with bounded size, SSRF protection, format validation,
   * SHA-256 deduplication, and atomic write.
   */
  public async downloadImage(
    url: string,
    options?: ImageDownloadOptions
  ): Promise<ImageMetadata> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const maxSizeBytes = options?.maxSizeBytes ?? this.defaultMaxSizeBytes;
    const maxRetries = options?.maxRetries ?? this.defaultMaxRetries;
    const retryDelayMs = options?.retryDelayMs ?? 1000;
    const allowSvg = options?.allowSvg ?? true;

    // 1. Check existing manifest entry
    const existing = this.manifest.entries[url];
    if (existing && (existing.status === 'DOWNLOADED' || existing.status === 'CACHED')) {
      if (fs.existsSync(existing.localPath)) {
        existing.status = 'CACHED';
        existing.lastVerifiedAt = new Date().toISOString();
        return existing;
      }
    }

    // 2. Validate URL and SSRF safety
    const ssrf = await this.isSsrfSafe(url);
    if (!ssrf.safe) {
      const meta: ImageMetadata = {
        url,
        hash: '',
        filename: '',
        localPath: '',
        mimeType: '',
        sizeBytes: 0,
        status: 'REJECTED_SSRF',
        error: ssrf.reason,
        downloadedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      };
      this.manifest.entries[url] = meta;
      this.saveManifest();
      return meta;
    }

    // 3. Download with bounded retries and timeouts
    let buffer: Buffer | null = null;
    let lastError: string = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response: AxiosResponse<Buffer> = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          maxContentLength: maxSizeBytes,
          maxBodyLength: maxSizeBytes,
          maxRedirects: 3,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 LankaOffers/2.0',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        });

        buffer = Buffer.from(response.data);
        break;
      } catch (err: any) {
        lastError = err instanceof Error ? err.message : String(err);
        const status = err.response?.status;
        // Do not retry 4xx errors
        if (status && status >= 400 && status < 500) {
          break;
        }
        if (attempt < maxRetries) {
          await new Promise((res) => setTimeout(res, retryDelayMs * Math.pow(2, attempt)));
        }
      }
    }

    if (!buffer) {
      const meta: ImageMetadata = {
        url,
        hash: '',
        filename: '',
        localPath: '',
        mimeType: '',
        sizeBytes: 0,
        status: 'FAILED',
        error: lastError || 'DOWNLOAD_EMPTY',
        downloadedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      };
      this.manifest.entries[url] = meta;
      this.saveManifest();
      return meta;
    }

    // 4. Verify file signature / magic bytes
    const formatInfo = this.detectImageFormat(buffer);
    if (!formatInfo.format || (!allowSvg && formatInfo.format === 'svg')) {
      const meta: ImageMetadata = {
        url,
        hash: '',
        filename: '',
        localPath: '',
        mimeType: '',
        sizeBytes: buffer.length,
        status: 'REJECTED_INVALID_TYPE',
        error: `INVALID_IMAGE_MAGIC_BYTES (detected: ${formatInfo.format || 'unknown'})`,
        downloadedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      };
      this.manifest.entries[url] = meta;
      this.saveManifest();
      return meta;
    }

    // 5. Content Hashing & Deduplication
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ext = formatInfo.format === 'jpeg' ? 'jpg' : formatInfo.format;
    const filename = `${hash}.${ext}`;
    const targetPath = path.join(this.storageDir, filename);

    // If another URL already downloaded this exact content hash, deduplicate
    if (!fs.existsSync(targetPath)) {
      // Atomic write: write to temp file then rename
      const tmpPath = path.join(this.storageDir, `${hash}.tmp.${Date.now()}`);
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, targetPath);
    }

    const meta: ImageMetadata = {
      url,
      hash,
      filename,
      localPath: targetPath,
      mimeType: formatInfo.mimeType!,
      sizeBytes: buffer.length,
      status: 'DOWNLOADED',
      downloadedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };

    this.manifest.entries[url] = meta;
    this.saveManifest();
    return meta;
  }

  /**
   * Bounded concurrency batch downloader.
   */
  public async downloadBatch(
    urls: string[],
    concurrency = 5,
    options?: ImageDownloadOptions
  ): Promise<Map<string, ImageMetadata>> {
    const results = new Map<string, ImageMetadata>();
    const queue = [...new Set(urls.filter((u) => u && typeof u === 'string' && u.trim().length > 0))];

    const worker = async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        if (!url) break;
        try {
          const res = await this.downloadImage(url, options);
          results.set(url, res);
        } catch (err) {
          results.set(url, {
            url,
            hash: '',
            filename: '',
            localPath: '',
            mimeType: '',
            sizeBytes: 0,
            status: 'FAILED',
            error: err instanceof Error ? err.message : String(err),
            downloadedAt: new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
          });
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);

    return results;
  }

  /**
   * Safe Fallback / Placeholder lookup per bank and category.
   */
  public static getFallbackImage(bank: string, category?: string): { url: string; isPlaceholder: true } {
    const bankClean = (bank || '').toLowerCase();
    return {
      url: `/static/placeholders/banks/${bankClean}-card-placeholder.png`,
      isPlaceholder: true,
    };
  }

  /**
   * Get current manifest data
   */
  public getManifest(): ImageManifest {
    return this.manifest;
  }
}
