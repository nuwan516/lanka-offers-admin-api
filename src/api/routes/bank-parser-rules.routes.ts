import { Router, Request, Response } from 'express';
import { bankParserRulesRepository } from '@/infrastructure/repositories/bank-parser-rules.repository';
import {
  BankParserRule,
  testRuleAgainstRaw,
  evaluateRulesForField,
  resolveSourcePath,
} from '@/banks/bank-rules-loader';

const router = Router();

function getCurrentNormalizedValue(
  field: string,
  offerRow: Record<string, unknown>,
  raw: Record<string, unknown>
): string | null {
  if (field === 'discount_pct') {
    if (offerRow.discount_percentage !== null && offerRow.discount_percentage !== undefined) {
      return String(offerRow.discount_percentage);
    }
    const rawOfferObj = (raw.offer ?? {}) as Record<string, unknown>;
    if (rawOfferObj.discountPercentage !== null && rawOfferObj.discountPercentage !== undefined) {
      return String(rawOfferObj.discountPercentage);
    }
    return null;
  }
  if (field === 'merchant_name') {
    if (offerRow.merchant_name) return String(offerRow.merchant_name);
    const rawMerchant = (raw.merchant ?? {}) as Record<string, unknown>;
    if (rawMerchant.name) return String(rawMerchant.name);
    return null;
  }
  if (field === 'merchant_location') {
    if (offerRow.merchant_location) return String(offerRow.merchant_location);
    const rawMerchant = (raw.merchant ?? {}) as Record<string, unknown>;
    if (rawMerchant.location) return String(rawMerchant.location);
    return null;
  }
  if (field === 'booking_required') {
    const rawOfferObj = (raw.offer ?? {}) as Record<string, unknown>;
    if (rawOfferObj.bookingRequired !== undefined && rawOfferObj.bookingRequired !== null) {
      return String(rawOfferObj.bookingRequired);
    }
    return null;
  }
  if (field === 'card_types') {
    if (offerRow.card_type) return String(offerRow.card_type);
    const cardElig = (raw.cardEligibility ?? {}) as Record<string, unknown>;
    if (Array.isArray(cardElig.cardTypes) && cardElig.cardTypes.length > 0) {
      return cardElig.cardTypes.join(', ');
    }
    return null;
  }
  if (field === 'transaction_min') {
    const tx = (raw.transactionRange ?? {}) as Record<string, unknown>;
    if (tx.min !== null && tx.min !== undefined) return String(tx.min);
    return null;
  }
  if (field === 'transaction_max') {
    const tx = (raw.transactionRange ?? {}) as Record<string, unknown>;
    if (tx.max !== null && tx.max !== undefined) return String(tx.max);
    return null;
  }
  if (raw[field] !== undefined && raw[field] !== null) return String(raw[field]);
  return null;
}

function normalizeValForCompare(val: string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  const trimmed = String(val).trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  const num = parseFloat(trimmed.replace(/%/g, ''));
  if (!isNaN(num) && /^-?\d+(\.\d+)?%?$/.test(trimmed)) {
    return String(num);
  }
  return trimmed.toLowerCase();
}

interface RegressionCandidate {
  uniqueId: string;
  title: string;
  rawSourceValue: string | null;
  currentValue: string | null;
  ruleResult: string | null;
  ruleId: string;
  ruleVersion: number;
  classification: 'CHANGED' | 'NEW_NULL' | 'ERROR';
}

interface FieldBacktestSummary {
  field: string;
  ruleId: string;
  samples: number;
  matched: number;
  unchanged: number;
  changed: number;
  newValues: number;
  newNulls: number;
  noMatch: number;
  errors: number;
  regressionCandidates: RegressionCandidate[];
}

router.get('/bank-parser-rules', async (req: Request, res: Response) => {
  const { bank } = req.query as Record<string, string>;
  const rows = await bankParserRulesRepository.getRules(bank);
  res.json({ items: rows, total: rows.length });
});

router.post('/bank-parser-rules', async (req: Request, res: Response) => {
  const {
    bank, field, rule_type, pattern, flags, capture_group, notes,
    priority, source_path, category, source_type, status,
  } = req.body as Record<string, any>;

  if (!bank || !field || !rule_type) {
    res.status(400).json({ error: 'bank, field, and rule_type are required' });
    return;
  }

  const created = await bankParserRulesRepository.createRule({
    bank,
    field,
    rule_type,
    pattern,
    flags,
    capture_group,
    notes,
    priority,
    source_path,
    category,
    source_type,
    status,
  });

  res.status(201).json(created);
});

router.put('/bank-parser-rules/:id', async (req: Request, res: Response) => {
  const updated = await bankParserRulesRepository.updateRule(String(req.params.id), req.body);
  if (!updated) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json(updated);
});

router.delete('/bank-parser-rules/:id', async (req: Request, res: Response) => {
  const deletedId = await bankParserRulesRepository.deleteRule(String(req.params.id));
  if (!deletedId) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ deleted: deletedId });
});

router.post('/bank-parser-rules/:id/test', async (req: Request, res: Response) => {
  const rule = await bankParserRulesRepository.getRuleById(String(req.params.id));
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  const limit = parseInt((req.query.limit as string) ?? '20', 10);
  const offers = await bankParserRulesRepository.getOffersForTest(rule.bank, limit);

  const results: { unique_id: string; title: string; extracted: string | null; matched: boolean; trace?: unknown }[] = [];
  const includeTrace = req.query.trace === 'true';

  for (const row of offers) {
    const raw: Record<string, unknown> = typeof row.raw_offer === 'object' && row.raw_offer !== null
      ? (row.raw_offer as Record<string, unknown>)
      : {};
    const trace = testRuleAgainstRaw(rule, raw);
    results.push({
      unique_id: row.unique_id,
      title: row.title ?? '',
      extracted: trace.extracted,
      matched: trace.matched,
      ...(includeTrace ? { trace } : {}),
    });
  }

  const matchCount = results.filter((r) => r.matched).length;
  res.json({ total: results.length, matched: matchCount, unmatched: results.length - matchCount, results });
});

router.post('/bank-parser-rules/backtest', async (req: Request, res: Response) => {
  const { bank, limit: rawLimit } = req.body as { bank: string; limit?: number };
  if (!bank) {
    res.status(400).json({ error: 'bank is required' });
    return;
  }

  const limit = Math.min(rawLimit ?? 30, 100);
  const [allRules, offers] = await Promise.all([
    bankParserRulesRepository.getRules(bank),
    bankParserRulesRepository.getOffersForBacktest(bank, limit),
  ]);

  const activeRules = allRules.filter((r) => r.enabled && r.status === 'active');
  const rulesByField = new Map<string, BankParserRule[]>();
  for (const rule of activeRules) {
    const list = rulesByField.get(rule.field) ?? [];
    list.push(rule);
    rulesByField.set(rule.field, list);
  }

  const summaries: FieldBacktestSummary[] = [];

  for (const [field, fieldRules] of rulesByField.entries()) {
    const primaryRule = fieldRules[0];
    const summary: FieldBacktestSummary = {
      field,
      ruleId: primaryRule ? primaryRule.id : 'unknown',
      samples: offers.length,
      matched: 0,
      unchanged: 0,
      changed: 0,
      newValues: 0,
      newNulls: 0,
      noMatch: 0,
      errors: 0,
      regressionCandidates: [],
    };

    for (const offerRow of offers) {
      const raw: Record<string, unknown> = typeof offerRow.raw_offer === 'object' && offerRow.raw_offer !== null
        ? offerRow.raw_offer
        : {};

      const currentVal = getCurrentNormalizedValue(field, offerRow, raw);
      const evalResult = evaluateRulesForField({
        bank,
        field,
        category: offerRow.category,
        sourceType: null,
        rawOffer: raw,
      });

      const winningTrace = evalResult.trace.find((t) => t.matched);
      const ruleResult = evalResult.matched && !evalResult.usedFallback ? evalResult.value : null;
      const winningRuleId = evalResult.matched && !evalResult.usedFallback ? (evalResult.ruleId ?? 'none') : 'none';
      const winningRuleVersion = evalResult.matched && !evalResult.usedFallback ? (evalResult.ruleVersion ?? 1) : 1;

      const curNorm = normalizeValForCompare(currentVal);
      const ruleNorm = normalizeValForCompare(ruleResult);
      const hasError = evalResult.trace.some((t) => !!t.error && !t.matched);

      let classification: 'UNCHANGED' | 'CHANGED' | 'NEW_VALUE' | 'NEW_NULL' | 'NO_MATCH' | 'ERROR';

      if (hasError && !evalResult.matched) {
        classification = 'ERROR';
        summary.errors++;
      } else if (curNorm === null && ruleNorm === null) {
        classification = 'NO_MATCH';
        summary.noMatch++;
      } else if (curNorm === null && ruleNorm !== null) {
        classification = 'NEW_VALUE';
        summary.newValues++;
        summary.matched++;
      } else if (curNorm !== null && ruleNorm === null) {
        classification = 'NEW_NULL';
        summary.newNulls++;
      } else if (curNorm === ruleNorm) {
        classification = 'UNCHANGED';
        summary.unchanged++;
        summary.matched++;
      } else {
        classification = 'CHANGED';
        summary.changed++;
        summary.matched++;
      }

      if (classification === 'CHANGED' || classification === 'NEW_NULL' || classification === 'ERROR') {
        if (summary.regressionCandidates.length < 15) {
          const rawSourceVal = winningTrace?.input ?? (primaryRule?.source_path ? resolveSourcePath(raw, primaryRule.source_path) : undefined) ?? null;
          summary.regressionCandidates.push({
            uniqueId: offerRow.unique_id,
            title: offerRow.title ?? 'Untitled Offer',
            rawSourceValue: rawSourceVal ? rawSourceVal.substring(0, 150) : null,
            currentValue: currentVal,
            ruleResult,
            ruleId: winningRuleId,
            ruleVersion: winningRuleVersion,
            classification,
          });
        }
      }
    }

    summaries.push(summary);
  }

  res.json({
    bank,
    offersScanned: offers.length,
    rulesEvaluated: activeRules.length,
    byField: summaries,
  });
});

export const bankParserRulesRoutes = router;
