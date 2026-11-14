import * as fs from 'fs';
import * as path from 'path';
import { ImageResilienceService } from '@/infrastructure/images/image-resilience-service';

describe('ImageResilienceService', () => {
  const testStorageDir = path.resolve(__dirname, '../../.test-images');
  let service: ImageResilienceService;

  beforeAll(() => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
    service = new ImageResilienceService({ storageDir: testStorageDir });
  });

  afterAll(() => {
    if (fs.existsSync(testStorageDir)) {
      fs.rmSync(testStorageDir, { recursive: true, force: true });
    }
  });

  describe('SSRF Protection', () => {
    it('blocks localhost and private loopback IPs', async () => {
      expect(await service.isSsrfSafe('http://localhost/image.png')).toEqual({
        safe: false,
        reason: 'BLOCKED_LOCAL_HOSTNAME: localhost',
      });
      expect(await service.isSsrfSafe('http://127.0.0.1:8080/image.jpg')).toEqual({
        safe: false,
        reason: 'BLOCKED_LOCAL_HOSTNAME: 127.0.0.1',
      });
    });

    it('blocks AWS/GCP cloud metadata IP 169.254.169.254', () => {
      expect(service.isPrivateOrRestrictedIp('169.254.169.254')).toBe(true);
    });

    it('blocks RFC1918 private IP ranges', () => {
      expect(service.isPrivateOrRestrictedIp('10.0.0.1')).toBe(true);
      expect(service.isPrivateOrRestrictedIp('172.16.5.1')).toBe(true);
      expect(service.isPrivateOrRestrictedIp('172.31.255.255')).toBe(true);
      expect(service.isPrivateOrRestrictedIp('192.168.1.100')).toBe(true);
    });

    it('permits public routable IP addresses', () => {
      expect(service.isPrivateOrRestrictedIp('8.8.8.8')).toBe(false);
      expect(service.isPrivateOrRestrictedIp('1.1.1.1')).toBe(false);
      expect(service.isPrivateOrRestrictedIp('52.95.120.1')).toBe(false);
    });

    it('rejects unsupported protocols (ftp, file, gopher)', async () => {
      expect(await service.isSsrfSafe('file:///etc/passwd')).toEqual({
        safe: false,
        reason: 'UNSUPPORTED_PROTOCOL: file:',
      });
      expect(await service.isSsrfSafe('ftp://example.com/logo.png')).toEqual({
        safe: false,
        reason: 'UNSUPPORTED_PROTOCOL: ftp:',
      });
    });
  });

  describe('Magic Bytes Image Signature Detection', () => {
    it('detects JPEG signatures', () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(service.detectImageFormat(jpegBuffer)).toEqual({
        format: 'jpeg',
        mimeType: 'image/jpeg',
      });
    });

    it('detects PNG signatures', () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(service.detectImageFormat(pngBuffer)).toEqual({
        format: 'png',
        mimeType: 'image/png',
      });
    });

    it('detects WebP signatures', () => {
      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(service.detectImageFormat(webpBuffer)).toEqual({
        format: 'webp',
        mimeType: 'image/webp',
      });
    });

    it('detects SVG XML structures', () => {
      const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
      expect(service.detectImageFormat(svgBuffer)).toEqual({
        format: 'svg',
        mimeType: 'image/svg+xml',
      });
    });

    it('rejects HTML or script files pretending to be images', () => {
      const htmlBuffer = Buffer.from('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
      expect(service.detectImageFormat(htmlBuffer)).toEqual({
        format: null,
        mimeType: null,
      });
    });
  });

  describe('Fallback & Placeholder Support', () => {
    it('returns official card placeholder for supported banks', () => {
      const hnbFallback = ImageResilienceService.getFallbackImage('HNB');
      expect(hnbFallback).toEqual({
        url: '/static/placeholders/banks/hnb-card-placeholder.png',
        isPlaceholder: true,
      });

      const bocFallback = ImageResilienceService.getFallbackImage('BOC');
      expect(bocFallback).toEqual({
        url: '/static/placeholders/banks/boc-card-placeholder.png',
        isPlaceholder: true,
      });
    });
  });
});
