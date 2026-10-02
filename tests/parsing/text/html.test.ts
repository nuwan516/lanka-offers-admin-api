import { stripHtml, normalizeWhitespace } from '@/parsing/text/html';

describe('stripHtml', () => {
    it('removes tags', () => {
        expect(stripHtml('<p>Hello</p>')).toBe('Hello');
    });
    it('decodes &amp;', () => {
        expect(stripHtml('A &amp; B')).toBe('A & B');
    });
    it('handles null', () => {
        expect(stripHtml(null)).toBe('');
    });
});

describe('normalizeWhitespace', () => {
    it('collapses multiple spaces', () => {
        expect(normalizeWhitespace('  a   b  ')).toBe('a b');
    });
});