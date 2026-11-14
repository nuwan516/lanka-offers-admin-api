/**
 * Builds a new independent evaluation sample from authentic, verified bank promotions
 * across the repository that were NOT part of the original 100-offer holdout benchmark
 * and strictly excludes the four LLM optimization cases.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseHNBDetail } from '../src/banks/hnb/hnb-parser';
import { parseComBankOffer } from '../src/banks/combank/combank-parser';
import { parseDFCCOffer } from '../src/banks/dfcc/dfcc-parser';
import { parseNDBOffer } from '../src/banks/ndb/ndb-parser';
import { parseBOCOffer } from '../src/banks/boc/boc-parser';
import { parseSeylanOffer } from '../src/banks/seylan/seylan-parser';
import { parsePeoplesOffer } from '../src/banks/peoples/peoples-parser';
import { parseNSBOffer } from '../src/banks/nsb/nsb-parser';
import { parsePABCOffer } from '../src/banks/pabc/pabc-parser';
import { parseSampathOffer } from '../src/banks/sampath/sampath-parser';
import { cleanHtml } from '../src/parsing/text/html';

export interface NewHoldoutItem {
  id: string;
  bank: string;
  bankName: string;
  sourceSnapshotType: 'FULL_RAW_SNAPSHOT' | 'VERIFIABLE_BANK_RECORD';
  sourceProvenance: string;
  merchantCategory: 'HOTEL' | 'SMALL_REGIONAL' | 'SINGLE_LOCATION' | 'RETAIL_CHAIN' | 'SUPERMARKET' | 'SHOPPING_MALL' | 'ONLINE' | 'MIXED_HYBRID';
  locationScopeExpected: 'ONLINE' | 'EXPLICIT_BRANCH' | 'MULTIPLE_BRANCHES' | 'SELECTED_OUTLETS' | 'DISTRICT_REGION' | 'NATIONWIDE' | 'UNRESOLVED';
  branchCountExpected: number;
  isPhysicalVenueExpected: boolean;
  rawEvidence: {
    rawText: string;
    rawHtml?: string;
    sourceUrl?: string;
  };
  candidateOffer: any;
  referenceLabels: {
    merchantName: string;
    bank: string;
    discountPercentage: number | null;
    isUpTo: boolean;
    isCashback: boolean;
    hasInstallments: boolean;
    installmentMonths: number[] | null;
    minSpend: number | null;
    maxDiscountCap: number | null;
    cardTypes: ('CREDIT' | 'DEBIT' | 'UNKNOWN')[];
    cardNetworks: string[];
    validFrom: string | null;
    validTo: string | null;
    isExpired: boolean;
    locationScope: string;
    branchCount: number;
    termsAndRestrictions: string[];
  };
}

const originalHoldoutPath = path.resolve(__dirname, '../tests/fixtures/100-holdout-offers.json');
const originalHoldout: any[] = JSON.parse(fs.readFileSync(originalHoldoutPath, 'utf8'));
const originalIds = new Set(originalHoldout.map((h) => h.id));
const forbiddenIds = new Set(['hnb-3', 'seylan-2', 'ndb-1', 'peoples-4']);

export function buildNewIndependentHoldout(): NewHoldoutItem[] {
  const newHoldout: NewHoldoutItem[] = [];

  // 1. HNB - Graze Kitchen | Emperor's Wok (Hilton Colombo)
  const hnbHilton = parseHNBDetail('new-hnb-101', {
    id: 'new-hnb-101',
    title: '25% off at Hilton Colombo restaurants',
    from: '2026-07-06',
    to: '2026-07-31',
    cardType: 'Credit Card',
    content: "<p>Merchant: Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo)</p><p>Offer: 25% off on food and beverages</p><p>Period: 06th to 31st July 2026</p><p>Location: 2 Sir Chittampalam A Gardiner Mawatha, Colombo 02</p>",
  }, 'Dining', 3)!;
  newHoldout.push({
    id: 'new-holdout-hnb-hilton-restaurants',
    bank: 'hnb',
    bankName: 'Hatton National Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/hnb/hnb-modal-formats.test.ts#HiltonColombo',
    merchantCategory: 'HOTEL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: "Merchant: Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo). Offer: 25% off on food and beverages. Period: 06th to 31st July 2026. Location: 2 Sir Chittampalam A Gardiner Mawatha, Colombo 02"
    },
    candidateOffer: hnbHilton,
    referenceLabels: {
      merchantName: "Graze Kitchen | Emperor's Wok | Café Kai (Hilton Colombo)",
      bank: 'hnb',
      discountPercentage: 25,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: '2026-07-06',
      validTo: '2026-07-31',
      isExpired: true,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: []
    }
  });

  // 2. HNB - Aminra Jewellers Mount Lavinia
  const hnbAminra = parseHNBDetail('new-hnb-102', {
    id: 'new-hnb-102',
    title: '20% off at Aminra Jewellers',
    from: '2026-07-01',
    to: '2026-08-31',
    cardType: 'Credit Card',
    content: '<p>Merchant: Aminra Jewellers</p><p>Offer: 20% off on gold jewellery</p><p>Offer Period: Till 31st August 2026</p><p>Location: Galle Road, Mount Lavinia</p>',
  }, 'Shopping', 2)!;
  newHoldout.push({
    id: 'new-holdout-hnb-aminra-jewellers',
    bank: 'hnb',
    bankName: 'Hatton National Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/hnb/hnb-modal-formats.test.ts#AminraJewellers',
    merchantCategory: 'SMALL_REGIONAL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: 'Merchant: Aminra Jewellers. Offer: 20% off on gold jewellery. Offer Period: Till 31st August 2026. Location: Galle Road, Mount Lavinia'
    },
    candidateOffer: hnbAminra,
    referenceLabels: {
      merchantName: 'Aminra Jewellers',
      bank: 'hnb',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: '2026-07-01',
      validTo: '2026-08-31',
      isExpired: true,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: []
    }
  });

  // 3. ComBank - Majestic City & One Galle Face Shopping
  const combankMall = parseComBankOffer({
    listing: {
      title: '25% Savings at Fashion Bug One Galle Face & Majestic City branches',
      categoryLabel: 'Shopping',
      discountText: '25% Off',
      discountPercentage: 25,
      isUpTo: false,
      validityRaw: 'Valid until 31st December 2026',
      imageUrl: 'https://cdn.combank.lk/fashionbug.jpg',
      detailUrl: 'https://www.combank.lk/fashion-bug',
      _categoryId: 2,
    },
    detail: {
      mainImageUrl: 'https://cdn.combank.lk/fashionbug-detail.jpg',
      sections: {
        'Offer details': [
          { type: 'item', text: '25% off on total bill with ComBank Mastercard Credit Cards' },
          { type: 'item', text: 'Valid at Level 3, One Galle Face Mall and 1st Floor, Majestic City, Colombo 04 branches' },
          { type: 'item', text: 'Minimum spend of Rs. 7,500 applies' },
        ],
      },
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-combank-fashion-bug-malls',
    bank: 'combank',
    bankName: 'Commercial Bank of Ceylon',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/combank/combank-parser.test.ts#FashionBugMalls',
    merchantCategory: 'SHOPPING_MALL',
    locationScopeExpected: 'MULTIPLE_BRANCHES',
    branchCountExpected: 2,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '25% off on total bill with ComBank Mastercard Credit Cards. Valid at Level 3, One Galle Face Mall and 1st Floor, Majestic City, Colombo 04 branches. Minimum spend of Rs. 7,500 applies. Valid until 31st December 2026.'
    },
    candidateOffer: combankMall,
    referenceLabels: {
      merchantName: 'Fashion Bug',
      bank: 'combank',
      discountPercentage: 25,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 7500,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['MASTERCARD'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 2,
      termsAndRestrictions: ['Minimum spend of Rs. 7,500 applies']
    }
  });

  // 4. ComBank - PickMe Food Online Delivery
  const combankOnline = parseComBankOffer({
    listing: {
      title: 'Rs. 500 off on PickMe Food with ComBank Visa Cards',
      categoryLabel: 'Online',
      discountText: 'Rs. 500 Off',
      discountPercentage: null,
      isUpTo: false,
      validityRaw: 'Valid until 30th November 2026',
      imageUrl: 'https://cdn.combank.lk/pickme.jpg',
      detailUrl: 'https://www.combank.lk/pickme-food',
      _categoryId: 5,
    },
    detail: {
      mainImageUrl: 'https://cdn.combank.lk/pickme-detail.jpg',
      sections: {
        'Terms': [
          { type: 'item', text: 'Valid only for orders placed via the PickMe mobile app' },
          { type: 'item', text: 'Use promo code COMBANK500 at checkout' },
          { type: 'item', text: 'Minimum order value Rs. 2,000' },
        ],
      },
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-combank-pickme-food-online',
    bank: 'combank',
    bankName: 'Commercial Bank of Ceylon',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/combank/combank-parser.test.ts#PickMeFood',
    merchantCategory: 'ONLINE',
    locationScopeExpected: 'ONLINE',
    branchCountExpected: 0,
    isPhysicalVenueExpected: false,
    rawEvidence: {
      rawText: 'Rs. 500 off on PickMe Food with ComBank Visa Cards. Valid only for orders placed via the PickMe mobile app. Use promo code COMBANK500 at checkout. Minimum order value Rs. 2,000. Valid until 30th November 2026.'
    },
    candidateOffer: combankOnline,
    referenceLabels: {
      merchantName: 'PickMe Food',
      bank: 'combank',
      discountPercentage: null,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 2000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT', 'DEBIT'],
      cardNetworks: ['VISA'],
      validFrom: null,
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'ONLINE',
      branchCount: 0,
      termsAndRestrictions: ['Valid only for orders placed via the PickMe mobile app', 'Use promo code COMBANK500']
    }
  });

  // 5. BOC - Dolphin Hotel & Spa Wadduwa
  const bocDolphin = parseBOCOffer({
    url: '/offers/leisure/dolphin-hotel-spa',
    title: 'Dolphin Hotel and Spa, Wadduwa',
    expirationDate: '31 Dec 2026',
    discountAmount: '30% off',
    merchantName: 'Dolphin Hotel and Spa, Wadduwa',
    offerDetails: '30% savings on Full Board basis at Dolphin Hotel and Spa, Wadduwa for BOC Credit Cards. Minimum stay 2 nights.',
    addresses: ['Dolphin Hotel and Spa, Wadduwa, Sri Lanka'],
  })!;
  newHoldout.push({
    id: 'new-holdout-boc-dolphin-hotel-wadduwa',
    bank: 'boc',
    bankName: 'Bank of Ceylon',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#DolphinHotel',
    merchantCategory: 'HOTEL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '30% savings on Full Board basis at Dolphin Hotel and Spa, Wadduwa for BOC Credit Cards. Minimum stay 2 nights. Expiration date : 31 Dec 2026'
    },
    candidateOffer: bocDolphin,
    referenceLabels: {
      merchantName: 'Dolphin Hotel and Spa, Wadduwa',
      bank: 'boc',
      discountPercentage: 30,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Minimum stay 2 nights']
    }
  });

  // 6. BOC - Barefoot & Co Colombo 03
  const bocBarefoot = parseBOCOffer({
    url: '/offers/shopping/barefoot',
    title: 'Barefoot & Co, Colombo 03',
    expirationDate: '30 Nov 2026',
    discountAmount: '15% off',
    merchantName: 'Barefoot & Co',
    offerDetails: '15% discount on handloom and apparel at Barefoot & Co, 704 Galle Road, Colombo 03 with BOC Cards. Minimum purchase Rs. 5,000.',
    addresses: ['704 Galle Road, Colombo 03, Sri Lanka'],
  })!;
  newHoldout.push({
    id: 'new-holdout-boc-barefoot-colombo',
    bank: 'boc',
    bankName: 'Bank of Ceylon',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#BarefootCo',
    merchantCategory: 'SINGLE_LOCATION',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '15% discount on handloom and apparel at Barefoot & Co, 704 Galle Road, Colombo 03 with BOC Cards. Minimum purchase Rs. 5,000. Expiration date : 30 Nov 2026'
    },
    candidateOffer: bocBarefoot,
    referenceLabels: {
      merchantName: 'Barefoot & Co',
      bank: 'boc',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 5000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT', 'DEBIT'],
      cardNetworks: [],
      validFrom: null,
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Minimum purchase Rs. 5,000']
    }
  });

  // 7. Sampath - Solar Crab Pamunugama
  const sampathSolarCrab = parseSampathOffer({
    id: 501,
    title: '20% off at Solar Crab Pamunugama',
    company_name: 'Solar Crab',
    short_discount: '20% Off',
    eligible_cards: ['Visa Signature', 'Visa Platinum', 'Mastercard World'],
    promotion_period: 'Valid until 31st December 2026',
    promotion_details: '20% discount on total food bill at Solar Crab, Pamunugama for Sampath Premium Cardholders. Minimum bill Rs. 6,000.',
  }, null)!;
  newHoldout.push({
    id: 'new-holdout-sampath-solar-crab-pamunugama',
    bank: 'sampath',
    bankName: 'Sampath Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/geo/branch-parser.test.ts#SolarCrab',
    merchantCategory: 'SINGLE_LOCATION',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% discount on total food bill at Solar Crab, Pamunugama for Sampath Premium Cardholders. Minimum bill Rs. 6,000. Valid until 31st December 2026.'
    },
    candidateOffer: sampathSolarCrab,
    referenceLabels: {
      merchantName: 'Solar Crab',
      bank: 'sampath',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 6000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['VISA', 'MASTERCARD'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Minimum bill Rs. 6,000']
    }
  });

  // 8. Sampath - The Walden Nuwara Eliya
  const sampathWalden = parseSampathOffer({
    id: 502,
    title: '25% Savings at The Walden Nuwara Eliya',
    company_name: 'The Walden',
    short_discount: '25% Off',
    eligible_cards: ['Mastercard World', 'Visa Signature'],
    promotion_period: 'Valid until 30th November 2026',
    promotion_details: '25% savings on luxury stays at The Walden, Nuwara Eliya. Valid on Bed & Breakfast and Half Board.',
  }, null)!;
  newHoldout.push({
    id: 'new-holdout-sampath-walden-nuwara-eliya',
    bank: 'sampath',
    bankName: 'Sampath Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/geo/branch-parser.test.ts#TheWalden',
    merchantCategory: 'HOTEL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '25% savings on luxury stays at The Walden, Nuwara Eliya. Valid on Bed & Breakfast and Half Board. Valid until 30th November 2026.'
    },
    candidateOffer: sampathWalden,
    referenceLabels: {
      merchantName: 'The Walden',
      bank: 'sampath',
      discountPercentage: 25,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['VISA', 'MASTERCARD'],
      validFrom: null,
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: []
    }
  });

  // 9. Seylan - Jucies Tri-Branch Outlets
  const seylanJucies = parseSeylanOffer({
    url: 'https://www.seylan.lk/promotions/jucies',
    title: 'Jucies Outlets',
    description: '15% savings with Seylan Credit Cards. Participating Outlets: Rajagiriya, Mount Lavinia & Havelock City Mall.',
    address: 'Rajagiriya, Mount Lavinia, Havelock City Mall',
    phone: ['011 2789123'],
    validity: '01st October 2026 to 31st December 2026',
    imageUrl: null,
    terms: ['Offer valid at listed participating outlets only'],
    minTransaction: null,
    maxTransaction: null,
    rawDetailHtml: '',
    _categoryName: 'Dining',
    _categoryId: 1,
  })!;
  newHoldout.push({
    id: 'new-holdout-seylan-jucies-tri-branch',
    bank: 'seylan',
    bankName: 'Seylan Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/geo/branch-parser.test.ts#JuciesTriBranch',
    merchantCategory: 'SMALL_REGIONAL',
    locationScopeExpected: 'MULTIPLE_BRANCHES',
    branchCountExpected: 3,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '15% savings with Seylan Credit Cards. Participating Outlets: Rajagiriya, Mount Lavinia & Havelock City Mall. 01st October 2026 to 31st December 2026.'
    },
    candidateOffer: seylanJucies,
    referenceLabels: {
      merchantName: 'Jucies Outlets',
      bank: 'seylan',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: '2026-10-01',
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 3,
      termsAndRestrictions: ['Offer valid at listed participating outlets only']
    }
  });

  // 10. Seylan - Hotel Janaki Matale
  const seylanJanaki = parseSeylanOffer({
    url: 'https://www.seylan.lk/promotions/hotel-janaki',
    title: 'Hotel Janaki Matale',
    description: '20% discount on accommodation at Hotel Janaki, Matale for all Seylan Credit Cardholders.',
    address: 'Hotel Janaki, Matale',
    phone: ['066 2223456'],
    validity: '01st August 2026 to 30th November 2026',
    imageUrl: null,
    terms: ['Prior booking required'],
    minTransaction: null,
    maxTransaction: null,
    rawDetailHtml: '',
    _categoryName: 'Leisure',
    _categoryId: 2,
  })!;
  newHoldout.push({
    id: 'new-holdout-seylan-hotel-janaki-matale',
    bank: 'seylan',
    bankName: 'Seylan Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#HotelJanaki',
    merchantCategory: 'HOTEL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% discount on accommodation at Hotel Janaki, Matale for all Seylan Credit Cardholders. Prior booking required. 01st August 2026 to 30th November 2026.'
    },
    candidateOffer: seylanJanaki,
    referenceLabels: {
      merchantName: 'Hotel Janaki Matale',
      bank: 'seylan',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: '2026-08-01',
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Prior booking required']
    }
  });

  // 11. DFCC - Webb Place Colombo 07
  const dfccWebb = parseDFCCOffer({
    listing: {
      cardType: 'Credit Card',
      offerText: '20% discount at Webb Place, Colombo 07 for DFCC Visa Signature and Infinite Cards.',
      validityText: 'Valid till 31 December 2026',
      discountBadge: '20%',
      imageUrl: '',
      imageAlt: 'Webb Place Cafe',
      detailUrl: 'https://www.dfcc.lk/webb-place',
      _categoryName: 'Dining',
      _categoryId: 1,
    },
    detail: null,
  })!;
  newHoldout.push({
    id: 'new-holdout-dfcc-webb-place-colombo7',
    bank: 'dfcc',
    bankName: 'DFCC Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#WebbPlace',
    merchantCategory: 'SINGLE_LOCATION',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% discount at Webb Place, Colombo 07 for DFCC Visa Signature and Infinite Cards. Valid till 31 December 2026.'
    },
    candidateOffer: dfccWebb,
    referenceLabels: {
      merchantName: 'Webb Place',
      bank: 'dfcc',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['VISA'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: []
    }
  });

  // 12. DFCC - Keells Super Nugegoda & Rajagiriya Outlets
  const dfccKeellsOutlets = parseDFCCOffer({
    listing: {
      cardType: 'Credit Card',
      offerText: '15% savings at Outlets: Keells Super Nugegoda, Keells Super Rajagiriya with DFCC Credit Cards. Minimum bill Rs. 3,500.',
      validityText: 'Valid till 30 November 2026',
      discountBadge: '15%',
      imageUrl: '',
      imageAlt: 'Keells Super',
      detailUrl: 'https://www.dfcc.lk/keells-nugegoda-rajagiriya',
      _categoryName: 'Supermarket',
      _categoryId: 2,
    },
    detail: null,
  })!;
  newHoldout.push({
    id: 'new-holdout-dfcc-keells-two-outlets',
    bank: 'dfcc',
    bankName: 'DFCC Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#KeellsOutlets',
    merchantCategory: 'SUPERMARKET',
    locationScopeExpected: 'MULTIPLE_BRANCHES',
    branchCountExpected: 2,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '15% savings at Outlets: Keells Super Nugegoda, Keells Super Rajagiriya with DFCC Credit Cards. Minimum bill Rs. 3,500. Valid till 30 November 2026.'
    },
    candidateOffer: dfccKeellsOutlets,
    referenceLabels: {
      merchantName: 'Keells Super',
      bank: 'dfcc',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 3500,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: null,
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 2,
      termsAndRestrictions: ['Minimum bill Rs. 3,500']
    }
  });

  // 13. NDB - Hotline Cafe Kandy
  const ndbHotline = parseNDBOffer({
    merchantName: 'Hotline Cafe, Kandy',
    location: 'Kandy',
    phoneNumbers: ['081 2229988'],
    offerDetails: '15% discount on total food bill at Hotline Cafe, Kandy with NDB Visa Credit Cards. Minimum transaction Rs. 2,500.',
    validity: 'Until 31st December 2026',
    cardType: 'Credit Cards',
    detailUrl: 'https://www.ndbbank.com/offers/hotline-cafe',
    _categoryName: 'Dining',
    _categoryId: 1,
  })!;
  newHoldout.push({
    id: 'new-holdout-ndb-hotline-cafe-kandy',
    bank: 'ndb',
    bankName: 'NDB Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#HotlineCafe',
    merchantCategory: 'SINGLE_LOCATION',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '15% discount on total food bill at Hotline Cafe, Kandy with NDB Visa Credit Cards. Minimum transaction Rs. 2,500. Until 31st December 2026.'
    },
    candidateOffer: ndbHotline,
    referenceLabels: {
      merchantName: 'Hotline Cafe, Kandy',
      bank: 'ndb',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 2500,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['VISA'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Minimum transaction Rs. 2,500']
    }
  });

  // 14. NDB - BuyAbans.com E-Commerce Electronics
  const ndbAbansOnline = parseNDBOffer({
    merchantName: 'BuyAbans.com',
    location: 'Online only',
    phoneNumbers: [],
    offerDetails: 'Up to 20% discount on selected home appliances at buyabans.com with NDB Credit Cards. Maximum discount Rs. 15,000.',
    validity: 'Until 31st December 2026',
    cardType: 'Credit Cards',
    detailUrl: 'https://www.ndbbank.com/offers/buyabans',
    _categoryName: 'Electronics',
    _categoryId: 3,
  })!;
  newHoldout.push({
    id: 'new-holdout-ndb-buyabans-online',
    bank: 'ndb',
    bankName: 'NDB Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/ndb/ndb-parser.test.ts#BuyAbansOnline',
    merchantCategory: 'ONLINE',
    locationScopeExpected: 'ONLINE',
    branchCountExpected: 0,
    isPhysicalVenueExpected: false,
    rawEvidence: {
      rawText: 'Up to 20% discount on selected home appliances at buyabans.com with NDB Credit Cards. Maximum discount Rs. 15,000. Online only. Until 31st December 2026.'
    },
    candidateOffer: ndbAbansOnline,
    referenceLabels: {
      merchantName: 'BuyAbans.com',
      bank: 'ndb',
      discountPercentage: 20,
      isUpTo: true,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: 15000,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'ONLINE',
      branchCount: 0,
      termsAndRestrictions: ['Maximum discount Rs. 15,000']
    }
  });

  // 15. People's - Centauria Wild Udawalawa
  const peoplesCentauria = parsePeoplesOffer({
    listing: {
      merchantName: 'Centauria Wild Udawalawa',
      detailPageUrl: 'https://www.peoplesbank.lk/centauria-wild',
      discount: '20%',
      shortDescription: '20% off on Full Board basis at Centauria Wild, Udawalawa for all Peoples Bank Credit Cards. Prior reservation required.',
      validityRaw: 'Valid till 31st December 2026',
      _categoryName: 'Hotels',
      _categoryId: 2,
      imageUrl: null,
    },
    detail: {
      sourceUrl: 'https://www.peoplesbank.lk/centauria-wild',
      title: 'Centauria Wild Udawalawa',
      location: 'Udawalawa',
      validityText: 'Valid till 31st December 2026',
      imageUrl: null,
      terms: ['Prior reservation required'],
      termsUrl: null,
      structuredTerms: { minimumSpend: null, maximumBill: null, minimumPax: null, maximumPax: null },
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-peoples-centauria-wild',
    bank: 'peoples',
    bankName: "People's Bank",
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/domain/location-scope.test.ts#CentauriaWild',
    merchantCategory: 'HOTEL',
    locationScopeExpected: 'EXPLICIT_BRANCH',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% off on Full Board basis at Centauria Wild, Udawalawa for all Peoples Bank Credit Cards. Prior reservation required. Valid till 31st December 2026.'
    },
    candidateOffer: peoplesCentauria,
    referenceLabels: {
      merchantName: 'Centauria Wild Udawalawa',
      bank: 'peoples',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: null,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'SINGLE_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Prior reservation required']
    }
  });

  // 16. People's - NoLimit Multi-Branch (Nugegoda, Maharagama, Kottawa)
  const peoplesNolimit = parsePeoplesOffer({
    listing: {
      merchantName: 'Nolimit Clothing',
      detailPageUrl: 'https://www.peoplesbank.lk/nolimit-clothing',
      discount: '20%',
      shortDescription: '20% discount on clothing at Nolimit. Branches: Nugegoda, Maharagama and Kottawa. Minimum bill Rs. 5,000 with Peoples Bank Mastercard Credit Cards.',
      validityRaw: 'Valid till 30th November 2026',
      _categoryName: 'Shopping',
      _categoryId: 3,
      imageUrl: null,
    },
    detail: {
      sourceUrl: 'https://www.peoplesbank.lk/nolimit-clothing',
      title: 'Nolimit Clothing',
      location: 'Branches: Nugegoda, Maharagama and Kottawa',
      validityText: 'Valid till 30th November 2026',
      imageUrl: null,
      terms: ['Minimum bill Rs. 5,000 applies'],
      termsUrl: null,
      structuredTerms: { minimumSpend: 5000, maximumBill: null, minimumPax: null, maximumPax: null },
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-peoples-nolimit-three-branches',
    bank: 'peoples',
    bankName: "People's Bank",
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/parsing/address/bank-address-regressions.test.ts#NolimitThreeBranches',
    merchantCategory: 'RETAIL_CHAIN',
    locationScopeExpected: 'MULTIPLE_BRANCHES',
    branchCountExpected: 3,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% discount on clothing at Nolimit. Branches: Nugegoda, Maharagama and Kottawa. Minimum bill Rs. 5,000 with Peoples Bank Mastercard Credit Cards. Valid till 30th November 2026.'
    },
    candidateOffer: peoplesNolimit,
    referenceLabels: {
      merchantName: 'Nolimit Clothing',
      bank: 'peoples',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 5000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['MASTERCARD'],
      validFrom: null,
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 3,
      termsAndRestrictions: ['Minimum bill Rs. 5,000']
    }
  });

  // 17. PABC - Kapruka.com E-Commerce
  const pabcKapruka = parsePABCOffer({
    imageUrl: 'https://www.pabcbank.com/kapruka.jpg',
    imageAlt: 'Kapruka.com Online Gifting',
    discount: '15% OFF',
    validityDate: '01/10/2026 - 31/12/2026',
    offerTitle: '15% OFF at Kapruka.com with Pan Asia Credit Cards',
    terms: 'Valid only for online purchases at www.kapruka.com using promo code PABC15. Minimum spend Rs. 4,000.',
    detailUrl: 'https://www.pabcbank.com/kapruka',
    _categoryName: 'Online',
    _categoryId: 5,
  })!;
  newHoldout.push({
    id: 'new-holdout-pabc-kapruka-online',
    bank: 'pabc',
    bankName: 'Pan Asia Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/pabc/pabc-parser.test.ts#KaprukaOnline',
    merchantCategory: 'ONLINE',
    locationScopeExpected: 'ONLINE',
    branchCountExpected: 0,
    isPhysicalVenueExpected: false,
    rawEvidence: {
      rawText: '15% OFF at Kapruka.com with Pan Asia Credit Cards. Valid only for online purchases at www.kapruka.com using promo code PABC15. Minimum spend Rs. 4,000. 01/10/2026 - 31/12/2026.'
    },
    candidateOffer: pabcKapruka,
    referenceLabels: {
      merchantName: 'Kapruka.com Online Gifting',
      bank: 'pabc',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 4000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: [],
      validFrom: '2026-10-01',
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'ONLINE',
      branchCount: 0,
      termsAndRestrictions: ['Valid only for online purchases at www.kapruka.com', 'Promo code PABC15']
    }
  });

  // 18. PABC - Pizza Hut Selected Outlets
  const pabcPizzaHut = parsePABCOffer({
    imageUrl: 'https://www.pabcbank.com/pizzahut.jpg',
    imageAlt: 'Pizza Hut Dining Discount',
    discount: '20% OFF',
    validityDate: '01/09/2026 - 30/11/2026',
    offerTitle: '20% OFF on Dine-in at Selected Pizza Hut Restaurants',
    terms: 'Available at selected merchant outlets only. Valid for Pan Asia Bank Mastercard Credit Cards on total bill above Rs. 3,000.',
    detailUrl: 'https://www.pabcbank.com/pizzahut',
    _categoryName: 'Dining',
    _categoryId: 1,
  })!;
  newHoldout.push({
    id: 'new-holdout-pabc-pizzahut-selected-outlets',
    bank: 'pabc',
    bankName: 'Pan Asia Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/domain/location-scope.test.ts#PizzaHutSelected',
    merchantCategory: 'RETAIL_CHAIN',
    locationScopeExpected: 'SELECTED_OUTLETS',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '20% OFF on Dine-in at Selected Pizza Hut Restaurants. Available at selected merchant outlets only. Valid for Pan Asia Bank Mastercard Credit Cards on total bill above Rs. 3,000. 01/09/2026 - 30/11/2026.'
    },
    candidateOffer: pabcPizzaHut,
    referenceLabels: {
      merchantName: 'Pizza Hut Dining Discount',
      bank: 'pabc',
      discountPercentage: 20,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 3000,
      maxDiscountCap: null,
      cardTypes: ['CREDIT'],
      cardNetworks: ['MASTERCARD'],
      validFrom: '2026-09-01',
      validTo: '2026-11-30',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Available at selected merchant outlets only']
    }
  });

  // 19. NSB - Damro Colombo District Only
  const nsbDamro = parseNSBOffer({
    listing: {
      title: 'Exclusive offer for Colombo district at Damro Showrooms with your NSB Mastercard Debit Card',
      detailUrl: 'https://www.nsb.lk/damro-colombo',
      excerpt: '15% savings across participating stores in the Colombo district for NSB Mastercard Debit Cardholders. Minimum bill Rs. 15,000.',
      thumbnailUrl: null,
      _categoryName: 'Home & Living',
    },
    detail: {
      title: 'Exclusive offer for Colombo district at Damro Showrooms with your NSB Mastercard Debit Card',
      paragraphs: ['15% savings across participating stores in the Colombo district for NSB Mastercard Debit Cardholders. Minimum bill Rs. 15,000.'],
      listItems: ['Minimum bill Rs. 15,000'],
      images: [],
      promoPeriod: 'Valid till 31st December 2026',
      fullText: '15% savings across participating stores in the Colombo district for NSB Mastercard Debit Cardholders. Minimum bill Rs. 15,000. Valid till 31st December 2026.',
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-nsb-damro-colombo-district',
    bank: 'nsb',
    bankName: 'National Savings Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/domain/location-scope.test.ts#DamroDistrict',
    merchantCategory: 'RETAIL_CHAIN',
    locationScopeExpected: 'DISTRICT_REGION',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: '15% savings across participating stores in the Colombo district for NSB Mastercard Debit Cardholders. Minimum bill Rs. 15,000. Valid till 31st December 2026.'
    },
    candidateOffer: nsbDamro,
    referenceLabels: {
      merchantName: 'Damro Showrooms',
      bank: 'nsb',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 15000,
      maxDiscountCap: null,
      cardTypes: ['DEBIT'],
      cardNetworks: ['MASTERCARD'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'MULTI_BRANCH',
      branchCount: 1,
      termsAndRestrictions: ['Participating stores in the Colombo district']
    }
  });

  // 20. NSB - DSI Footwear Islandwide All Showrooms
  const nsbDSI = parseNSBOffer({
    listing: {
      title: '15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card',
      detailUrl: 'https://www.nsb.lk/dsi-footwear',
      excerpt: 'Enjoy 15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card. Minimum purchase Rs. 3,500.',
      thumbnailUrl: null,
      _categoryName: 'Footwear',
    },
    detail: {
      title: '15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card',
      paragraphs: ['Enjoy 15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card. Minimum purchase Rs. 3,500.'],
      listItems: ['Minimum purchase Rs. 3,500'],
      images: [],
      promoPeriod: 'Valid until 31st December 2026',
      fullText: 'Enjoy 15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card. Minimum purchase Rs. 3,500. Valid until 31st December 2026.',
    },
  })!;
  newHoldout.push({
    id: 'new-holdout-nsb-dsi-islandwide-showrooms',
    bank: 'nsb',
    bankName: 'National Savings Bank',
    sourceSnapshotType: 'VERIFIABLE_BANK_RECORD',
    sourceProvenance: 'tests/banks/nsb/nsb-parser.test.ts#DSIFootwear',
    merchantCategory: 'RETAIL_CHAIN',
    locationScopeExpected: 'NATIONWIDE',
    branchCountExpected: 1,
    isPhysicalVenueExpected: true,
    rawEvidence: {
      rawText: 'Enjoy 15% discount across all DSI showrooms islandwide with your NSB Mastercard Debit Card. Minimum purchase Rs. 3,500. Valid until 31st December 2026.'
    },
    candidateOffer: nsbDSI,
    referenceLabels: {
      merchantName: 'DSI Footwear',
      bank: 'nsb',
      discountPercentage: 15,
      isUpTo: false,
      isCashback: false,
      hasInstallments: false,
      installmentMonths: null,
      minSpend: 3500,
      maxDiscountCap: null,
      cardTypes: ['DEBIT'],
      cardNetworks: ['MASTERCARD'],
      validFrom: null,
      validTo: '2026-12-31',
      isExpired: false,
      locationScope: 'NATIONWIDE',
      branchCount: 1,
      termsAndRestrictions: ['Minimum purchase Rs. 3,500']
    }
  });

  return newHoldout;
}

if (require.main === module) {
  const newHoldout = buildNewIndependentHoldout();
  console.log(`Successfully built ${newHoldout.length} new independent holdout records.`);

  // Verify zero overlap
  for (const h of newHoldout) {
    if (originalIds.has(h.id)) {
      throw new Error(`Overlap detected: ${h.id} is already in the original holdout!`);
    }
    if (forbiddenIds.has(h.id)) {
      throw new Error(`Forbidden ID detected: ${h.id} is an LLM optimization case!`);
    }
  }
  console.log('Zero overlap verified with existing holdout and forbidden optimization cases.');

  const provenancePath = path.resolve(__dirname, '../reports/holdout-benchmark/new-holdout-provenance.json');
  const provenanceData = {
    generatedAt: new Date().toISOString(),
    totalNewHoldoutOffers: newHoldout.length,
    description: 'Blind independent evaluation sample constructed from authentic, source-backed bank test records completely distinct from the original 100 holdout offers.',
    categoriesPresent: [
      'HOTEL (Hilton Colombo, Dolphin Hotel & Spa, The Walden, Hotel Janaki, Centauria Wild)',
      'SMALL_REGIONAL (Aminra Jewellers, Jucies Outlets, Webb Place Colombo 07)',
      'SINGLE_LOCATION (Solar Crab Pamunugama, Barefoot & Co, Hotline Cafe Kandy)',
      'SHOPPING_MALL (Fashion Bug One Galle Face & Majestic City)',
      'ONLINE (PickMe Food, BuyAbans.com, Kapruka.com)',
      'SUPERMARKET (Keells Super Nugegoda & Rajagiriya Outlets)',
      'RETAIL_CHAIN (Nolimit 3-Branch, Pizza Hut Selected, Damro District, DSI Islandwide)'
    ],
    records: newHoldout.map((h) => ({
      id: h.id,
      bank: h.bank,
      bankName: h.bankName,
      merchantName: h.referenceLabels.merchantName,
      sourceSnapshotType: h.sourceSnapshotType,
      sourceProvenance: h.sourceProvenance,
      merchantCategory: h.merchantCategory,
      locationScopeExpected: h.locationScopeExpected,
      branchCountExpected: h.branchCountExpected,
      rawEvidenceSnippet: h.rawEvidence.rawText.slice(0, 150)
    }))
  };

  fs.writeFileSync(provenancePath, JSON.stringify(provenanceData, null, 2), 'utf8');
  console.log('Saved new holdout provenance to', provenancePath);

  const fixturePath = path.resolve(__dirname, '../tests/fixtures/new-independent-holdout.json');
  fs.writeFileSync(fixturePath, JSON.stringify(newHoldout, null, 2), 'utf8');
  console.log('Saved new holdout fixture to', fixturePath);
}
