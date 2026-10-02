#!/usr/bin/env ts-node
/**
 * Seeds parser_golden_cases table with realistic edge cases across Sri Lankan banks.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/infrastructure/db/seed-golden-cases.ts
 */

import 'dotenv/config';
import { pool } from './db-client';

export const GOLDEN_CASE_SEED = [
  {
    bank: 'hnb',
    field: 'discount_pct',
    expected_value: '25',
    offer_title: 'Hilton Colombo Dining Discount',
    raw_snippet: 'Merchant: Hilton Colombo\nOffer: 25% off on food and beverages',
    notes: 'HNB Dining 25% discount extraction',
  },
  {
    bank: 'hnb',
    field: 'discount_pct',
    expected_value: '20',
    offer_title: 'Aminra Jewellers Gold Discount',
    raw_snippet: 'Merchant: Aminra Jewellers\nOffer: 20% off on gold jewellery',
    notes: 'HNB Jewellery percentage discount',
  },
  {
    bank: 'hnb',
    field: 'card_types',
    expected_value: 'credit',
    offer_title: 'HNB Visa Infinite and Signature Cards',
    raw_snippet: 'Valid for HNB Visa Infinite and Signature Credit Cards',
    notes: 'Credit card type detection',
  },
  {
    bank: 'hnb',
    field: 'booking_required',
    expected_value: 'true',
    offer_title: 'Cinnamon Lakeside Advance Booking',
    raw_snippet: 'Prior reservation is required. Call 011-2345678',
    notes: 'Reservation requirement keyword',
  },
  {
    bank: 'hnb',
    field: 'transaction_min',
    expected_value: '5000',
    offer_title: 'Odel Minimum Spend',
    raw_snippet: 'Minimum bill value: Rs. 5,000 to be eligible',
    notes: 'Minimum bill amount extraction',
  },
  {
    bank: 'hnb',
    field: 'transaction_max',
    expected_value: '50000',
    offer_title: 'Spencers Maximum Spend Cap',
    raw_snippet: 'Maximum bill value: Rs. 50,000 per card',
    notes: 'Maximum transaction limit extraction',
  },
  {
    bank: 'boc',
    field: 'discount_pct',
    expected_value: '15',
    offer_title: 'Cargills Food City Grocery Savings',
    raw_snippet: '15% discount on total bill at Cargills Food City for BOC cards',
    notes: 'BOC supermarket discount',
  },
  {
    bank: 'boc',
    field: 'card_types',
    expected_value: 'debit',
    offer_title: 'BOC Debit Card Special',
    raw_snippet: 'Available exclusively for BOC Mastercard Debit cardholders',
    notes: 'Debit card keyword extraction',
  },
  {
    bank: 'boc',
    field: 'booking_required',
    expected_value: 'true',
    offer_title: 'Jetwing Hotels Prior Booking',
    raw_snippet: 'Prior booking is mandatory before arrival',
    notes: 'Prior booking detection',
  },
  {
    bank: 'sampath',
    field: 'discount_pct',
    expected_value: '20',
    offer_title: 'Keells Super Fresh Produce Savings',
    raw_snippet: 'Get up to 20% savings on fresh produce at Keells Super',
    notes: 'Sampath up to discount',
  },
  {
    bank: 'sampath',
    field: 'booking_required',
    expected_value: 'true',
    offer_title: 'Aitken Spence Hotel Reservation',
    raw_snippet: 'Advance reservation is required through hotel reservations desk',
    notes: 'Advance reservation detection',
  },
  {
    bank: 'sampath',
    field: 'transaction_min',
    expected_value: '3500',
    offer_title: 'Glomark Supermarket Promotion',
    raw_snippet: 'Rs. 3,500 minimum spend to qualify for discount',
    notes: 'Minimum transaction extraction',
  },
  {
    bank: 'peoples',
    field: 'discount_pct',
    expected_value: '30',
    offer_title: 'Cinnamon Grand Weekend Dining',
    raw_snippet: 'Merchant: Cinnamon Grand\nOffer: 30% off on weekend buffet',
    notes: 'Peoples Bank dining discount',
  },
  {
    bank: 'peoples',
    field: 'card_types',
    expected_value: 'credit',
    offer_title: 'Peoples Bank Credit Card Exclusive',
    raw_snippet: "Valid only for People's Bank Credit Card holders",
    notes: 'Credit card type detection',
  },
  {
    bank: 'nsb',
    field: 'discount_pct',
    expected_value: '30',
    offer_title: 'Hayleys Hotels NSB Debit Promotion',
    raw_snippet: 'Enjoy upto 30% off at Hayleys hotels with your NSB Mastercard Debit Card',
    notes: 'NSB up to discount and debit card',
  },
  {
    bank: 'nsb',
    field: 'card_types',
    expected_value: 'debit',
    offer_title: 'NSB Debit Card Everyday Offer',
    raw_snippet: 'Exclusive for NSB Mastercard Debit cardholders',
    notes: 'NSB debit card detection',
  },
  {
    bank: 'combank',
    field: 'discount_pct',
    expected_value: '25',
    offer_title: 'Pizza Hut ComBank Family Dining',
    raw_snippet: 'Special 25% off on dine-in orders',
    notes: 'ComBank dining discount',
  },
  {
    bank: 'combank',
    field: 'transaction_min',
    expected_value: '7500',
    offer_title: 'Arpico Supercentre Minimum Spend',
    raw_snippet: 'Rs. 7,500 minimum transaction required',
    notes: 'ComBank minimum transaction',
  },
  {
    bank: 'seylan',
    field: 'discount_pct',
    expected_value: '20',
    offer_title: "Domino's Pizza Seylan Discount",
    raw_snippet: "Merchant: Domino's Pizza\n20% off on all medium and large pizzas",
    notes: 'Seylan dining percentage',
  },
  {
    bank: 'dfcc',
    field: 'discount_pct',
    expected_value: '10',
    offer_title: 'Daraz Online Shopping Voucher',
    raw_snippet: '10% discount on online payments using DFCC credit cards',
    notes: 'DFCC e-commerce discount',
  },
  // Phase 4: Evidence-backed golden regression cases protecting real discovered failures
  {
    bank: 'nsb',
    field: 'merchant_name',
    expected_value: 'CIB Fashion',
    offer_title: 'CIB Fashion NSB Promotion',
    raw_snippet: 'Enjoy 10% off @ CIB Fashion with your NSB Mastercard Debit Card',
    notes: 'Phase 4: NSB merchant extraction with @ preposition',
  },
  {
    bank: 'nsb',
    field: 'merchant_name',
    expected_value: 'Amara Hotels',
    offer_title: 'Amara Hotels NSB Promotion',
    raw_snippet: 'Enjoy 20% off @ Amara Hotels with your NSB Mastercard Debit Card',
    notes: 'Phase 4: NSB hotel merchant extraction with @ preposition',
  },
  {
    bank: 'nsb',
    field: 'merchant_name',
    expected_value: 'National Savings Bank',
    offer_title: 'Women’s Day Cashback Promotion',
    raw_snippet: 'The Women’s Day Cashback Promotion is open to all NSB Sthree Savings Account holders',
    notes: 'Phase 4: NSB bank-internal promotional cashback without external partner',
  },
  {
    bank: 'combank',
    field: 'merchant_name',
    expected_value: 'Sri Lankan Airlines',
    offer_title: 'Sri Lankan Airlines ComBank Promotion',
    raw_snippet: 'Travel to your favourite destination with Sri Lankan Airlines using ComBank Credit Cards',
    notes: 'Phase 4: ComBank partner extraction with "with <Partner> using ComBank"',
  },
  {
    bank: 'combank',
    field: 'merchant_name',
    expected_value: 'FitsAir',
    offer_title: 'FitsAir ComBank Debit Promotion',
    raw_snippet: 'Visit your favourite holiday destination with FitsAir and ComBank Debit Cards',
    notes: 'Phase 4: ComBank partner extraction with "with <Partner> and ComBank"',
  },
  {
    bank: 'combank',
    field: 'merchant_name',
    expected_value: 'Abans',
    offer_title: 'Abans Super Sized Discounts',
    raw_snippet: 'Enjoy Super Sized Discounts from Abans with ComBank Credit and Debit Cards',
    notes: 'Phase 4: ComBank partner extraction with "from <Merchant> with ComBank"',
  },
  {
    bank: 'combank',
    field: 'merchant_name',
    expected_value: 'Commercial Bank',
    offer_title: 'Education Payment Facility',
    raw_snippet: 'Pay for your Education with ComBank Credit Cards',
    notes: 'Phase 4: ComBank bank-utility facility resolved to Commercial Bank',
  },
  {
    bank: 'boc',
    field: 'valid_to',
    expected_value: '2026-11-30',
    offer_title: 'BOC Credit Card Promo Range',
    raw_snippet: 'From 01st September to 30th November 2026 *Conditions apply.',
    notes: 'Phase 4: BOC explicit from-to range preventing start/end date inversion',
  },
  {
    bank: 'hnb',
    field: 'transaction_min',
    expected_value: '10000',
    offer_title: 'Glomark Supermarket Bill Value',
    raw_snippet: 'Minimum Bill Value - 10,000/- on total grocery purchase',
    notes: 'Phase 4: Transaction minimum without Rs. prefix and trailing /-',
  },
  {
    bank: 'peoples',
    field: 'excluded_cards',
    expected_value: '[]',
    offer_title: 'Peoples Bank Supermarket Exclusions',
    raw_snippet: '20% off on all items (excluding liquor, tobacco, milk powder and gift vouchers)',
    notes: 'Phase 4: Non-card exclusions filtered out from excludedCards',
  },
];

export async function seedGoldenCases(): Promise<number> {
  let seeded = 0;
  for (const c of GOLDEN_CASE_SEED) {
    const exists = await pool.query(
      `SELECT id FROM parser_golden_cases WHERE bank = $1 AND field = $2 AND expected_value = $3`,
      [c.bank, c.field, c.expected_value]
    );
    if (exists.rows.length === 0) {
      await pool.query(
        `INSERT INTO parser_golden_cases (bank, field, expected_value, offer_title, raw_snippet, notes, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [c.bank, c.field, c.expected_value, c.offer_title, c.raw_snippet, c.notes]
      );
      seeded++;
    }
  }
  return seeded;
}

async function main() {
  console.log('Seeding parser golden cases into Postgres…');
  const count = await seedGoldenCases();
  console.log(`Successfully seeded ${count} golden cases.`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
}
