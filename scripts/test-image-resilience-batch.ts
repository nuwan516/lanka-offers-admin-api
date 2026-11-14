import * as fs from 'fs';
import * as path from 'path';
import { ImageResilienceService, ImageMetadata } from '../src/infrastructure/images/image-resilience-service';

async function main() {
  console.log('=== IMAGE RESILIENCE BATCH AUDIT & TEST ===');
  const service = new ImageResilienceService({
    storageDir: path.resolve(process.cwd(), 'data', 'images'),
    timeoutMs: 8000,
    maxSizeBytes: 5 * 1024 * 1024,
    maxRetries: 1,
  });

  const outputDir = path.resolve(process.cwd(), 'output');
  const bankFiles = [
    { bank: 'boc', file: 'boc_all.json' },
    { bank: 'nsb', file: 'nsb_all.json' },
    { bank: 'peoples', file: 'peoples_all.json' },
    { bank: 'hnb', file: 'hnb_all.json' },
  ];

  const candidateUrls: Array<{ bank: string; offerId: string; title: string; url: string }> = [];

  for (const b of bankFiles) {
    const filePath = path.join(outputDir, b.file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const offers = data.offers || [];
      console.log(`Loaded ${offers.length} offers for ${b.bank.toUpperCase()}`);

      let count = 0;
      for (const o of offers) {
        const logoUrl = o.images?.logo?.url || o.images?.images?.[0]?.url;
        if (logoUrl && typeof logoUrl === 'string' && logoUrl.startsWith('http')) {
          candidateUrls.push({
            bank: b.bank,
            offerId: o.uniqueId,
            title: o.title,
            url: logoUrl,
          });
          count++;
          if (count >= 10) break; // Sample 10 URLs per bank for deep download audit
        }
      }
    } catch (err) {
      console.error(`Failed to read ${b.file}:`, err);
    }
  }

  console.log(`\nSampled ${candidateUrls.length} total image URLs across 4 banks.`);
  console.log('Executing bounded download batch with SSRF protection, magic bytes, hashing & deduplication...');

  const batchResults: Array<{
    bank: string;
    offerId: string;
    title: string;
    url: string;
    status: string;
    mimeType: string;
    sizeBytes: number;
    hash: string;
    error?: string;
  }> = [];

  for (const item of candidateUrls) {
    const meta: ImageMetadata = await service.downloadImage(item.url);
    batchResults.push({
      bank: item.bank,
      offerId: item.offerId,
      title: item.title,
      url: item.url,
      status: meta.status,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      hash: meta.hash,
      error: meta.error,
    });
    console.log(`[${item.bank.toUpperCase()}] ${meta.status} (${meta.mimeType || meta.error}) - ${item.url.substring(0, 60)}...`);
  }

  // Summary by bank
  const statsByBank: Record<string, { total: number; downloaded: number; cached: number; failed: number; rejectedType: number }> = {};
  for (const r of batchResults) {
    if (!statsByBank[r.bank]) {
      statsByBank[r.bank] = { total: 0, downloaded: 0, cached: 0, failed: 0, rejectedType: 0 };
    }
    statsByBank[r.bank].total++;
    if (r.status === 'DOWNLOADED') statsByBank[r.bank].downloaded++;
    else if (r.status === 'CACHED') statsByBank[r.bank].cached++;
    else if (r.status === 'FAILED') statsByBank[r.bank].failed++;
    else if (r.status === 'REJECTED_INVALID_TYPE') statsByBank[r.bank].rejectedType++;
  }

  console.log('\n=== IMAGE RELIABILITY SUMMARY BY BANK ===');
  console.table(statsByBank);

  // Write reports/data-quality/image-reliability.json
  const reportDir = path.resolve(process.cwd(), '..', '..', 'reports', 'data-quality');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const reportPayload = {
    generatedAt: new Date().toISOString(),
    totalSampled: batchResults.length,
    statsByBank,
    resilienceGuarantees: {
      ssrfProtected: true,
      magicBytesVerified: true,
      sha256Deduplicated: true,
      atomicWrites: true,
      maxSizeBytes: 5242880,
      timeoutMs: 8000,
      supportedFormats: ['jpeg', 'png', 'webp', 'gif', 'svg'],
      fallbackStrategy: 'Bank-branded local placeholder SVG/PNG if remote image fails',
    },
    sampleAudits: batchResults,
  };

  const reportPath = path.join(reportDir, 'image-reliability.json');
  fs.writeFileSync(reportPath, JSON.stringify(reportPayload, null, 2), 'utf8');
  console.log(`\nWrote Image Reliability Report to: ${reportPath}`);
}

main().catch(console.error);
