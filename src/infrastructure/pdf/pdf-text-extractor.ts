import { HttpClient } from '@/infrastructure/http/http-client';

type PdfParse = (buffer: Buffer) => Promise<{ text?: string; numpages?: number; info?: unknown }>;

export interface PdfExtractionResult {
  url: string;
  extracted: boolean;
  text: string | null;
  pages: number | null;
  error: string | null;
}

export class PdfTextExtractor {
  constructor(private readonly http: HttpClient) {}

  static isAvailable(): boolean {
    return loadPdfParse() !== null;
  }

  async extract(url: string): Promise<PdfExtractionResult> {
    const pdfParse = loadPdfParse();
    if (!pdfParse) {
      return {
        url,
        extracted: false,
        text: null,
        pages: null,
        error: 'pdf-parse is not installed',
      };
    }

    try {
      const response = await this.http.downloadBuffer(url);
      const parsed = await pdfParse(response.data);
      return {
        url,
        extracted: true,
        text: parsed.text ?? null,
        pages: parsed.numpages ?? null,
        error: null,
      };
    } catch (error) {
      return {
        url,
        extracted: false,
        text: null,
        pages: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function loadPdfParse(): PdfParse | null {
  try {
    const req = eval('require') as NodeRequire;
    const mod = req('pdf-parse') as PdfParse | { default?: PdfParse; PDFParse?: PdfParse };
    if (typeof mod === 'function') return mod;
    if ('default' in mod && typeof mod.default === 'function') return mod.default;
    if ('PDFParse' in mod && typeof mod.PDFParse === 'function') return mod.PDFParse;
    return null;
  } catch {
    return null;
  }
}
