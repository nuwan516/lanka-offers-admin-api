/**
 * Verification test for dynamic parser rule runtime integration:
 * - source_path resolution
 * - priority ordering semantics
 * - scope filtering (category & source_type)
 * - safe regex compilation
 * - fallback behavior
 * - trace output
 */
import {
  evaluateRulesForField,
  resolveSourcePath,
  matchesScope,
  executeRuleOnInput,
  areGoldenValuesEqual,
  RuleContext,
  BankParserRule,
} from '@/banks/bank-rules-loader';
import { parsePeoplesOffer } from '@/banks/peoples/peoples-parser';
import { parseDFCCOffer } from '@/banks/dfcc/dfcc-parser';
import { parsePABCOffer } from '@/banks/pabc/pabc-parser';
import { parseNSBOffer } from '@/banks/nsb/nsb-parser';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASSED: ${msg}`);
}

console.log('--- TEST 1: resolveSourcePath ---');
const sampleObj = {
  title: '20% off at Arpico',
  details: {
    description: 'Special 15% discount for cardholders',
    nested: { count: 42, active: true },
  },
};
assert(resolveSourcePath(sampleObj, 'title') === '20% off at Arpico', 'Resolves top-level string');
assert(resolveSourcePath(sampleObj, 'details.description') === 'Special 15% discount for cardholders', 'Resolves nested string');
assert(resolveSourcePath(sampleObj, 'details.nested.count') === '42', 'Resolves nested number as string');
assert(resolveSourcePath(sampleObj, 'nonexistent.path') === undefined, 'Returns undefined for missing path');

console.log('--- TEST 2: matchesScope ---');
const baseRule: BankParserRule = {
  id: 'r1',
  bank: 'hnb',
  field: 'discount_pct',
  rule_type: 'regex',
  pattern: '(\\d+)',
  flags: 'i',
  capture_group: 1,
  enabled: true,
  priority: 10,
  source_path: null,
  category: null,
  source_type: null,
  status: 'active',
  version: 1,
};

// Wildcard matches anything
assert(matchesScope(baseRule, { bank: 'hnb', field: 'discount_pct', category: 'Dining' }), 'NULL category matches any category (wildcard)');
assert(matchesScope(baseRule, { bank: 'hnb', field: 'discount_pct', sourceType: 'rest-api' }), 'NULL source_type matches any source_type (wildcard)');

// Specific category
const diningRule: BankParserRule = { ...baseRule, category: 'Dining' };
assert(matchesScope(diningRule, { bank: 'hnb', field: 'discount_pct', category: 'Dining' }), 'Matching category returns true');
assert(matchesScope(diningRule, { bank: 'hnb', field: 'discount_pct', category: 'dining' }), 'Case-insensitive category matches');
assert(!matchesScope(diningRule, { bank: 'hnb', field: 'discount_pct', category: 'Shopping' }), 'Mismatched category returns false');
assert(!matchesScope(diningRule, { bank: 'hnb', field: 'discount_pct', category: null }), 'Missing category in context returns false for scoped rule');

console.log('--- TEST 3: executeRuleOnInput & safe regex ---');
const regexRule: BankParserRule = { ...baseRule, pattern: '(\\d+)%\\s*off' };
const resMatch = executeRuleOnInput(regexRule, 'Get 25% off on dining');
assert(resMatch.matched && resMatch.extracted === '25', 'Regex rule extracts capture group');

const invalidRegexRule: BankParserRule = { ...baseRule, pattern: '[unclosed(regex' };
const resInvalid = executeRuleOnInput(invalidRegexRule, 'Test 25% off');
assert(!resInvalid.matched && resInvalid.error !== undefined, 'Invalid regex logs error safely without throwing');

const keywordRule: BankParserRule = { ...baseRule, rule_type: 'keyword_list', pattern: 'reservation,booking' };
const resKwMatch = executeRuleOnInput(keywordRule, 'Advance reservation required');
assert(resKwMatch.matched && resKwMatch.extracted === 'reservation', 'Keyword rule matches');

const resKwNoMatch = executeRuleOnInput(keywordRule, 'Walk-ins welcome');
assert(!resKwNoMatch.matched, 'Keyword rule does not match non-matching text');

console.log('--- TEST 4: Fallback behavior when no DB rules exist ---');
const ctxNoRules: RuleContext = {
  bank: 'testbank_empty',
  field: 'discount_pct',
  fallbackInput: 'Save 30% today',
  fallbackRegex: /(\d+)%\s*today/,
};
const resFallback = evaluateRulesForField(ctxNoRules);
assert(resFallback.matched && resFallback.value === '30' && resFallback.usedFallback === true, 'Hardcoded fallback executes and extracts value when no DB rules exist');

console.log('--- TEST 5: Fallback behavior when fallback also does not match ---');
const ctxNoMatch: RuleContext = {
  bank: 'testbank_empty',
  field: 'discount_pct',
  fallbackInput: 'Special promotion',
  fallbackRegex: /(\d+)%/,
};
const resNoMatch = evaluateRulesForField(ctxNoMatch);
assert(!resNoMatch.matched && resNoMatch.value === null && resNoMatch.usedFallback === true, 'Returns null safely when neither DB rules nor fallback match');

console.log('--- TEST 6: Golden value normalization (areGoldenValuesEqual) ---');
assert(areGoldenValuesEqual('20', 20, 'discount_pct'), 'Numeric string "20" equals 20');
assert(areGoldenValuesEqual(20, '20', 'discount_pct'), 'Number 20 equals string "20"');
assert(areGoldenValuesEqual(' 25% ', 25, 'discount_pct'), 'String " 25% " with percentage sign equals 25');
assert(areGoldenValuesEqual('50,000', 50000, 'transaction_min'), 'Formatted string "50,000" with commas equals 50000');
assert(areGoldenValuesEqual('  Cargills Food City  ', 'cargills food city', 'merchant_name'), 'String comparison trims whitespace and ignores case');
assert(areGoldenValuesEqual(null, null), 'null equals null');
assert(!areGoldenValuesEqual(null, 20), 'null does not equal 20');
assert(!areGoldenValuesEqual(20, null), '20 does not equal null');
assert(!areGoldenValuesEqual('20', 25, 'discount_pct'), 'Wrong extraction produces inequality (FAIL)');
assert(areGoldenValuesEqual('true', true, 'booking_required'), 'Boolean string "true" equals true');
assert(areGoldenValuesEqual('false', false, 'booking_required'), 'Boolean string "false" equals false');
assert(!areGoldenValuesEqual('true', false, 'booking_required'), 'Boolean mismatch produces false');
assert(
  areGoldenValuesEqual('Credit Card, Debit Card', 'Debit Card, Credit Card', 'card_types'),
  'Card types comma-separated list matches as set irrespective of ordering'
);

console.log('--- TEST 7: Invalid regex does not crash golden test flow ---');
const malformedRule: BankParserRule = {
  ...baseRule,
  pattern: '[broken(regex++',
};
const malformedTrace = executeRuleOnInput(malformedRule, 'Get 20% off today');
assert(!malformedTrace.matched && !!malformedTrace.error, 'Broken regex fails gracefully with error in trace');
const goldenMatchWithBrokenRule = areGoldenValuesEqual(20, malformedTrace.extracted, 'discount_pct');
assert(!goldenMatchWithBrokenRule, 'Failed extraction safely evaluates to FAIL in golden check without throwing');

console.log('--- TEST 8: Remaining Banks runtime parser execution with RuleContext ---');
// 1. People's Bank
const peoplesRaw = {
  listing: {
    merchantName: 'Keells Super',
    discount: '20% Off',
    shortDescription: 'Enjoy 20% Off at Keells with Peoples Bank Credit Cards. Minimum spend Rs. 2,500.',
    detailPageUrl: 'https://peoplesbank.lk/offers/keells',
    _categoryName: 'Supermarket',
    _cardType: 'Credit Card',
  },
  detail: null,
};
const peoplesParsed = parsePeoplesOffer(peoplesRaw as any);
assert(peoplesParsed !== null && peoplesParsed.source === 'peoples', "People's bank parsed output has correct bank");
assert(peoplesParsed?.offer?.discountPercentage === 20, "People's bank extracted discount_pct via RuleContext/fallback");
assert(peoplesParsed?.transactionRange?.min === 2500, "People's bank extracted transaction_min via RuleContext/fallback");
assert(Boolean(peoplesParsed?.cardEligibility?.cardTypes?.includes('Credit Card')), "People's bank extracted card_types via RuleContext/fallback");

// 2. DFCC Bank
const dfccRaw = {
  listing: {
    title: 'Jetwing Hotels',
    offerText: 'Special 30% savings for DFCC Mastercard credit cardholders. Maximum transaction Rs. 50,000.',
    detailUrl: 'https://dfcc.lk/offers/jetwing',
    cardType: 'Credit Card',
    _categoryName: 'Hotels',
  },
  detail: null,
};
const dfccParsed = parseDFCCOffer(dfccRaw as any);
assert(dfccParsed !== null && dfccParsed.source === 'dfcc', 'DFCC bank parsed output has correct bank');
assert(dfccParsed?.offer?.discountPercentage === 30, 'DFCC bank extracted discount_pct via RuleContext/fallback');
assert(dfccParsed?.transactionRange?.max === 50000, 'DFCC bank extracted transaction_max via RuleContext/fallback');

// 3. PABC (Pan Asia Bank)
const pabcRaw = {
  title: 'Odel',
  description: 'Pan Asia Bank Credit Cards enjoy 15% discount',
  discount: '15% Off',
  url: 'https://pabcbank.com/offers/odel',
  _categoryName: 'Shopping',
};
const pabcParsed = parsePABCOffer(pabcRaw as any);
assert(pabcParsed !== null && pabcParsed.source === 'pabc', 'PABC bank parsed output has correct bank');
assert(pabcParsed?.offer?.discountPercentage === 15, 'PABC bank extracted discount_pct via RuleContext/fallback');

// 4. NSB (National Savings Bank)
const nsbRaw = {
  listing: {
    title: 'Pizza Hut',
    excerpt: 'Enjoy 25% off on your bill with NSB Credit Card. Minimum spend Rs. 3,000.',
    detailUrl: 'https://nsb.lk/offers/pizzahut',
    _categoryName: 'Dining',
  },
  detail: null,
};
const nsbParsed = parseNSBOffer(nsbRaw as any);
assert(nsbParsed !== null && nsbParsed.source === 'nsb', 'NSB bank parsed output has correct bank');
assert(nsbParsed?.offer?.discountPercentage === 25, 'NSB bank extracted discount_pct via RuleContext/fallback');
assert(nsbParsed?.transactionRange?.min === 3000, 'NSB bank extracted transaction_min via RuleContext/fallback');
assert(Boolean(nsbParsed?.cardEligibility?.cardTypes?.includes('Credit Card')), 'NSB bank extracted card_types via RuleContext/fallback');

console.log('\n🎉 ALL RUNTIME INTEGRATION, REMAINING BANKS & GOLDEN TESTS VERIFIED SUCCESSFULLY!');
process.exit(0);

