// ─── Shared ───────────────────────────────────────────────────────────────────

export interface BankCategory {
  id: number;
  name: string;
  /** URL template — {page} is replaced with a page number. */
  url: string;
  /** Stable site slug when the bank uses category path/query slugs. */
  slug?: string;
  /** Some banks split a category across credit/debit or multiple source pages. */
  urls?: string[];
  /** Source technique required for this category. */
  sourceType?: ScrapeSourceType;
  /** Category-specific card type when source URLs are split by card type. */
  cardType?: 'credit' | 'debit' | 'both' | 'unknown';
  /** Detail pages may contain addresses, terms, images, PDFs, etc. */
  detailRequired?: boolean;
  /** Category/detail extraction requires a rendered browser. */
  browserRequired?: boolean;
  /** Terms or details may require PDF extraction. */
  pdfRequired?: boolean;
}

export type BankName = 'hnb' | 'sampath' | 'boc' | 'peoples' | 'seylan' | 'ndb' | 'dfcc' | 'pabc' | 'nsb' | 'combank';

export type BankCapability = 'scrape' | 'geocode' | 'llmValidation';
export type ScrapeSourceType = 'json-api' | 'html' | 'headless-browser' | 'pdf' | 'mixed';

export interface BankConfig {
  bank: BankName;
  displayName: string;
  categories: BankCategory[];
  outputPrefix: string;
  sourceType: ScrapeSourceType;
  activeBaseScript?: string;
  notes?: string;
  capabilities: Record<BankCapability, boolean>;
}

// ─── HNB ─────────────────────────────────────────────────────────────────────

export const HNB_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Hotel', slug: 'hotel', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=1&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 2, name: 'Travel', slug: 'travel', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=2&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 3, name: 'Dining', slug: 'dining', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=3&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 4, name: 'Shopping', slug: 'shopping', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=4&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 5, name: 'Lifestyle', slug: 'lifestyle', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=5&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 6, name: 'Online', slug: 'online', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=6&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 7, name: 'Autocare', slug: 'autocare', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=7&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 8, name: 'Other', slug: 'other', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=8&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 9, name: 'Fashion', slug: 'fashion', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=9&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 10, name: 'Hospitals', slug: 'hospitals', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=10&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 11, name: 'Jewellery', slug: 'jewellery', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=11&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 12, name: 'Education', slug: 'education', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=12&page={page}&cardType=all', sourceType: 'json-api' },
  { id: 13, name: 'Solar Solutions', slug: 'solar-solutions', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?cat=13&page={page}&cardType=all', sourceType: 'json-api' },
  // Catch-all MUST stay last: ~30 offers exist only in the uncategorized feed
  // (578 total vs 549 via cat=1..13). Dedupe keeps the first (categorized) copy.
  { id: 0, name: 'All', slug: 'all', url: 'https://venus.hnb.lk/api/get_all_web_card_promos?page={page}&cardType=all', sourceType: 'json-api' },
];

// ─── Sampath ──────────────────────────────────────────────────────────────────
// Sampath API: GET /api/offers?type=<type>&page={page}&pageSize=20

export const SAMPATH_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Hotels', slug: 'hotels', url: 'https://www.sampath.lk/api/card-promotions?category=hotels&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 2, name: 'SuperMarkets', slug: 'super_market', url: 'https://www.sampath.lk/api/card-promotions?category=super_market&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 3, name: 'Online', slug: 'online', url: 'https://www.sampath.lk/api/card-promotions?category=online&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 4, name: 'Electronics & Furniture', slug: 'Electronics_and_Furniture', url: 'https://www.sampath.lk/api/card-promotions?category=Electronics_and_Furniture&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 5, name: 'Health and insurance', slug: 'health_and_insurance', url: 'https://www.sampath.lk/api/card-promotions?category=health_and_insurance&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 6, name: 'Fashion', slug: 'fashion', url: 'https://www.sampath.lk/api/card-promotions?category=fashion&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 7, name: 'Dining', slug: 'dining', url: 'https://www.sampath.lk/api/card-promotions?category=dining&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 8, name: 'Travel and Leisure', slug: 'travel_and_leisure', url: 'https://www.sampath.lk/api/card-promotions?category=travel_and_leisure&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 9, name: 'Premium Offers', slug: 'Premium_Offers', url: 'https://www.sampath.lk/api/card-promotions?category=Premium_Offers&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 10, name: 'VISA Offers', slug: 'VISA_Offers', url: 'https://www.sampath.lk/api/card-promotions?category=VISA_Offers&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 11, name: 'Mastercard Offers', slug: 'Mastercard_Offers', url: 'https://www.sampath.lk/api/card-promotions?category=Mastercard_Offers&page={page}', sourceType: 'json-api', detailRequired: true },
  { id: 12, name: 'Other', slug: 'Other', url: 'https://www.sampath.lk/api/card-promotions?category=Other&page={page}', sourceType: 'json-api', detailRequired: true },
];

// ─── BOC ──────────────────────────────────────────────────────────────────────
// Bank of Ceylon promotions page (HTML-scraped, Cheerio)

export const BOC_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Travel and Leisure', slug: 'travel-and-leisure', url: 'https://www.boc.lk/personal-banking/card-offers/travel-and-leisure', sourceType: 'html', detailRequired: true },
  { id: 2, name: 'Supermarkets', slug: 'supermarkets', url: 'https://www.boc.lk/personal-banking/card-offers/supermarkets', sourceType: 'html', detailRequired: true },
  { id: 3, name: 'Lifestyle', slug: 'lifestyle', url: 'https://www.boc.lk/personal-banking/card-offers/lifestyle', sourceType: 'html', detailRequired: true },
  { id: 4, name: 'Utility & Insurance', slug: 'utility-insurance', url: 'https://www.boc.lk/personal-banking/card-offers/utility-insurance', sourceType: 'html', detailRequired: true },
  { id: 5, name: 'Education', slug: 'education', url: 'https://www.boc.lk/personal-banking/card-offers/education', sourceType: 'html', detailRequired: true },
  { id: 6, name: 'Zero Plans', slug: 'zero-plans', url: 'https://www.boc.lk/personal-banking/card-offers/zero-plans', sourceType: 'html', detailRequired: true },
  { id: 7, name: 'Online', slug: 'online', url: 'https://www.boc.lk/personal-banking/card-offers/online', sourceType: 'html', detailRequired: true },
  { id: 8, name: 'Fashion', slug: 'fashion', url: 'https://www.boc.lk/personal-banking/card-offers/fashion', sourceType: 'html', detailRequired: true },
  { id: 9, name: 'Health & Beauty', slug: 'health-beauty', url: 'https://www.boc.lk/personal-banking/card-offers/health-beauty', sourceType: 'html', detailRequired: true },
  { id: 10, name: 'Automobile', slug: 'automobile', url: 'https://www.boc.lk/personal-banking/card-offers/automobile', sourceType: 'html', detailRequired: true },
  { id: 11, name: 'Dining', slug: 'dining', url: 'https://www.boc.lk/personal-banking/card-offers/dining', sourceType: 'html', detailRequired: true },
  { id: 12, name: 'Mastercard Offers', slug: 'mastercard-offers', url: 'https://www.boc.lk/personal-banking/card-offers/mastercard-offers', sourceType: 'html', detailRequired: true },
  { id: 13, name: 'VISA Offers', slug: 'visa-offers', url: 'https://www.boc.lk/personal-banking/card-offers/visa-offers', sourceType: 'html', detailRequired: true },
];

// ─── People's Bank ────────────────────────────────────────────────────────────

// Site restructured (observed 2026-07): offers now live under
// /promotion-category/<slug>/?cardType=credit_card|debit_card with hubs at
// /special-offers/ (credit) and /special-offers-debit/ (debit).
// Check the hub pages when categories drift.
const PB = 'https://www.peoplesbank.lk/promotion-category';

function peoplesCategory(id: number, name: string, slug: string, cardType: 'credit' | 'debit' | 'both'): BankCategory {
  const urls = [];
  if (cardType === 'credit' || cardType === 'both') urls.push(`${PB}/${slug}/?cardType=credit_card`);
  if (cardType === 'debit' || cardType === 'both') urls.push(`${PB}/${slug}/?cardType=debit_card`);
  return { id, name, slug, url: urls[0], urls, sourceType: 'html', cardType, detailRequired: true };
}

export const PEOPLES_CATEGORIES: BankCategory[] = [
  peoplesCategory(1, 'Wellness', 'wellness', 'both'),
  peoplesCategory(2, 'Leisure', 'leisure', 'both'),
  peoplesCategory(3, 'Restaurants', 'restaurants', 'both'),
  peoplesCategory(4, 'Online Stores', 'online-stores', 'both'),
  peoplesCategory(5, 'Home Care & Electronics', 'home-care-electronics', 'credit'),
  peoplesCategory(6, 'Supermarkets', 'supermarkets', 'both'),
  peoplesCategory(7, 'Jewellery', 'jewellers', 'credit'),
  peoplesCategory(8, 'Auto Mobile', 'auto-mobile', 'both'),
  peoplesCategory(9, 'Travel', 'travel', 'credit'),
  peoplesCategory(10, 'Visa', 'visa', 'credit'),
  peoplesCategory(11, 'Clothing', 'clothing', 'credit'),
  peoplesCategory(12, 'Others', 'others', 'credit'),
];

// ─── Seylan ───────────────────────────────────────────────────────────────────

export const SEYLAN_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Clothing', slug: 'style', url: 'https://www.seylan.lk/promotions/cards/style', sourceType: 'html', detailRequired: true },
  { id: 2, name: 'Salon & SPA', slug: 'salon-spa', url: 'https://www.seylan.lk/promotions/cards/salon-spa', sourceType: 'html', detailRequired: true },
  { id: 3, name: 'Kiddies', slug: 'kiddies', url: 'https://www.seylan.lk/promotions/cards/kiddies', sourceType: 'html', detailRequired: true },
  { id: 4, name: 'Special Promotions', slug: 'special-promotions', url: 'https://www.seylan.lk/promotions/cards/special-promotions', sourceType: 'html', detailRequired: true },
  { id: 5, name: 'Local Travel', slug: 'local-travel', url: 'https://www.seylan.lk/promotions/cards/local-travel', sourceType: 'html', detailRequired: true },
  { id: 6, name: 'Dining', slug: 'dining', url: 'https://www.seylan.lk/promotions/cards/dining', sourceType: 'html', detailRequired: true },
  { id: 7, name: 'Online Deals', slug: 'online-deals', url: 'https://www.seylan.lk/promotions/cards/online-deals', sourceType: 'html', detailRequired: true },
  { id: 8, name: 'Cracker Deals', slug: 'cracker-deals', url: 'https://www.seylan.lk/promotions/cards/cracker-deals', sourceType: 'html', detailRequired: true },
  { id: 9, name: 'Pay Plans', slug: 'pay-plans', url: 'https://www.seylan.lk/promotions/cards/pay-plans', sourceType: 'html', detailRequired: true },
  { id: 10, name: 'Auto', slug: 'auto', url: 'https://www.seylan.lk/promotions/cards/auto', sourceType: 'html', detailRequired: true },
  { id: 11, name: 'Overseas Travel', slug: 'overseas-travel', url: 'https://www.seylan.lk/promotions/cards/overseas-travel', sourceType: 'html', detailRequired: true },
  { id: 12, name: 'Education', slug: 'education', url: 'https://www.seylan.lk/promotions/cards/education', sourceType: 'html', detailRequired: true },
  { id: 13, name: 'Electronics', slug: 'electronics', url: 'https://www.seylan.lk/promotions/cards/electronics', sourceType: 'html', detailRequired: true },
  { id: 14, name: 'Supermarket', slug: 'supermarket', url: 'https://www.seylan.lk/promotions/cards/supermarket', sourceType: 'html', detailRequired: true },
  { id: 15, name: 'Lifestyle', slug: 'lifestyle', url: 'https://www.seylan.lk/promotions/cards/lifestyle', sourceType: 'html', detailRequired: true },
  { id: 16, name: 'Solar', slug: 'solar', url: 'https://www.seylan.lk/promotions/cards/solar', sourceType: 'html', detailRequired: true },
  { id: 17, name: 'Wellness', slug: 'wellness', url: 'https://www.seylan.lk/promotions/cards/wellness', sourceType: 'html', detailRequired: true },
  { id: 18, name: 'Insurance', slug: 'insurance', url: 'https://www.seylan.lk/promotions/cards/insurance', sourceType: 'html', detailRequired: true },
  { id: 19, name: 'Eye Care', slug: 'eye-care', url: 'https://www.seylan.lk/promotions/cards/eye-care', sourceType: 'html', detailRequired: true },
  { id: 20, name: 'Accelerate Savings', slug: 'accelerate', url: 'https://www.seylan.lk/promotions/accelerate', sourceType: 'html', detailRequired: true },
  { id: 21, name: 'Health', slug: 'health', url: 'https://www.seylan.lk/promotions/cards/health', sourceType: 'html', detailRequired: true },
  { id: 22, name: 'Jewelry', slug: 'jewelry', url: 'https://www.seylan.lk/promotions/cards/jewelry', sourceType: 'html', detailRequired: true },
  { id: 23, name: 'Affinity Cards', slug: 'affinity-cards', url: 'https://www.seylan.lk/promotions/cards/affinity-cards', sourceType: 'html', detailRequired: true },
  { id: 24, name: 'Harasara', slug: 'harasara', url: 'https://www.seylan.lk/promotions/cards/harasara', sourceType: 'html', detailRequired: true },
  // Catch-all LAST: the hub paginates through every offer, so offers in
  // removed/renamed categories are still captured. Dedupe keeps categorized
  // copies because Seylan uniqueIds derive from the detail-page slug.
  { id: 99, name: 'All', slug: '', url: 'https://www.seylan.lk/promotions/cards', sourceType: 'html', detailRequired: true },
];

// ─── NDB ──────────────────────────────────────────────────────────────────────

export const NDB_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Privilege Weekend', slug: 'privilege-weekend', url: 'https://www.ndbbank.com/cards/card-offers/privilege-weekend', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 2, name: 'Clothing & Accessories', slug: 'clothing-accessories', url: 'https://www.ndbbank.com/cards/card-offers/clothing-accessories', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 3, name: 'Restaurants & Pubs', slug: 'restaurants-pubs', url: 'https://www.ndbbank.com/cards/card-offers/restaurants-pubs', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 4, name: 'Special Promotions', slug: 'special-ipp-promotions', url: 'https://www.ndbbank.com/cards/card-offers/special-ipp-promotions', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 5, name: 'Supermarkets', slug: 'supermarkets', url: 'https://www.ndbbank.com/cards/card-offers/supermarkets', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 6, name: 'Jewellery & Watches', slug: 'jewellery-watches', url: 'https://www.ndbbank.com/cards/card-offers/jewellery-watches', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 7, name: 'Hotels & Villas', slug: 'hotels-villas', url: 'https://www.ndbbank.com/cards/card-offers/hotels-villas', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 8, name: 'Hospital & Healthcare', slug: 'hospital-healthcare', url: 'https://www.ndbbank.com/cards/card-offers/hospital-healthcare', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 9, name: 'Wellness & Beautycare', slug: 'wellness-beautycare', url: 'https://www.ndbbank.com/cards/card-offers/wellness-beautycare', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 10, name: 'Online Stores', slug: 'online-stores', url: 'https://www.ndbbank.com/cards/card-offers/online-stores', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 11, name: 'Mastercard Credit Card', slug: 'mastercard-credit-card', url: 'https://www.ndbbank.com/cards/card-offers/mastercard-credit-card', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 12, name: 'Education', slug: 'education', url: 'https://www.ndbbank.com/cards/card-offers/education', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 13, name: 'Solar, Housing & Construction', slug: 'solar-housing-construction', url: 'https://www.ndbbank.com/cards/card-offers/solar-housing-construction', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 14, name: 'Entertainment & Outdoor Activities', slug: 'entertainment-outdoor-activities', url: 'https://www.ndbbank.com/cards/card-offers/entertainment-outdoor-activities', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 15, name: 'Automobile', slug: 'automobile', url: 'https://www.ndbbank.com/cards/card-offers/automobile', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 16, name: 'Insurance', slug: 'insurance', url: 'https://www.ndbbank.com/cards/card-offers/insurance', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 17, name: 'VISA Offers', slug: 'visa-offers', url: 'https://www.ndbbank.com/cards/card-offers/visa-offers', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 18, name: 'Travel', slug: 'travel', url: 'https://www.ndbbank.com/cards/card-offers/travel', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  // Catch-all LAST: the hub renders every offer (105 as of July 2026), so
  // offers in renamed/removed categories are still captured. Dedupe keeps the
  // categorized copies because NDB uniqueIds derive from the offer-details id.
  { id: 99, name: 'All', slug: '', url: 'https://www.ndbbank.com/cards/card-offers', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
];

// ─── DFCC ─────────────────────────────────────────────────────────────────────

export const DFCC_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Supermarkets', slug: 'supermarket', url: 'https://www.dfcc.lk/promotions-categories/supermarket/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 2, name: 'Dining', slug: 'dining', url: 'https://www.dfcc.lk/promotions-categories/dining/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 3, name: '0% Easy Payment Plans', slug: '0-easy-payment-plans', url: 'https://www.dfcc.lk/promotions-categories/0-easy-payment-plans/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 4, name: 'Pinnacle', slug: 'pinnacle', url: 'https://www.dfcc.lk/pinnacle-2', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 5, name: 'Online', slug: 'online', url: 'https://www.dfcc.lk/promotions-categories/online/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 6, name: 'Utility', slug: 'utility', url: 'https://www.dfcc.lk/promotions-categories/utility/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 7, name: 'Clothing and Retail', slug: 'clothing__retail', url: 'https://www.dfcc.lk/promotions-categories/clothing__retail/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 8, name: 'Hotels', slug: 'hotels', url: 'https://www.dfcc.lk/promotions-categories/hotels/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 9, name: 'Home Appliances', slug: 'home-appliances', url: 'https://www.dfcc.lk/promotions-categories/home-appliances/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 10, name: 'Autocare', slug: 'autocare', url: 'https://www.dfcc.lk/autocare-promotion', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 11, name: 'Travel', slug: 'travel', url: 'https://www.dfcc.lk/travel-promotion', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 12, name: 'Healthcare & Insurance', slug: 'healthcare-insurance', url: 'https://www.dfcc.lk/promotions-categories/healthcare-insurance/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 13, name: 'Jewellery', slug: 'jewellery', url: 'https://www.dfcc.lk/promotions-categories/jewellery/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 14, name: 'Footwear', slug: 'footwear', url: 'https://www.dfcc.lk/promotions-categories/footwear/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 15, name: 'VISA Offers', slug: 'visa-offers', url: 'https://www.dfcc.lk/promotions-categories/visa-offers/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 16, name: 'Mastercard Offers', slug: 'mastercard-offers', url: 'https://www.dfcc.lk/promotions-categories/mastercard-offers/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 17, name: 'Opticians', slug: 'opticians', url: 'https://www.dfcc.lk/promotions-categories/opticians/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 18, name: 'Aloka Offers', slug: 'aloka', url: 'https://www.dfcc.lk/promotions-categories/aloka/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 19, name: 'Holidays', slug: 'holidays', url: 'https://www.dfcc.lk/promotions-categories/holidays/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 20, name: 'Gifts & Wellness', slug: 'gift_wellness', url: 'https://www.dfcc.lk/promotions-categories/gift_wellness/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 21, name: 'Education', slug: 'education', url: 'https://www.dfcc.lk/promotions-categories/education/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 22, name: 'Entertainment', slug: 'entertainment', url: 'https://www.dfcc.lk/promotions-categories/entertainment/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 23, name: 'Solar Offers', slug: 'solar-offers', url: 'https://www.dfcc.lk/promotions-categories/solar-offers/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  { id: 24, name: 'Other', slug: 'other', url: 'https://www.dfcc.lk/promotions-categories/other/', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
  // Catch-all LAST: several /promotions-categories/<slug>/ URLs 404 (site
  // migrated some categories to standalone slugs like /pinnacle-2,
  // /autocare-promotion, /travel-promotion — those three were corrected
  // above; the rest may just be empty right now). This "today's promotions"
  // page is confirmed live and renders a.cardd, so it catches offers whose
  // category page has drifted without needing to guess every slug.
  { id: 99, name: 'All', slug: '', url: 'https://www.dfcc.lk/dfcc-card-offers/today-promotions', sourceType: 'headless-browser', browserRequired: true, pdfRequired: true },
];

// ─── Pan Asia ─────────────────────────────────────────────────────────────────

// The site has ONE offers page (/card-offers/) with a client-side category
// filter bar — there are no separate per-category URLs, and most filter
// tags currently match zero offers (confirmed live 2026-08-01: 28 offers
// total, skewed toward installment-plan tie-ups and Oak Ray/Cinnamon hotel
// discounts). PABCScraper overrides `categories` with a single runtime
// entry pointing at /card-offers/ — this list exists only for
// getBankConfig() reporting and is not used to drive per-category fetches.
export const PABC_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Card Offers', slug: 'card-offers', url: 'https://www.pabcbank.com/card-offers/', sourceType: 'headless-browser', browserRequired: true },
];

// ─── NSB ──────────────────────────────────────────────────────────────────────
// WordPress site; single listing paginates via /category/card-offers/page/N/
// (verified live 2026-07-19). No sub-categories exist on the site itself.

export const NSB_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Card Offers', slug: 'card-offers', url: 'https://www.nsb.lk/category/card-offers/', sourceType: 'html', detailRequired: true },
];

// ─── Commercial Bank (ComBank) ─────────────────────────────────────────────────
// Every category lives on ONE listing page as `.offers-row` blocks — unlike
// DFCC/NDB/People's there is no per-category URL. Verified live 2026-08-01.

export const COMBANK_CATEGORIES: BankCategory[] = [
  { id: 1, name: 'Rewards & Promotions', slug: 'rewards-promotions', url: 'https://www.combank.lk/rewards-promotions', sourceType: 'html', detailRequired: true },
];

// ─── Registry ─────────────────────────────────────────────────────────────────

export const BANK_CATEGORIES: Record<BankName, BankCategory[]> = {
  hnb: HNB_CATEGORIES,
  sampath: SAMPATH_CATEGORIES,
  boc: BOC_CATEGORIES,
  peoples: PEOPLES_CATEGORIES,
  seylan: SEYLAN_CATEGORIES,
  ndb: NDB_CATEGORIES,
  dfcc: DFCC_CATEGORIES,
  pabc: PABC_CATEGORIES,
  nsb: NSB_CATEGORIES,
  combank: COMBANK_CATEGORIES,
};

export const BANK_CONFIGS: Record<BankName, BankConfig> = {
  hnb: {
    bank: 'hnb',
    displayName: 'HNB',
    categories: HNB_CATEGORIES,
    outputPrefix: 'hnb',
    sourceType: 'json-api',
    activeBaseScript: 'hnb-9.js',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  sampath: {
    bank: 'sampath',
    displayName: 'Sampath',
    categories: SAMPATH_CATEGORIES,
    outputPrefix: 'sampath',
    sourceType: 'mixed',
    activeBaseScript: 'sampath-7.js',
    notes: 'API listing with optional HTML detail pages for addresses, terms, and images.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  boc: {
    bank: 'boc',
    displayName: 'BOC',
    categories: BOC_CATEGORIES,
    outputPrefix: 'boc',
    sourceType: 'html',
    activeBaseScript: 'boc-7.js',
    notes: 'HTML category listings with Cheerio detail extraction.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  peoples: {
    bank: 'peoples',
    displayName: "People's Bank",
    categories: PEOPLES_CATEGORIES,
    outputPrefix: 'peoples',
    sourceType: 'mixed',
    activeBaseScript: 'people-5.js',
    notes: 'HTML listings/details with optional PDF terms extraction.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  seylan: {
    bank: 'seylan',
    displayName: 'Seylan',
    categories: SEYLAN_CATEGORIES,
    outputPrefix: 'seylan',
    sourceType: 'html',
    activeBaseScript: 'seylan-4.js',
    notes: 'HTML category listings with parallel detail scraping.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  ndb: {
    bank: 'ndb',
    displayName: 'NDB',
    categories: NDB_CATEGORIES,
    outputPrefix: 'ndb',
    sourceType: 'headless-browser',
    activeBaseScript: 'ndb-5.js',
    notes: 'Rendered Next.js/card UI scraped with browser automation; optional PDF terms.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  dfcc: {
    bank: 'dfcc',
    displayName: 'DFCC',
    categories: DFCC_CATEGORIES,
    outputPrefix: 'dfcc',
    sourceType: 'headless-browser',
    activeBaseScript: 'dfcc.js',
    notes: 'Rendered card layout with browser automation and optional PDF extraction.',
    capabilities: { scrape: true, geocode: false, llmValidation: true },
  },
  pabc: {
    bank: 'pabc',
    displayName: 'Pan Asia',
    categories: PABC_CATEGORIES,
    outputPrefix: 'pabc',
    sourceType: 'headless-browser',
    activeBaseScript: 'panasia-2.js',
    notes: 'Browser-based scraper in base repo. Runtime scraper uses https://www.pabcbank.com/card-offers/ as the canonical card-offers page.',
    capabilities: { scrape: true, geocode: false, llmValidation: true },
  },
  nsb: {
    bank: 'nsb',
    displayName: 'NSB',
    categories: NSB_CATEGORIES,
    outputPrefix: 'nsb',
    sourceType: 'html',
    notes: 'WordPress listing + detail pages, no labeled fields — merchant/period/address all mined from free-text prose.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
  combank: {
    bank: 'combank',
    displayName: 'Commercial Bank',
    categories: COMBANK_CATEGORIES,
    outputPrefix: 'combank',
    sourceType: 'html',
    notes: 'Single listing page grouped into per-category offers-row blocks; detail pages split terms into named sections.',
    capabilities: { scrape: true, geocode: true, llmValidation: true },
  },
};

export function listBanks(): BankName[] {
  return Object.keys(BANK_CONFIGS) as BankName[];
}

export function listBanksByCapability(capability: BankCapability): BankName[] {
  return listBanks().filter((bank) => BANK_CONFIGS[bank].capabilities[capability]);
}

export function getBankConfig(bankName: string): BankConfig {
  const normalized = bankName.toLowerCase() as BankName;
  const config = BANK_CONFIGS[normalized];
  if (!config) {
    throw new Error(`Unknown bank: ${bankName}. Available: ${listBanks().join(', ')}`);
  }
  return config;
}

export function isBankName(bankName: string): bankName is BankName {
  return Object.prototype.hasOwnProperty.call(BANK_CONFIGS, bankName.toLowerCase());
}
