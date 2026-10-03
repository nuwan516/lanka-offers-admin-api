import { Router, Request, Response } from 'express';
import {
  ruleConfigRepository,
  VALIDATION_RULES,
  evalCustomRule,
  CustomRule,
} from '@/infrastructure/repositories/rule-config.repository';
import { validationRepository } from '@/infrastructure/repositories/validation.repository';

const router = Router();

// Validation reports
router.get('/validation', async (req: Request, res: Response) => {
  const { limit = '50', passed } = req.query as Record<string, string>;
  const passedBool = passed !== undefined ? passed === 'true' : undefined;
  const items = await validationRepository.getValidationReports(passedBool, parseInt(limit, 10));
  res.json({ items });
});

// Built-in validation rules list & config
router.get('/rules', async (_req: Request, res: Response) => {
  const items = await ruleConfigRepository.getBuiltinRules();
  res.json({ items, total: items.length });
});

router.patch('/rules/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { enabled, severity, notes } = req.body as {
    enabled?: boolean;
    severity?: string;
    notes?: string;
  };

  if (!VALIDATION_RULES.find((r) => r.id === id)) {
    res.status(404).json({ error: `Unknown rule: ${id}` });
    return;
  }

  const updated = await ruleConfigRepository.updateRuleConfig(id, enabled, severity, notes);
  res.json(updated);
});

// Custom rules CRUD
router.get('/custom-rules', async (_req: Request, res: Response) => {
  const items = await ruleConfigRepository.getCustomRules();
  res.json({ items, total: items.length });
});

router.post('/custom-rules', async (req: Request, res: Response) => {
  const { name, description, group_name, severity, field_path, operator, config, notes, banks } = req.body as Record<string, any>;
  if (!name || !field_path || !operator) {
    res.status(400).json({ error: 'name, field_path, and operator are required' });
    return;
  }

  const created = await ruleConfigRepository.createCustomRule({
    name,
    description,
    group_name,
    severity,
    field_path,
    operator,
    config,
    notes,
    banks,
  });
  res.status(201).json(created);
});

router.put('/custom-rules/:id', async (req: Request, res: Response) => {
  const updated = await ruleConfigRepository.updateCustomRule(String(req.params.id), req.body);
  if (!updated) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json(updated);
});

router.delete('/custom-rules/:id', async (req: Request, res: Response) => {
  const deletedId = await ruleConfigRepository.deleteCustomRule(String(req.params.id));
  if (!deletedId) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ deleted: deletedId });
});

// Test a custom rule against recent DB offers
router.post('/custom-rules/:id/test', async (req: Request, res: Response) => {
  const rule = await ruleConfigRepository.getCustomRuleById(String(req.params.id));
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }

  const { bank, limit = '50' } = req.query as Record<string, string>;
  const offers = await ruleConfigRepository.getOffersForCustomRuleTest(bank, parseInt(limit, 10));

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: { unique_id: string; bank: string; title: string; message: string }[] = [];

  for (const row of offers) {
    const offerBank: string = row.bank ?? '';
    if (rule.banks !== null && Array.isArray(rule.banks) && !rule.banks.includes(offerBank)) {
      skipped++;
      continue;
    }
    const r = evalCustomRule(rule, (row.raw_offer as Record<string, unknown>) ?? {});
    if (r.passed) {
      passed++;
    } else {
      failed++;
      if (failures.length < 20) {
        failures.push({
          unique_id: row.unique_id,
          bank: row.bank,
          title: row.title ?? '',
          message: r.message ?? 'failed',
        });
      }
    }
  }

  res.json({ total: offers.length, passed, failed, skipped, failures });
});

// Backtest
router.get('/backtest', async (_req: Request, res: Response) => {
  const report = await validationRepository.getBacktestReport();
  res.json(report);
});

// Revalidate offers
router.post('/revalidate', async (req: Request, res: Response) => {
  const { bank, offerId } = { ...req.query, ...req.body } as Record<string, string>;
  const rows = await validationRepository.getOffersForRevalidation(bank, offerId);
  const allRules = await validationRepository.getAllEnabledRules();

  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const offerData: Record<string, unknown> = row.raw_offer ?? {};
      const offerBank: string = (offerData.source as string) ?? row.bank ?? '';
      const ruleErrors: Array<{ field: string; message: string; severity: string }> = [];
      const ruleWarnings: Array<{ field: string; message: string; severity: string }> = [];

      for (const rule of allRules) {
        if (rule.banks !== null && Array.isArray(rule.banks) && !rule.banks.includes(offerBank)) continue;
        const r = evalCustomRule(rule, offerData);
        if (!r.passed) {
          const entry = { field: rule.field_path, message: r.message ?? rule.name, severity: rule.severity };
          if (rule.severity === 'error') ruleErrors.push(entry);
          else ruleWarnings.push(entry);
        }
      }

      const valid = ruleErrors.length === 0;
      await validationRepository.updateOfferValidationResults(row.id, valid, ruleErrors, ruleWarnings);
      if (valid) passed++;
      else failed++;
    } catch {
      errors++;
    }
  }

  res.json({ total: rows.length, passed, failed, errors });
});

export const validationRoutes = router;
