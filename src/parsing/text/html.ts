/**
 * Strip HTML tags and decode common entities.
 */
export function stripHtml(html: string | null | undefined): string {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Strip HTML tags but keep line structure: block-level closers and <br>
 * become newlines. Needed when line boundaries carry meaning (e.g. one
 * branch address per line on BOC detail pages).
 */
export function stripHtmlKeepLines(html: string | null | undefined): string {
    if (!html) return '';
    return html
        .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/[^\S\n]+/g, ' ')  // collapse spaces but keep newlines
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/**
 * Normalize multiple spaces, trim, and remove zero‑width characters.
 */
export function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the first N words from a text (for generating short labels).
 */
export function firstWords(text: string, count: number): string {
    const words = text.split(/\s+/);
    return words.slice(0, count).join(' ');
}