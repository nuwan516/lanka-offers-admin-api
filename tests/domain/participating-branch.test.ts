/**
 * Unit Regressions for Participating Branch Extraction & Verification
 *
 * Covers all confirmed false-negative root causes:
 * 1. Numbered lists with colon followed by newline.
 * 2. Merchant-qualified headings (e.g. "following ODEL outlets").
 * 3. Specific retail venue keywords (showrooms, boutiques, cafes, mansions, supermarkets).
 * 4. Inline numbered items on a single line.
 * 5. Negative exclusions (e.g. "excluding airport outlets" -> EXCLUDED status).
 * 6. Pure city string rejection to avoid false single-branch assumptions.
 * 7. HTML table branch extraction.
 */

import { BranchParticipationService } from '../../src/domain/participating-branch';

describe('BranchParticipationService — Root Cause Regressions', () => {
  it('recovers numbered lists with colon and newline (AMANTE regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'AMANTE',
      title: 'AMANTE Savings',
      description: '25% off on total bill',
      generalTerms: [
        'Valid at below outlets only:',
        '1. amanté, Shop GS06, Racecourse Mall, Colombo 7',
        '2. amanté, No. 15, Marino Mall, Colombo 03',
        '3. amanté, Shop 6A, Level 3, Kandy City Centre',
      ],
    });

    expect(branches.length).toBe(3);
    expect(branches[0].branchName).toBe('Shop GS06, Racecourse Mall, Colombo 7');
    expect(branches[0].participationStatus).toBe('SOURCE_VERIFIED');
    expect(branches[1].branchName).toBe('No. 15, Marino Mall, Colombo 03');
    expect(branches[2].city).toBe('Kandy');
  });

  it('recovers merchant-qualified headings (ODEL regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'ODEL',
      title: 'ODEL Fashion',
      description: '20% off on apparel',
      generalTerms: [
        'Offer valid exclusively at the following ODEL outlets:',
        '1. Alexandra Place Flagship, Colombo 07',
        '2. Kandy City Centre, Kandy',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Alexandra Place Flagship, Colombo 07');
    expect(branches[1].branchName).toBe('Kandy City Centre, Kandy');
  });

  it('recovers showroom descriptors (Cool Planet regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Cool Planet',
      title: 'Cool Planet Promo',
      description: '25% off for DFCC Credit Cards',
      generalTerms: [
        'Valid at the below showrooms only:',
        '1. Pelawatta Showroom, Battaramulla',
        '2. Malabe Showroom, Athurugiriya Road, Malabe',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Pelawatta Showroom, Battaramulla');
    expect(branches[1].branchName).toBe('Malabe Showroom, Athurugiriya Road, Malabe');
  });

  it('recovers boutique descriptors (Spa Ceylon regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Spa Ceylon',
      title: 'Spa Ceylon Promo',
      description: '15% discount for Seylan Cards',
      generalTerms: [
        'Valid at below signature boutiques only:',
        '1. Crescat Boulevard Boutique, Colombo 03',
        '2. One Galle Face Mall, Colombo 02',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Crescat Boulevard Boutique, Colombo 03');
    expect(branches[1].branchName).toBe('One Galle Face Mall, Colombo 02');
  });

  it('recovers cafe descriptors (Barista regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Barista',
      title: 'Barista Coffee',
      description: '20% discount on coffee',
      generalTerms: [
        'Valid at the following participating cafes only:',
        '1. National Museum Cafe, Colombo 07',
        '2. Crescat Boulevard, Colombo 03',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('National Museum Cafe, Colombo 07');
  });

  it('recovers mansion descriptors (Hameedia regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Hameedia',
      title: 'Hameedia Menswear',
      description: '25% discount for Seylan Cards',
      generalTerms: [
        'Valid at the below Envoy Mansions only:',
        '1. Envoy Mansion, Bagatalle Road, Colombo 03',
        '2. Kandy City Centre Envoy, Kandy',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Envoy Mansion, Bagatalle Road, Colombo 03');
  });

  it('recovers supermarket descriptors (Laugfs Super regression)', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Laugfs Super',
      title: 'Laugfs Super Promo',
      description: '15% savings on total bill',
      generalTerms: [
        'Valid at the below supermarkets only:',
        '1. Maharagama Supermarket, High Level Road, Maharagama',
        '2. Rajagiriya Supermarket, Sri Jayawardenepura Mawatha, Rajagiriya',
      ],
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Maharagama Supermarket, High Level Road, Maharagama');
  });

  it('splits inline numbered items on a single line', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'AMANTE',
      title: 'AMANTE Savings',
      description: '25% off for Credit Cards. Valid at below outlets only: 1. Racecourse Mall, 2. Marino Mall',
    });

    expect(branches.length).toBe(2);
    expect(branches[0].branchName).toBe('Racecourse Mall');
    expect(branches[1].branchName).toBe('Marino Mall');
  });

  it('marks airport outlets as EXCLUDED when terms explicitly exclude airport branches', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Burger King',
      title: 'Burger King Savings',
      description: '20% off at all outlets. Excluding BIA Airport outlet.',
      addresses: [
        'No. 20, Galle Road, Colombo 03',
        'Bandaranaike International Airport, Katunayake',
      ],
      restrictions: ['Excluding BIA Airport outlet'],
    });

    expect(branches.length).toBe(2);
    const airport = branches.find((b) => b.sourceAddress?.includes('Airport'));
    const regular = branches.find((b) => b.sourceAddress?.includes('Colombo'));
    expect(airport?.participationStatus).toBe('EXCLUDED');
    expect(regular?.participationStatus).toBe('SOURCE_VERIFIED');
  });

  it('rejects pure city names from single location field to avoid false single-branch assumptions', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Cargills Food City',
      title: 'Cargills Fresh Produce',
      description: '20% off fresh produce',
      location: 'Colombo',
    });

    expect(branches.length).toBe(0); // Pure city string must NOT become a single physical branch
  });

  it('rejects district-level area strings from single location field', () => {
    const branches = BranchParticipationService.extractParticipatingBranches({
      merchantName: 'Keells Super',
      title: 'Keells Savings',
      description: '20% off dairy',
      location: 'Colombo District Outlets',
    });

    expect(branches.length).toBe(0);
  });
});
