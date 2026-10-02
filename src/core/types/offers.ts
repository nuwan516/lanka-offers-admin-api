//  Enums

export enum PeriodType {
  OFFER = 'offer',
  BOOKING = 'booking',
  STAY = 'stay',
  TRAVEL = 'travel',
  INSTALLMENT = 'installment',
  RESERVATION = 'reservation',
  EVENT = 'event',
}

export enum RecurrenceType {
  DAILY = 'daily',
  SPECIFIC_WEEKDAYS = 'specific_weekdays',
  SPECIFIC_DATES = 'specific_dates',
  MONTHLY_RANGE = 'monthly_range',
}

export enum LocationType {
  SINGLE = 'SINGLE',
  LISTED = 'LISTED',
  CHAIN = 'CHAIN',
  ONLINE = 'ONLINE',
  NONE = 'NONE',
}

//  Value Objects

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export interface TimeWindow {
  from: string; // HH:mm
  to: string; // HH:mm
}

export interface InstallmentPlan {
  months: number;
  interestRate: number; // percentage (0 = interest‑free)
  type: 'installment';
}

export interface TransactionRange {
  min: number | null;
  max: number | null;
  currency: 'LKR';
}

export interface CardEligibility {
  includedCards: string[];
  excludedCards: string[];
  cardTypes: string[]; // 'Credit Card', 'Debit Card'
  networks: string[]; // 'Visa', 'Mastercard'
  restrictions: string[];
}

export interface ImageInfo {
  url: string;
  alt: string;
  type: 'logo' | 'gallery' | 'unknown';
  localPath?: string;
}

//  Core Entities

export interface Merchant {
  name: string;
  location: string | null;
  addresses: string[];
  phone: string[];
  email: string[];
  website: string | null;
  logo: ImageInfo | null;
  geocodedLocations?: GeoLocation[];
}

export interface Validity {
  validFrom: string | null;
  validTo: string | null;
  periodType: PeriodType;
  recurrenceType: RecurrenceType;
  recurrenceDays: string[] | null;
  timeWindow: TimeWindow | null;
  exclusionDays: string[] | null;
  blackoutPeriods: DateRange[] | null;
  exclusionNotes: string | null;
  rawPeriodText: string;
}

export interface OfferDetails {
  description: string;
  discountPercentage: number | string | null;
  applicableCards: string[];
  bookingRequired: boolean;
  restrictions: string[];
  specialConditions: string[];
  generalTerms: string[];
}

export interface GeoLocation {
  originalAddress?: string;
  formattedAddress?: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  types?: string[];
  source: 'geocoding_api' | 'places_text_search';
  branchName?: string;
}

//  Aggregate Root

export interface Offer {
  uniqueId: string;
  source: string; // bank name: 'hnb', 'boc', etc.
  sourceId: string;
  sourceUrl: string | null;
  title: string;
  category: string;
  categoryId: number | null;
  cardType: string;
  scrapedAt: string; // ISO timestamp
  merchant: Merchant;
  offer: OfferDetails;
  installmentPlans: InstallmentPlan[];
  transactionRange: TransactionRange;
  cardEligibility: CardEligibility;
  images: { logo: ImageInfo | null; gallery: ImageInfo[]; images: ImageInfo[] };
  validityPeriods: Validity[];
  contentHash: string;
  rawHtml?: string;
}

//  Utility Types (optional)

export type Result<T> = { success: true; data: T } | { success: false; error: string };
