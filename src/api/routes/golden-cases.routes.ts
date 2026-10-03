import { Router, Request, Response } from 'express';
import { goldenCasesRepository } from '@/infrastructure/repositories/golden-cases.repository';
import { evaluateRulesForField, areGoldenValuesEqual } from '@/banks/bank-rules-loader';

const router = Router();

router.get('/parser-golden-cases', async (req: Request, res: Response) => {
  const { bank, field, enabled } = req.query as Record<string, string>;
  const enabledBool = enabled === 'true' ? true : enabled === 'false' ? false : undefined;
  const items = await goldenCasesRepository.getGoldenCases({
    bank: bank || undefined,
    field: field || undefined,
    enabled: enabledBool,
  });
  res.json({ total: items.length, items });
});

router.post('/parser-golden-cases', async (req: Request, res: Response) => {
  const {
    bank,
    offerId,
    offerUniqueId,
    offerTitle,
    field,
    expectedValue,
    rawSnippet,
    notes,
    enabled,
  } = req.body as {
    bank: string;
    offerId?: string;
    offerUniqueId?: string;
    offerTitle?: string;
    field: string;
    expectedValue: string;
    rawSnippet?: string;
    notes?: string;
    enabled?: boolean;
  };

  if (!bank || !field || expectedValue === undefined || expectedValue === null) {
    res.status(400).json({ error: 'bank, field, and expectedValue are required' });
    return;
  }

  let title = offerTitle ?? null;
  let resolvedOfferId = offerId ?? null;
  let resolvedOfferUniqueId = offerUniqueId ?? null;

  if ((offerId || offerUniqueId) && !title) {
    const offerLookup = await goldenCasesRepository.resolveOffer(offerId, offerUniqueId);
    if (offerLookup) {
      title = offerLookup.title;
      resolvedOfferId = offerLookup.id;
      resolvedOfferUniqueId = offerLookup.unique_id;
    }
  }

  const created = await goldenCasesRepository.createGoldenCase({
    bank,
    offerId: resolvedOfferId,
    offerUniqueId: resolvedOfferUniqueId,
    offerTitle: title,
    field,
    expectedValue,
    rawSnippet,
    notes,
    enabled,
  });

  res.status(201).json(created);
});

router.put('/parser-golden-cases/:id', async (req: Request, res: Response) => {
  const {
    expectedValue,
    notes,
    enabled,
    rawSnippet,
    field,
    offerId,
    offerUniqueId,
    offerTitle,
  } = req.body as {
    expectedValue?: string;
    notes?: string;
    enabled?: boolean;
    rawSnippet?: string;
    field?: string;
    offerId?: string;
    offerUniqueId?: string;
    offerTitle?: string;
  };

  const updated = await goldenCasesRepository.updateGoldenCase(String(req.params.id), {
    expectedValue,
    notes,
    enabled,
    rawSnippet,
    field,
    offerId,
    offerUniqueId,
    offerTitle,
  });

  if (!updated) {
    res.status(404).json({ error: 'Golden case not found' });
    return;
  }
  res.json(updated);
});

router.delete('/parser-golden-cases/:id', async (req: Request, res: Response) => {
  const deletedId = await goldenCasesRepository.deleteGoldenCase(String(req.params.id));
  if (!deletedId) {
    res.status(404).json({ error: 'Golden case not found' });
    return;
  }
  res.json({ deleted: deletedId });
});

router.post('/parser-golden-cases/run', async (req: Request, res: Response) => {
  const { bank, field } = req.body as { bank?: string; field?: string };
  const cases = await goldenCasesRepository.getCasesForExecution(bank, undefined);

  interface GoldenTestResultItem {
    caseId: string;
    bank: string;
    field: string;
    offerTitle: string;
    expected: string;
    actual: string | null;
    status: 'PASS' | 'FAIL';
    whichRuleRan: string;
    ruleVersion: number;
    sourcePath: string | null;
    inputValue: string | null;
    regexMatched: boolean;
    capture: string | null;
    usedFallback: boolean;
    error?: string;
  }

  const results: GoldenTestResultItem[] = [];

  for (const row of cases) {
    if (field && row.field !== field) continue;

    const raw: Record<string, unknown> = (typeof row.live_raw_offer === 'object' && row.live_raw_offer !== null)
      ? (row.live_raw_offer as Record<string, unknown>)
      : (row.raw_snippet ? { text: row.raw_snippet } : {});

    const fallbackInput = row.raw_snippet ?? (row.live_raw_offer ? JSON.stringify(row.live_raw_offer) : '');

    const evalResult = evaluateRulesForField({
      bank: row.bank,
      field: row.field,
      category: null,
      sourceType: null,
      rawOffer: raw,
      fallbackInput,
    });

    const winningTrace = evalResult.trace.find((t) => t.matched);
    const activeTrace = winningTrace ?? evalResult.trace[evalResult.trace.length - 1];

    const actualVal = evalResult.value;
    const passed = areGoldenValuesEqual(row.expected_value, actualVal, row.field);

    results.push({
      caseId: row.id,
      bank: row.bank,
      field: row.field,
      offerTitle: row.offer_title ?? 'Untitled Offer',
      expected: row.expected_value,
      actual: actualVal,
      status: passed ? 'PASS' : 'FAIL',
      whichRuleRan: activeTrace?.ruleId ?? 'none',
      ruleVersion: activeTrace?.ruleVersion ?? 1,
      sourcePath: activeTrace?.sourcePath ?? null,
      inputValue: activeTrace?.input ?? null,
      regexMatched: activeTrace?.matched ?? false,
      capture: activeTrace?.extracted ?? null,
      usedFallback: activeTrace?.usedFallback ?? false,
      error: activeTrace?.error,
    });
  }

  const total = results.length;
  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = total - passedCount;
  const passRate = total > 0 ? Math.round((passedCount / total) * 100) : 100;

  res.json({
    bank: bank ?? 'all',
    field: field ?? 'all',
    total,
    passed: passedCount,
    failed: failedCount,
    passRate,
    cases: results,
  });
});

export const goldenCasesRoutes = router;
