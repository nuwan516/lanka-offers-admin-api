import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import {
  ImageAcquisitionService,
  isRestrictedIp,
  type VerifiedImage,
} from '@/infrastructure/images/image-acquisition-service';

function png(width = 32, height = 18, payload = 32): Buffer {
  const bytes = Buffer.alloc(24 + payload, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(23, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[21] = 0xff;
  bytes[22] = 0xd9;
  return bytes;
}

describe('ImageAcquisitionService', () => {
  let storageDir: string;
  let server: http.Server;
  let baseUrl: string;
  let imageRequests = 0;

  beforeAll(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lanka-offers-images-'));
    server = http.createServer((req, res) => {
      if (req.url === '/image.png' || req.url === '/duplicate.png') {
        imageRequests++;
        const body = png();
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
        res.end(body);
      } else if (req.url === '/pixel.png') {
        const body = png(1, 1);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(body);
      } else if (req.url === '/pixel.jpg') {
        const body = jpeg();
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(body);
      } else if (req.url === '/invalid.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end('<html>not an image</html>');
      } else if (req.url === '/wrong-mime') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(png());
      } else if (req.url === '/large.png') {
        const body = png(100, 100, 1024);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(body);
      } else if (req.url === '/timeout.png') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(png());
        }, 200);
      } else if (req.url === '/blocked-redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  const service = (overrides: ConstructorParameters<typeof ImageAcquisitionService>[0] = {}) =>
    new ImageAcquisitionService({ storageDir, allowPrivateHostsForTests: true, retries: 0, ...overrides });

  it('downloads, validates, hashes, and atomically persists a legitimate image', async () => {
    const result = await service().acquire(`${baseUrl}/image.png`);
    expect(result.status).toBe('VERIFIED');
    expect(result.image).toMatchObject({ mimeType: 'image/png', width: 32, height: 18 });
    const stored = await fs.readFile(path.join(storageDir, result.image!.storageKey));
    expect(stored.equals(png())).toBe(true);
    expect((await fs.readdir(storageDir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('deduplicates duplicate URLs, binary content, concurrent requests, and process restarts by content hash', async () => {
    imageRequests = 0;
    const downloader = service();
    const [a, b] = await Promise.all([
      downloader.acquire(`${baseUrl}/image.png`),
      downloader.acquire(`${baseUrl}/image.png`),
    ]);
    const c = await downloader.acquire(`${baseUrl}/duplicate.png`);
    const afterRestart = await service().acquire(`${baseUrl}/duplicate.png`);
    expect(imageRequests).toBe(3);
    expect(a.image?.storageKey).toBe(b.image?.storageKey);
    expect(a.image?.storageKey).toBe(c.image?.storageKey);
    expect(c.image?.storageKey).toBe(afterRestart.image?.storageKey);
    expect((await fs.readdir(storageDir)).filter((name) => name.endsWith('.png'))).toHaveLength(1);
  });

  it.each([
    ['/invalid.png', 'INVALID_IMAGE_SIGNATURE'],
    ['/wrong-mime', 'MIME_SIGNATURE_MISMATCH'],
    ['/pixel.png', 'TRACKING_PIXEL_REJECTED'],
    ['/pixel.jpg', 'TRACKING_PIXEL_REJECTED'],
  ])('rejects unsafe image response %s', async (route, reason) => {
    const result = await service().acquire(`${baseUrl}${route}`);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toContain(reason);
  });

  it('rejects oversized files and times out bounded requests', async () => {
    const oversized = await service({ maxBytes: 128 }).acquire(`${baseUrl}/large.png`);
    expect(['REJECTED', 'FAILED']).toContain(oversized.status);
    const timeout = await service({ timeoutMs: 20 }).acquire(`${baseUrl}/timeout.png`);
    expect(timeout.status).toBe('FAILED');
  });

  it('revalidates redirect destinations and blocks metadata/private addresses', async () => {
    const result = await service().acquire(`${baseUrl}/blocked-redirect`);
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toContain('BLOCKED_PRIVATE_ADDRESS');
    expect(isRestrictedIp('169.254.169.254')).toBe(true);
    expect(isRestrictedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isRestrictedIp('100.64.0.1')).toBe(true);
    expect(isRestrictedIp('198.18.0.1')).toBe(true);
  });

  it('keeps the previously verified image when refresh fails or source is missing', async () => {
    const previous = (await service().acquire(`${baseUrl}/image.png`)).image as VerifiedImage;
    const failed = await service({ timeoutMs: 20 }).acquire(`${baseUrl}/timeout.png`, previous);
    const missing = await service().acquire(null, previous);
    expect(failed).toMatchObject({ status: 'PRESERVED', image: previous });
    expect(missing).toMatchObject({ status: 'PRESERVED', image: previous });
  });
});
