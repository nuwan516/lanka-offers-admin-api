import { AddressEngine } from '@/parsing/address/address-engine';

// Engine with zero config — matches real usage in bank parsers
let engine: AddressEngine;

beforeEach(() => {
    engine = new AddressEngine({ country: 'Sri Lanka' });
});

// ─── Labeled marker detection ─────────────────────────────────────────────────

describe('AddressEngine.extract — labeled markers', () => {
    it('extracts address from "Location:" label', () => {
        const result = engine.extract('Offer valid at Location: No 123, Galle Road, Colombo');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('Galle Road');
    });

    it('extracts address from "Branch:" label', () => {
        const result = engine.extract('Branch: 10 Union Place, Colombo 02');
        expect(result[0]).toContain('Union Place');
    });

    it('extracts all branches when multiple listed after marker', () => {
        const text = 'Available at: Kandy Branch | Galle Branch';
        const result = engine.extract(text, 'ABC Bank');
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('does not return discount text matched by marker', () => {
        const result = engine.extract('Outlet: 50% off on all purchases');
        // isNoise should reject this
        expect(result).toHaveLength(0);
    });
});

// ─── Prose-embedded detection ─────────────────────────────────────────────────

describe('AddressEngine.extract — prose-embedded patterns', () => {
    it('extracts address from "located at No. X, Street"', () => {
        const text = 'Our showroom is located at No. 45, Duplication Road, Colombo 04';
        const result = engine.extract(text);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('Duplication Road');
    });

    it('extracts address from parenthesised text', () => {
        const text = 'Visit our store (No. 10, Havelock Road, Colombo 05) for more details';
        const result = engine.extract(text);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('Havelock Road');
    });

    it('extracts address from "our showroom at" phrase', () => {
        const text = 'come visit our branch at No. 5, Galle Road, Colombo 03';
        const result = engine.extract(text);
        expect(result.length).toBeGreaterThan(0);
    });
});

// ─── Structural segment detection ────────────────────────────────────────────

describe('AddressEngine.extract — structural segments', () => {
    it('identifies a line with road name as address', () => {
        const text = 'Special offer for card holders\nNo. 5, Main Street, Colombo';
        const result = engine.extract(text);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('Main Street');
    });

    it('identifies 5-digit postal code as address anchor', () => {
        const text = 'Terms apply\n20 Galle Road 10250';
        const result = engine.extract(text);
        expect(result.length).toBeGreaterThan(0);
    });

    it('rejects noise-only segments even if they match structure', () => {
        // "off" triggers noise filter
        const text = 'Get 20% off on Galle Road branch';
        const result = engine.extract(text);
        // Should fall through to merchant fallback with no merchant given
        expect(result).toHaveLength(0);
    });
});

// ─── Fallback ─────────────────────────────────────────────────────────────────

describe('AddressEngine.extract — fallback', () => {
    it('returns merchant name + country when nothing else is found', () => {
        const text = 'UP TO 12 MONTHS 0% INSTALLMENTS. Terms and conditions apply.';
        const result = engine.extract(text, 'Ashadi Jewellers');
        expect(result).toEqual(['Ashadi Jewellers, Sri Lanka']);
    });

    it('returns empty array when no text and no merchant', () => {
        expect(engine.extract('')).toHaveLength(0);
    });
});

// ─── normalize() ──────────────────────────────────────────────────────────────

describe('AddressEngine.normalize', () => {
    it('appends country if missing', () => {
        expect(engine.normalize('No 10, Galle Road, Colombo 03')).toContain('Sri Lanka');
    });

    it('does not double-append country', () => {
        const result = engine.normalize('No 10, Galle Road, Sri Lanka');
        expect(result?.split('Sri Lanka').length).toBe(2); // exactly once
    });

    it('removes phone numbers with hyphens', () => {
        const result = engine.normalize('Shop, 123 Main St, Colombo, 011-2345678');
        expect(result).not.toContain('011');
        expect(result).toContain('Sri Lanka');
    });

    it('removes URLs', () => {
        const result = engine.normalize('No 5, Galle Road https://example.com');
        expect(result).not.toContain('https');
    });

    it('returns null for noise-only string', () => {
        expect(engine.normalize('50% off minimum spend eligible')).toBeNull();
    });

    it('returns null for too-short string', () => {
        expect(engine.normalize('AB')).toBeNull();
    });

    it('strips "Location:" prefix', () => {
        const result = engine.normalize('Location: No 5, Main Street');
        expect(result).not.toMatch(/^Location:/i);
        expect(result).toContain('Main Street');
    });
});

// ─── Custom config ────────────────────────────────────────────────────────────

describe('AddressEngine — custom config', () => {
    it('uses a custom country suffix', () => {
        const intlEngine = new AddressEngine({ country: 'India' });
        const result = intlEngine.extract('', 'Mumbai Jewels');
        expect(result).toEqual(['Mumbai Jewels, India']);
    });

    it('extracts via custom extraMarker', () => {
        const bankEngine = new AddressEngine({
            extraMarkers: [/Participating Restaurants?\s*:\s*([^;\n]{3,200})/i],
        });
        const result = bankEngine.extract('Participating Restaurants: The Grand, Colombo 07');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('Grand');
    });
});