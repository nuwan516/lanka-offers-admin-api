import { validateGeoValidationProposal } from '@/llm/schemas/geo-validation.schema';

describe('Geo Validation Zod Schema & Post-Validation Guards', () => {
  const availableEvidenceIds = ['ev-1', 'ev-2', 'ev-3'];

  it('accepts a valid grounded proposal', () => {
    const raw = {
      decision: 'CORRECT',
      locationScope: 'EXPLICIT_BRANCH',
      addressQuality: 'EXACT_ADDRESS',
      merchantName: 'Hotel Blue',
      proposedAddresses: [
        {
          address: 'No. 20, Beach Road, Colombo',
          evidenceIds: ['ev-1'],
          reason: 'Explicit participating outlet named in offer details',
        },
      ],
      removedCandidates: ['Both Debit and Credit Cards'],
      uncertainties: [],
      needsGeocoding: true,
      needsHumanReview: false,
      reasoning: 'Cleaned corrupted candidate and extracted valid street address',
    };

    const result = validateGeoValidationProposal(raw, availableEvidenceIds);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sanitizedProposal?.decision).toBe('CORRECT');
    expect(result.sanitizedProposal?.proposedAddresses[0].address).toBe('No. 20, Beach Road, Colombo');
  });

  it('rejects hallucinated or fabricated coordinates', () => {
    const rawWithCoords = {
      decision: 'ACCEPT',
      locationScope: 'EXPLICIT_BRANCH',
      addressQuality: 'EXACT_ADDRESS',
      proposedAddresses: [
        {
          address: 'No. 20, Beach Road, Colombo',
          evidenceIds: ['ev-1'],
          reason: 'Valid',
        },
      ],
      latitude: 6.9271, // Prohibited!
      longitude: 79.8612, // Prohibited!
      needsGeocoding: true,
      needsHumanReview: false,
    };

    const result = validateGeoValidationProposal(rawWithCoords, availableEvidenceIds);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('prohibited coordinate fields'))).toBe(true);
  });

  it('rejects modifications to non-geo financial and validity fields', () => {
    const rawWithFinancial = {
      decision: 'CORRECT',
      locationScope: 'EXPLICIT_BRANCH',
      addressQuality: 'EXACT_ADDRESS',
      proposedAddresses: [
        {
          address: 'No. 20, Beach Road, Colombo',
          evidenceIds: ['ev-1'],
          reason: 'Valid',
        },
      ],
      discountPercentage: 25, // Prohibited!
      needsGeocoding: true,
      needsHumanReview: false,
    };

    const result = validateGeoValidationProposal(rawWithFinancial, availableEvidenceIds);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('modify financial, card, or validity fields'))).toBe(true);
  });

  it('rejects cited evidenceIds that do not exist in source snippets', () => {
    const rawWithBadEvidence = {
      decision: 'CORRECT',
      locationScope: 'EXPLICIT_BRANCH',
      addressQuality: 'EXACT_ADDRESS',
      proposedAddresses: [
        {
          address: 'No. 20, Beach Road, Colombo',
          evidenceIds: ['ev-999'], // Nonexistent!
          reason: 'Valid',
        },
      ],
      needsGeocoding: true,
      needsHumanReview: false,
    };

    const result = validateGeoValidationProposal(rawWithBadEvidence, availableEvidenceIds);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('nonexistent evidenceId: "ev-999"'))).toBe(true);
  });

  it('rejects AREA_ONLY with needsGeocoding=true to prevent invented map pins', () => {
    const rawAreaOnlyGeocoded = {
      decision: 'ACCEPT',
      locationScope: 'DISTRICT_REGION',
      addressQuality: 'AREA_ONLY',
      proposedAddresses: [
        {
          address: 'Colombo, Sri Lanka',
          evidenceIds: ['ev-1'],
          reason: 'City only',
        },
      ],
      needsGeocoding: true, // Prohibited for AREA_ONLY!
      needsHumanReview: false,
    };

    const result = validateGeoValidationProposal(rawAreaOnlyGeocoded, availableEvidenceIds);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('AREA_ONLY address cannot request exact geocoding'))).toBe(true);
  });
});
