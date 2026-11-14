import axios from 'axios';
import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs/promises';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';

export type SupportedImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface VerifiedImage {
  sourceUrl: string;
  storageKey: string;
  contentHash: string;
  mimeType: SupportedImageMime;
  sizeBytes: number;
  width?: number;
  height?: number;
  verifiedAt: string;
}

export interface ImageAcquisitionResult {
  status: 'VERIFIED' | 'MISSING' | 'REJECTED' | 'FAILED' | 'PRESERVED';
  image: VerifiedImage | null;
  reason?: string;
}

interface ImageServiceOptions {
  storageDir?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  retries?: number;
  /** Test-only escape hatch for deterministic loopback HTTP fixtures. */
  allowPrivateHostsForTests?: boolean;
}

const EXTENSIONS: Record<SupportedImageMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const inFlight = new Map<string, Promise<ImageAcquisitionResult>>();

export class ImageAcquisitionService {
  private readonly storageDir: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly retries: number;
  private readonly allowPrivateHostsForTests: boolean;

  constructor(options: ImageServiceOptions = {}) {
    this.storageDir = path.resolve(
      options.storageDir ?? process.env.IMAGE_STORAGE_DIR ?? path.join(process.cwd(), 'data', 'images'),
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxRedirects = options.maxRedirects ?? 3;
    this.retries = options.retries ?? 1;
    this.allowPrivateHostsForTests = options.allowPrivateHostsForTests === true && process.env.NODE_ENV === 'test';
  }

  async acquire(
    sourceUrl: string | null | undefined,
    previous: VerifiedImage | null = null,
  ): Promise<ImageAcquisitionResult> {
    if (!sourceUrl?.trim()) return { status: previous ? 'PRESERVED' : 'MISSING', image: previous };
    const normalized = sourceUrl.trim();
    const existing = inFlight.get(normalized);
    if (existing) return existing;
    const task = this.acquireOnce(normalized, previous).finally(() => inFlight.delete(normalized));
    inFlight.set(normalized, task);
    return task;
  }

  private async acquireOnce(sourceUrl: string, previous: VerifiedImage | null): Promise<ImageAcquisitionResult> {
    try {
      let current = new URL(sourceUrl);
      let response: Awaited<ReturnType<typeof axios.get<ArrayBuffer>>> | null = null;

      for (let redirects = 0; redirects <= this.maxRedirects; redirects++) {
        const resolved = await this.resolveSafeAddress(current);
        response = await this.requestWithRetry(current, resolved);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location;
          if (!location) throw new Error('REDIRECT_WITHOUT_LOCATION');
          if (redirects === this.maxRedirects) throw new Error('TOO_MANY_REDIRECTS');
          current = new URL(location, current);
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP_${response.status}`);
        break;
      }

      if (!response) throw new Error('NO_RESPONSE');
      const bytes = Buffer.from(response.data);
      if (bytes.length === 0) throw new Error('EMPTY_RESPONSE');
      if (bytes.length > this.maxBytes) throw new Error('IMAGE_TOO_LARGE');

      const detected = detectImage(bytes);
      if (!detected) throw new Error('INVALID_IMAGE_SIGNATURE');
      const headerMime = String(response.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!headerMime.startsWith('image/') || headerMime !== detected.mimeType)
        throw new Error('MIME_SIGNATURE_MISMATCH');
      if (detected.width !== undefined && detected.height !== undefined && detected.width * detected.height <= 4) {
        throw new Error('TRACKING_PIXEL_REJECTED');
      }

      const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const storageKey = `${contentHash}.${EXTENSIONS[detected.mimeType]}`;
      await this.persistAtomically(storageKey, bytes);
      return {
        status: 'VERIFIED',
        image: {
          sourceUrl,
          storageKey,
          contentHash,
          mimeType: detected.mimeType,
          sizeBytes: bytes.length,
          width: detected.width,
          height: detected.height,
          verifiedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const reason = sanitizeError(error);
      return {
        status: previous
          ? 'PRESERVED'
          : reason.startsWith('BLOCKED_') ||
              reason.includes('REJECTED') ||
              reason.includes('INVALID') ||
              reason.includes('MISMATCH') ||
              reason.includes('TOO_LARGE')
            ? 'REJECTED'
            : 'FAILED',
        image: previous,
        reason,
      };
    }
  }

  private async requestWithRetry(url: URL, resolved: { address: string; family: number }) {
    let lastError: unknown;
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) => {
      const all = typeof options === 'object' && options !== null && 'all' in options && options.all === true;
      if (all) callback(null, [resolved]);
      else callback(null, resolved.address, resolved.family);
    };
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await axios.get<ArrayBuffer>(url.toString(), {
          responseType: 'arraybuffer',
          timeout: this.timeoutMs,
          maxContentLength: this.maxBytes,
          maxBodyLength: this.maxBytes,
          maxRedirects: 0,
          proxy: false,
          httpAgent: new http.Agent({
            lookup: pinnedLookup as never,
          }),
          httpsAgent: new https.Agent({
            lookup: pinnedLookup as never,
          }),
          validateStatus: () => true,
          headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'User-Agent': 'LankaOffersImageFetcher/1.0' },
        });
      } catch (error) {
        lastError = error;
        if (attempt < this.retries) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async resolveSafeAddress(url: URL): Promise<{ address: string; family: number }> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('BLOCKED_PROTOCOL');
    if (url.username || url.password) throw new Error('BLOCKED_CREDENTIAL_URL');
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      if (!this.allowPrivateHostsForTests) throw new Error('BLOCKED_LOCAL_HOST');
      return { address: '127.0.0.1', family: 4 };
    }
    const lookupHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    const records = await dns.lookup(lookupHostname, { all: true, verbatim: true });
    if (records.length === 0) throw new Error('DNS_NO_RESULTS');
    const testLoopback =
      this.allowPrivateHostsForTests &&
      records.every(({ address }) => {
        const normalized = address.toLowerCase();
        return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
      });
    if (!testLoopback && records.some(({ address }) => isRestrictedIp(address))) {
      throw new Error('BLOCKED_PRIVATE_ADDRESS');
    }
    return records[0];
  }

  private async persistAtomically(storageKey: string, bytes: Buffer): Promise<void> {
    if (!/^[a-f0-9]{64}\.(jpg|png|gif|webp)$/.test(storageKey)) throw new Error('INVALID_STORAGE_KEY');
    await fs.mkdir(this.storageDir, { recursive: true });
    const target = path.join(this.storageDir, storageKey);
    try {
      await fs.access(target);
      return;
    } catch {
      /* create below */
    }
    const temporary = path.join(this.storageDir, `.${storageKey}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        try {
          await fs.access(target);
        } catch {
          throw error;
        }
      }
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function getOfferImageSource(offer: {
  images?: { logo?: { url?: string } | null; images?: Array<{ url?: string }> };
}): string | null {
  return offer.images?.logo?.url ?? offer.images?.images?.find((image) => image?.url)?.url ?? null;
}

export function isRestrictedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff')
  )
    return true;
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  const parts = mapped.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function detectImage(bytes: Buffer): { mimeType: SupportedImageMime; width?: number; height?: number } | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (
    bytes.length >= 10 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return { mimeType: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (
    bytes.length >= 30 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      return {
        mimeType: 'image/webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      return {
        mimeType: 'image/webp',
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        mimeType: 'image/webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    return null;
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dimensions = readJpegDimensions(bytes);
    return dimensions ? { mimeType: 'image/jpeg', ...dimensions } : null;
  }
  return null;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/https?:\/\/[^\s]+/gi, '[redacted-url]').slice(0, 160);
}
