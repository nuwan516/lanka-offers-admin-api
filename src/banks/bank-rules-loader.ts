/**
 * Loads bank_parser_rules from Postgres once per process into a module-level
 * cache. Callers (parsers) read synchronously; the CLI/API preloads async.
 *
 * Rule precedence:
 *   For each (bank, field) the rules are ordered by priority ASC.
 *   The first enabled DB rule whose pattern compiles successfully wins.
 *   Disabled or missing rules leave the hardcoded TypeScript fallback in effect.
 *
 * Safety guarantees:
 *   - Invalid regex patterns are caught, logged as warnings, and skipped.
 *   - One bad rule never crashes a scrape run.
 *   - The cache can be selectively invalidated per-bank by the API on writes.
 */

import { pool } from '@/infrastructure/db/db-client';

export interface BankParserRule {
  id: string;
  bank: string;
  field: string;
  rule_type: 'regex' | 'field_map' | 'keyword_list' | 'constant';
  pattern: string | null;
  flags: string;
  capture_group: number;
  enabled: boolean;
  priority: number;
  source_path: string | null;
  category: string | null;
  source_type: string | null;
  status: string;
  version: number;
}

/**
 * Result returned by rule-application helpers for tracing / debugging.
 * Tests and the admin test endpoint can surface these fields.
 */
export interface RuleExecutionTrace {
  ruleId: string;
  ruleVersion: number;
  bank: string;
  field: string;
  priority: number;
  sourcePath: string | undefined;
  matched: boolean;
  input: string | undefined;
  extracted: string | null;
  error: string | undefined;
  durationMs: number;
  usedFallback: boolean;
}

/**
 * Context passed to rule evaluation to support source_path resolution,
 * category/sourceType scope filtering, and hardcoded fallbacks.
 */
export interface RuleContext {
  bank: string;
  field: string;
  category?: string | null;
  sourceType?: string | null;
  rawOffer?: Record<string, unknown> | unknown;
  fallbackInput?: string;
  fallbackRegex?: RegExp | null;
}

/**
 * Result of evaluating rules for a given (bank, field) context.
 */
export interface RuleExecutionResult {
  value: string | null;
  matched: boolean;
  usedFallback: boolean;
  ruleId: string | null;
  ruleVersion: number | null;
  trace: RuleExecutionTrace[];
}

// ─── Cache ───────────────────────────────────────────────────────────────────
// bank → field → rules ordered by priority ASC
const cache = new Map<string, Map<string, BankParserRule[]>>();
let tableExists: boolean | null = null;

async function checkTableExists(): Promise<boolean> {
  if (tableExists !== null) return tableExists;
  try {
    const res = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'bank_parser_rules'
       ) AS exists`,
    );
    tableExists = res.rows[0].exists;
  } catch {
    tableExists = false;
  }
  return tableExists;
}

/**
 * Preload all enabled, active rules for a bank into the cache.
 * Safe to call multiple times — uses cache if already loaded.
 */
export async function preloadBankRules(bank: string): Promise<void> {
  if (cache.has(bank)) return;
  try {
    const exists = await checkTableExists();
    if (!exists) { cache.set(bank, new Map()); return; }

    const res = await pool.query<BankParserRule>(
      `SELECT id, bank, field, rule_type, pattern, flags, capture_group,
              enabled, priority, source_path, category, source_type,
              status, version
       FROM bank_parser_rules
       WHERE bank = $1 AND enabled = true AND status = 'active'
       ORDER BY priority ASC`,
      [bank],
    );

    const byField = new Map<string, BankParserRule[]>();
    for (const row of res.rows) {
      const existing = byField.get(row.field) ?? [];
      existing.push(row);
      byField.set(row.field, existing);
    }
    cache.set(bank, byField);
  } catch {
    // DB unavailable — let parsers fall back to hardcoded patterns.
    cache.set(bank, new Map());
  }
}

/**
 * Invalidate the cache for one bank.
 * Called by the API whenever a parser rule for that bank is created/updated/deleted.
 * The next preloadBankRules() call will re-fetch from DB.
 */
export function invalidateBankRulesCache(bank: string): void {
  cache.delete(bank);
}

/** Clear the full cache (useful for tests or forced hot-reload). */
export function clearBankRulesCache(): void {
  cache.clear();
  tableExists = null;
}

// ─── Safe regex compilation ───────────────────────────────────────────────────

/**
 * Try to compile a RegExp from an admin-supplied pattern.
 * Returns null and logs a warning if the pattern is invalid.
 * NEVER throws — one bad admin rule must never crash a scrape.
 */
function safeCompileRegex(pattern: string, flags: string, ruleId: string): RegExp | null {
  try {
    return new RegExp(pattern, flags || 'i');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[RulesLoader] Rule ${ruleId}: invalid regex pattern "${pattern}" (flags="${flags}") — ${msg}. Using hardcoded fallback.`);
    return null;
  }
}

// ─── Path resolver ────────────────────────────────────────────────────────────

/**
 * Safely resolve a dot-separated path against an object.
 * No code execution. Returns undefined for missing/null paths.
 *
 * Supports:
 *   "description"              → obj.description
 *   "details.description"      → obj.details.description
 *   "offer.discountPercentage" → obj.offer.discountPercentage
 */
export function resolveSourcePath(obj: Record<string, unknown>, path: string): string | undefined {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) return undefined;
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  // Arrays/objects: stringify for text matching
  return JSON.stringify(current);
}

// ─── Scope filtering ──────────────────────────────────────────────────────────

/**
 * Check whether a rule matches the scope of the current context.
 * NULL or empty column values in rule mean wildcard (matches all).
 */
export function matchesScope(rule: BankParserRule, context: RuleContext): boolean {
  if (rule.category !== null && rule.category !== undefined && rule.category.trim() !== '') {
    if (!context.category || rule.category.trim().toLowerCase() !== context.category.trim().toLowerCase()) {
      return false;
    }
  }
  if (rule.source_type !== null && rule.source_type !== undefined && rule.source_type.trim() !== '') {
    if (!context.sourceType || rule.source_type.trim().toLowerCase() !== context.sourceType.trim().toLowerCase()) {
      return false;
    }
  }
  return true;
}

// ─── Single rule executor (shared by runtime, test, backtest) ──────────────────

/**
 * Execute a single rule against a prepared input string (and optional raw offer object).
 * Shared authoritative evaluation logic — avoids divergence between runtime and test/backtest.
 */
export function executeRuleOnInput(
  rule: BankParserRule,
  inputText: string,
  rawOffer?: unknown,
): { matched: boolean; extracted: string | null; error?: string } {
  try {
    if (rule.rule_type === 'regex') {
      if (!rule.pattern) {
        return { matched: false, extracted: null, error: 'No pattern configured' };
      }
      const re = safeCompileRegex(rule.pattern, rule.flags || 'i', rule.id);
      if (!re) {
        return { matched: false, extracted: null, error: `Invalid regex: ${rule.pattern}` };
      }
      const m = inputText.match(re);
      if (!m) {
        return { matched: false, extracted: null };
      }
      const group = rule.capture_group ?? 1;
      const extracted = m[group] ?? m[0] ?? null;
      return { matched: true, extracted };

    } else if (rule.rule_type === 'keyword_list') {
      if (!rule.pattern) {
        return { matched: false, extracted: null, error: 'No keywords configured' };
      }
      let keywords: string[];
      try {
        keywords = JSON.parse(rule.pattern) as string[];
      } catch {
        keywords = rule.pattern.split(',').map((k) => k.trim()).filter(Boolean);
      }
      const found = keywords.filter((kw) => {
        const re = safeCompileRegex(kw, 'i', rule.id);
        return re ? re.test(inputText) : false;
      });
      return {
        matched: found.length > 0,
        extracted: found.length > 0 ? found.join(', ') : null,
      };

    } else if (rule.rule_type === 'field_map') {
      if (!rule.pattern) {
        return { matched: false, extracted: null, error: 'No field name configured' };
      }
      if (rawOffer && typeof rawOffer === 'object') {
        const val = resolveSourcePath(rawOffer as Record<string, unknown>, rule.pattern);
        return { matched: val !== undefined, extracted: val ?? null };
      }
      return { matched: false, extracted: null, error: 'rawOffer object required for field_map' };

    } else if (rule.rule_type === 'constant') {
      return { matched: true, extracted: rule.pattern };
    }

    return { matched: false, extracted: null, error: `Unknown rule_type: ${rule.rule_type}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { matched: false, extracted: null, error: msg };
  }
}

// ─── Authoritative rule evaluation pipeline ────────────────────────────────────

/**
 * Authoritative evaluation path for rules of a (bank, field).
 *
 * Evaluation semantics:
 *   1. Rules are evaluated in priority ASC order.
 *   2. Scope filtering: rule.category and rule.source_type must match context if configured (NULL = wildcard).
 *   3. Input resolution: if rule.source_path is configured, it resolves against context.rawOffer.
 *      If source_path is missing on rawOffer, this rule is skipped and the next priority rule is evaluated.
 *      If no source_path is configured, context.fallbackInput is used.
 *   4. First matching rule wins (STOP — lower priority rules are not evaluated).
 *   5. If all DB rules fail or no DB rules exist, context.fallbackRegex is executed against context.fallbackInput.
 */
export function evaluateRulesForField(context: RuleContext): RuleExecutionResult {
  const rules = cache.get(context.bank)?.get(context.field) ?? [];
  const traces: RuleExecutionTrace[] = [];

  for (const rule of rules) {
    // 1. Scope filtering
    if (!matchesScope(rule, context)) {
      continue;
    }

    // 2. Input resolution
    let inputText: string | undefined;
    if (rule.source_path) {
      if (context.rawOffer && typeof context.rawOffer === 'object') {
        inputText = resolveSourcePath(context.rawOffer as Record<string, unknown>, rule.source_path);
        if (inputText === undefined) {
          // Missing source path on this offer -> skip rule, try next priority
          traces.push({
            ruleId: rule.id,
            ruleVersion: rule.version ?? 1,
            bank: context.bank,
            field: context.field,
            priority: rule.priority,
            sourcePath: rule.source_path,
            matched: false,
            input: undefined,
            extracted: null,
            error: `Source path "${rule.source_path}" not found on raw offer`,
            durationMs: 0,
            usedFallback: false,
          });
          continue;
        }
      } else {
        // Rule requires source_path but no rawOffer object is provided -> skip rule
        continue;
      }
    } else {
      inputText = context.fallbackInput;
    }

    if (inputText === undefined || inputText === null) {
      inputText = '';
    }

    const start = Date.now();
    const { matched, extracted, error } = executeRuleOnInput(rule, inputText, context.rawOffer);
    const durationMs = Date.now() - start;

    traces.push({
      ruleId: rule.id,
      ruleVersion: rule.version ?? 1,
      bank: context.bank,
      field: context.field,
      priority: rule.priority,
      sourcePath: rule.source_path ?? undefined,
      matched,
      input: inputText.substring(0, 300),
      extracted,
      error,
      durationMs,
      usedFallback: false,
    });

    if (matched && !error) {
      // First matching rule by priority wins! STOP — lower priority rules are NOT evaluated.
      return {
        value: extracted,
        matched: true,
        usedFallback: false,
        ruleId: rule.id,
        ruleVersion: rule.version ?? 1,
        trace: traces,
      };
    }
  }

  // No eligible DB rule succeeded — evaluate hardcoded fallback
  const fallbackStart = Date.now();
  const fallbackText = context.fallbackInput ?? '';
  if (context.fallbackRegex) {
    const m = fallbackText.match(context.fallbackRegex);
    const extracted = m ? (m[1] ?? m[0]) : null;
    const matched = extracted !== null;
    traces.push({
      ruleId: 'fallback',
      ruleVersion: 0,
      bank: context.bank,
      field: context.field,
      priority: 9999,
      sourcePath: undefined,
      matched,
      input: fallbackText.substring(0, 300),
      extracted,
      error: undefined,
      durationMs: Date.now() - fallbackStart,
      usedFallback: true,
    });
    return {
      value: extracted,
      matched,
      usedFallback: true,
      ruleId: 'fallback',
      ruleVersion: 0,
      trace: traces,
    };
  }

  return {
    value: null,
    matched: false,
    usedFallback: true,
    ruleId: null,
    ruleVersion: null,
    trace: traces,
  };
}

// ─── Rule application helpers (called by bank parsers) ─────────────────────────

/**
 * Apply ordered regex rules for (bank, field).
 * Supports optional RuleContext to resolve source_path and scope filter at runtime.
 * Falls back to `fallback` regex if no DB rule matches.
 */
export function applyRegexRuleWithTrace(
  bank: string,
  field: string,
  text: string,
  fallback: RegExp | null,
  context?: Partial<RuleContext>,
): [string | null, RuleExecutionTrace | null] {
  const result = evaluateRulesForField({
    bank,
    field,
    fallbackInput: text,
    fallbackRegex: fallback,
    ...context,
  });
  const winningTrace = result.trace.find(t => t.matched) ?? result.trace[result.trace.length - 1] ?? null;
  return [result.value, winningTrace];
}

/**
 * Simplified wrapper — drops the trace for callers that only need the value.
 */
export function applyRegexRule(
  bank: string,
  field: string,
  text: string,
  fallback: RegExp | null,
  context?: Partial<RuleContext>,
): string | null {
  const result = evaluateRulesForField({
    bank,
    field,
    fallbackInput: text,
    fallbackRegex: fallback,
    ...context,
  });
  return result.value;
}

/**
 * Apply a keyword_list rule for (bank, field) against text.
 * Returns true if any keyword matches.
 */
export function applyKeywordRule(
  bank: string,
  field: string,
  text: string,
  fallback: RegExp | null,
  context?: Partial<RuleContext>,
): boolean {
  const result = evaluateRulesForField({
    bank,
    field,
    fallbackInput: text,
    fallbackRegex: fallback,
    ...context,
  });
  return result.matched;
}

/**
 * Return the constant value for (bank, field), or null if not configured.
 */
export function getConstantRule(bank: string, field: string): string | null {
  const rules = cache.get(bank)?.get(field) ?? [];
  for (const rule of rules) {
    if (rule.rule_type === 'constant') return rule.pattern;
  }
  return null;
}

/**
 * Apply a transaction rule (regex) and return as parsed integer.
 * Handles comma-separated numbers ("50,000" → 50000).
 */
export function applyTransactionRule(
  bank: string,
  field: 'transaction_min' | 'transaction_max',
  text: string,
  fallback: RegExp | null,
  context?: Partial<RuleContext>,
): number | null {
  const raw = applyRegexRule(bank, field, text, fallback, context);
  if (raw === null) return null;
  const n = parseInt(raw.replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

/**
 * Run a single rule against raw JSON for the admin test endpoint.
 * Uses the exact same executeRuleOnInput helper as the runtime evaluation path.
 * NEVER throws.
 */
export function testRuleAgainstRaw(
  rule: BankParserRule,
  rawOffer: Record<string, unknown>,
): RuleExecutionTrace {
  const start = Date.now();

  let inputText: string | undefined;
  if (rule.source_path) {
    inputText = resolveSourcePath(rawOffer, rule.source_path);
    if (inputText === undefined) {
      return {
        ruleId: rule.id,
        ruleVersion: rule.version ?? 1,
        bank: rule.bank,
        field: rule.field,
        priority: rule.priority,
        sourcePath: rule.source_path,
        matched: false,
        input: undefined,
        extracted: null,
        error: `Source path "${rule.source_path}" not found on raw offer`,
        durationMs: 0,
        usedFallback: false,
      };
    }
  } else {
    inputText = JSON.stringify(rawOffer);
  }

  const { matched, extracted, error } = executeRuleOnInput(rule, inputText, rawOffer);
  const durationMs = Date.now() - start;

  return {
    ruleId: rule.id,
    ruleVersion: rule.version ?? 1,
    bank: rule.bank,
    field: rule.field,
    priority: rule.priority,
    sourcePath: rule.source_path ?? undefined,
    matched,
    input: inputText.substring(0, 300),
    extracted,
    error,
    durationMs,
    usedFallback: false,
  };
}

// ─── Golden case comparison helper ─────────────────────────────────────────────

/**
 * Deterministic equality comparison for golden cases.
 * Handles representation differences (strings vs numbers, booleans, whitespace trimming).
 */
export function areGoldenValuesEqual(
  expected: unknown,
  actual: unknown,
  field?: string,
): boolean {
  // 1. Null / undefined equivalence
  const isExpNil = expected === null || expected === undefined || String(expected).trim() === '' || String(expected).trim().toLowerCase() === 'null';
  const isActNil = actual === null || actual === undefined || String(actual).trim() === '' || String(actual).trim().toLowerCase() === 'null';
  if (isExpNil && isActNil) return true;
  if (isExpNil !== isActNil) return false;

  const expStr = String(expected).trim();
  const actStr = String(actual).trim();

  // 2. Direct string match (trimmed, case-insensitive)
  if (expStr.toLowerCase() === actStr.toLowerCase()) return true;

  // 3. Numeric comparison (e.g. "20" === 20, "20%" === 20, "20.0" === 20, "50,000" === 50000)
  const cleanExp = expStr.replace(/%/g, '').replace(/,/g, '');
  const cleanAct = actStr.replace(/%/g, '').replace(/,/g, '');
  const numExp = parseFloat(cleanExp);
  const numAct = parseFloat(cleanAct);
  if (!isNaN(numExp) && !isNaN(numAct) && /^-?\d+(\.\d+)?$/.test(cleanExp) && /^-?\d+(\.\d+)?$/.test(cleanAct)) {
    return Math.abs(numExp - numAct) < 0.0001;
  }

  // 4. Boolean comparison ("true" === true, "false" === false)
  const boolValues = ['true', 'false', '1', '0', 'yes', 'no'];
  if (boolValues.includes(expStr.toLowerCase()) && boolValues.includes(actStr.toLowerCase())) {
    const bExp = expStr.toLowerCase() === 'true' || expStr === '1' || expStr.toLowerCase() === 'yes';
    const bAct = actStr.toLowerCase() === 'true' || actStr === '1' || actStr.toLowerCase() === 'yes';
    return bExp === bAct;
  }

  // 5. Comma-separated list comparison (e.g. card_types: "Credit Card, Debit Card")
  if (field === 'card_types' || expStr.includes(',') || actStr.includes(',')) {
    const expItems = expStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).sort();
    const actItems = actStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).sort();
    if (expItems.length === actItems.length && expItems.every((val, idx) => val === actItems[idx])) {
      return true;
    }
  }

  return false;
}

