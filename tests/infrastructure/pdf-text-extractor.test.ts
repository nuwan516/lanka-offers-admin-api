import { PdfTextExtractor } from '@/infrastructure/pdf/pdf-text-extractor';
import { HttpClient } from '@/infrastructure/http/http-client';

describe('PdfTextExtractor', () => {
  let httpMock: { downloadBuffer: jest.Mock };
  let extractor: PdfTextExtractor;

  beforeEach(() => {
    httpMock = {
      downloadBuffer: jest.fn(),
    };
    extractor = new PdfTextExtractor(httpMock as unknown as HttpClient);
  });

  it('detects that pdf-parse is available in the environment', () => {
    expect(PdfTextExtractor.isAvailable()).toBe(true);
  });

  it('extracts text and page count from a valid PDF response', async () => {
    // Minimal valid PDF binary header & structure
    // A tiny single-page PDF stream
    const minimalPdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >> endobj
4 0 obj << /Length 55 >> stream
BT
/F1 12 Tf
72 712 Td
(Special 20% discount on credit cards) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000117 00000 n 
0000000282 00000 n 
trailer << /Size 5 /Root 1 0 R >>
startxref
388
%%EOF`;

    httpMock.downloadBuffer.mockResolvedValueOnce({
      data: Buffer.from(minimalPdf),
      fromCache: false,
      status: 200,
    });

    const result = await extractor.extract('https://www.ndbbank.com/terms/promo.pdf');

    expect(result.extracted).toBe(true);
    expect(result.error).toBeNull();
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain('Special 20% discount on credit cards');
  });

  it('gracefully handles network download failures without throwing', async () => {
    httpMock.downloadBuffer.mockRejectedValueOnce(new Error('ETIMEDOUT: Connection timed out'));

    const result = await extractor.extract('https://www.ndbbank.com/terms/timeout.pdf');

    expect(result.extracted).toBe(false);
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.error).toContain('ETIMEDOUT');
  });

  it('gracefully handles corrupt or non-PDF binary data without unhandled exceptions', async () => {
    // Corrupt random binary garbage
    httpMock.downloadBuffer.mockResolvedValueOnce({
      data: Buffer.from('Not a PDF binary stream at all — HTML error 404 page'),
      fromCache: false,
      status: 200,
    });

    const result = await extractor.extract('https://www.ndbbank.com/terms/corrupt.pdf');

    expect(result.extracted).toBe(false);
    expect(result.text).toBeNull();
    expect(result.error).toBeDefined();
  });
});
