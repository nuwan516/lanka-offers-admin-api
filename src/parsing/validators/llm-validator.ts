import axios from 'axios';
import { Offer } from '@/core/types/offers';
import {
  LlmFieldVerdict,
  LlmScoreBreakdown,
  LlmValidationResult,
  LlmProvider,
  RawValidationData,
} from '@/core/types/validation';
import { getCostControlConfig } from '@/config/cost-control';
import { costGuard } from '@/infrastructure/cost-control/cost-guard';
import { recordApiUsage } from '@/infrastructure/db/offer-repository';

// ─── Config ───────────────────────────────────────────────────────────────────

const PROMPT_VERSION = 'offer-full-v1';
const MAX_STRING_LENGTH = 1_200;
const MAX_RAW_HTML_LENGTH = 8_000;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 80;
const MAX_DEPTH = 6;

export const EMPTY_SCORE_BREAKDOWN: LlmScoreBreakdown = {
  identity: 0,
  merchant: 0,
  offerDetails: 0,
  validity: 0,
  cardEligibility: 0,
  locationAndContact: 0,
  mediaAndSource: 0,
  noHallucination: 0,
};

export interface LlmValidatorConfig {
  /** OpenAI, Gemini, or DeepSeek API key. If absent, validation is skipped gracefully. */
  apiKey?: string;
  provider?: LlmProvider;
  /** Model ID. Defaults: openai -> gpt-4o-mini, gemini -> gemini-1.5-flash, deepseek -> deepseek-chat */
  model?: string;
  /** Request timeout ms (default 15000). */
  timeoutMs?: number;
}

interface ParsedLlmResponse {
  isValidOffer?: unknown;
  inferredCategory?: unknown;
  extractionScore?: unknown;
  confidence?: unknown;
  suggestedTitle?: unknown;
  scoreBreakdown?: unknown;
  fieldVerdicts?: unknown;
  issues?: unknown;
  reasoning?: unknown;
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.toLowerCase() === 'null') return null;
  return normalized || null;
}

function limitString(value: unknown, maxLength = MAX_STRING_LENGTH): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...[truncated:${normalized.length - maxLength}]`;
}

function sanitizeForPrompt(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return limitString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH_REACHED]';

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForPrompt(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_ITEMS:${value.length - MAX_ARRAY_ITEMS}]`);
    return items;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    const sanitized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      const maxLength = key === 'rawHtml' ? MAX_RAW_HTML_LENGTH : MAX_STRING_LENGTH;
      sanitized[key] = typeof entryValue === 'string'
        ? limitString(entryValue, maxLength)
        : sanitizeForPrompt(entryValue, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) sanitized.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    return sanitized;
  }

  return normalizeText(value);
}

function buildRawSnapshot(offer: Offer, rawData?: Partial<RawValidationData> | unknown): RawValidationData {
  const raw = rawData && typeof rawData === 'object' ? rawData as Partial<RawValidationData> : {};
  return {
    rawHtml: limitString(raw.rawHtml ?? offer.rawHtml ?? null, MAX_RAW_HTML_LENGTH),
    rawText: limitString(raw.rawText ?? null, MAX_RAW_HTML_LENGTH),
    rawListItem: sanitizeForPrompt(raw.rawListItem ?? null),
    rawDetail: sanitizeForPrompt(raw.rawDetail ?? null),
    sourceUrl: limitString(raw.sourceUrl ?? offer.sourceUrl ?? null, 500),
  };
}

function buildPrompt(offer: Offer, rawData?: Partial<RawValidationData> | unknown): string {
  const rawSnapshot = buildRawSnapshot(offer, rawData);
  const sanitizedOffer = sanitizeForPrompt(offer);
  const rawCompared = Boolean(
    rawSnapshot.rawHtml ||
    rawSnapshot.rawText ||
    rawSnapshot.rawListItem ||
    rawSnapshot.rawDetail,
  );

  return `You are a strict semantic validator for Sri Lankan bank card offers.

Your job:
1. Compare the FULL extracted Offer JSON against the raw source evidence.
2. Judge whether every important nested field is supported by the raw evidence.
3. Penalize missing, contradicted, hallucinated, malformed, or over-broad values.
4. Do not rewrite the offer. Only validate it and optionally suggest a cleaner title/category.

SCORING RUBRIC:
- identity: 10 points weight. uniqueId, source, sourceId, sourceUrl, title identify the same source offer.
- merchant: 15 points weight. merchant.name, addresses, phone, email, website, logo match evidence.
- offerDetails: 20 points weight. description, discountPercentage, restrictions, bookingRequired, installmentPlans, transactionRange are supported.
- validity: 15 points weight. validityPeriods dates, recurrence, time windows, exclusions match source text.
- cardEligibility: 10 points weight. cardType, included/excluded cards, cardTypes, networks, card restrictions match evidence.
- locationAndContact: 10 points weight. category/location fields and geocoding-related merchant data are usable and not invented.
- mediaAndSource: 5 points weight. images, raw source URL, contentHash/rawHtml are plausible.
- noHallucination: 15 points weight. high score only if unsupported invented data is absent.

Return extractionScore as the weighted overall score from 0 to 100.
Use confidence for your confidence in the validation itself, from 0.0 to 1.0.
If raw evidence is weak or missing, use "unclear" or "not_present" field verdicts instead of inventing certainty.

RAW_EVIDENCE_INCLUDED: ${rawCompared}

--- FULL_EXTRACTED_OFFER_JSON ---
${JSON.stringify(sanitizedOffer, null, 2)}

--- RAW_SOURCE_EVIDENCE_JSON ---
${JSON.stringify(rawSnapshot, null, 2)}

Return ONLY valid JSON. No markdown, no code fences.
Schema:
{
  "isValidOffer": true,
  "inferredCategory": "Dining|Shopping|Hotels|Travel|Lifestyle|Health|Education|Fuel|Online|Other|null",
  "extractionScore": 0,
  "confidence": 0.0,
  "suggestedTitle": "cleaned title if malformed, else null",
  "scoreBreakdown": {
    "identity": 0,
    "merchant": 0,
    "offerDetails": 0,
    "validity": 0,
    "cardEligibility": 0,
    "locationAndContact": 0,
    "mediaAndSource": 0,
    "noHallucination": 0
  },
  "fieldVerdicts": {
    "title": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" },
    "merchant.name": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" },
    "offer.discountPercentage": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" },
    "validityPeriods": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" },
    "cardEligibility": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" },
    "merchant.addresses": { "verdict": "supported|unsupported|unclear|not_present", "citation": "short raw substring or null", "note": "short note or null" }
  },
  "issues": ["MISSING_VALIDITY", "UNSUPPORTED_DISCOUNT", "HALLUCINATED_ADDRESS"],
  "reasoning": "1-3 sentence explanation of score and major risks"
}`;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeScoreBreakdown(value: unknown): LlmScoreBreakdown {
  if (!value || typeof value !== 'object') return { ...EMPTY_SCORE_BREAKDOWN };
  const raw = value as Partial<Record<keyof LlmScoreBreakdown, unknown>>;
  return {
    identity: clampNumber(raw.identity, 0, 100),
    merchant: clampNumber(raw.merchant, 0, 100),
    offerDetails: clampNumber(raw.offerDetails, 0, 100),
    validity: clampNumber(raw.validity, 0, 100),
    cardEligibility: clampNumber(raw.cardEligibility, 0, 100),
    locationAndContact: clampNumber(raw.locationAndContact, 0, 100),
    mediaAndSource: clampNumber(raw.mediaAndSource, 0, 100),
    noHallucination: clampNumber(raw.noHallucination, 0, 100),
  };
}

function normalizeFieldVerdicts(value: unknown): Record<string, LlmFieldVerdict> {
  if (!value || typeof value !== 'object') return {};
  const normalized: Record<string, LlmFieldVerdict> = {};
  for (const [field, rawVerdict] of Object.entries(value as Record<string, unknown>)) {
    if (!rawVerdict || typeof rawVerdict !== 'object') continue;
    const item = rawVerdict as Record<string, unknown>;
    const verdict = String(item.verdict ?? 'unclear').toLowerCase();
    normalized[field] = {
      verdict: verdict === 'supported' || verdict === 'unsupported' || verdict === 'not_present'
        ? verdict
        : 'unclear',
      citation: limitString(item.citation ?? null, 240),
      note: limitString(item.note ?? null, 240),
    };
  }
  return normalized;
}

function normalizeIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((issue) => String(issue ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_'))
      .filter(Boolean),
  )];
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseJsonObject(raw: string): ParsedLlmResponse {
  const stripped = stripCodeFence(raw);
  try {
    return JSON.parse(stripped) as ParsedLlmResponse;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as ParsedLlmResponse;
    }
    throw new Error('LLM response did not contain a valid JSON object');
  }
}

function hasExplicitApiKey(config: LlmValidatorConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config, 'apiKey');
}

function apiKeyFor(provider: LlmProvider): string | undefined {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY;
  if (provider === 'deepseek') return process.env.DEEPSEEK_API_KEY;
  return process.env.OPENAI_API_KEY;
}

function defaultModelFor(provider: LlmProvider): string {
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'gemini') return 'gemini-1.5-flash';
  return 'gpt-4o-mini';
}

/**
 * Resolve which provider this validator will actually use, honoring the
 * explicit provider policy: Gemini (free tier) is preferred; DeepSeek only
 * runs if paid fallback is explicitly enabled AND Gemini has no key. The
 * provider is never inferred solely from "whichever API key happens to
 * exist" — that was the previous (DeepSeek > Gemini > OpenAI) behavior.
 */
export function resolveLlmProvider(explicit?: LlmProvider): { provider: LlmProvider; apiKey: string | undefined } {
  if (explicit) return { provider: explicit, apiKey: apiKeyFor(explicit) };

  const policy = getCostControlConfig().llm;
  const primaryKey = apiKeyFor(policy.primaryProvider);
  if (primaryKey) return { provider: policy.primaryProvider, apiKey: primaryKey };

  if (policy.allowPaidFallback && policy.fallbackProvider) {
    const fallbackKey = apiKeyFor(policy.fallbackProvider);
    if (fallbackKey) return { provider: policy.fallbackProvider, apiKey: fallbackKey };
  }

  return { provider: policy.primaryProvider, apiKey: undefined };
}

// ─── LlmValidator ─────────────────────────────────────────────────────────────

/**
 * Optional LLM semantic validator for full Offer aggregate roots.
 *
 * It compares the complete extracted Offer object against bounded raw source evidence,
 * returns weighted score breakdowns, and fails open so scraping is never blocked by LLM errors.
 */
export class LlmValidator {
  private readonly apiKey: string | undefined;
  private readonly provider: LlmProvider;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: LlmValidatorConfig = {}) {
    if (hasExplicitApiKey(config)) {
      this.apiKey = config.apiKey;
      this.provider = config.provider ?? 'gemini';
    } else {
      const resolved = resolveLlmProvider(config.provider);
      this.apiKey = resolved.apiKey;
      this.provider = resolved.provider;
    }
    this.model = config.model ?? defaultModelFor(this.provider);
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  get isAvailable(): boolean {
    return !!this.apiKey;
  }

  get providerName(): LlmProvider {
    return this.provider;
  }

  get modelName(): string {
    return this.model;
  }

  /**
   * Validate a single offer using the LLM.
   * Returns null if no API key is configured (graceful fallback).
   */
  async validate(offer: Offer, rawData?: Partial<RawValidationData> | unknown): Promise<LlmValidationResult | null> {
    if (!this.apiKey) return null;

    const rawSnapshot = buildRawSnapshot(offer, rawData);
    const rawCompared = Boolean(
      rawSnapshot.rawHtml ||
      rawSnapshot.rawText ||
      rawSnapshot.rawListItem ||
      rawSnapshot.rawDetail,
    );

    const service = `${this.provider}_llm`;
    const guardDecision = await costGuard.canCall(service);
    if (guardDecision.verdict === 'BLOCK') {
      return {
        isValidOffer: true,
        inferredCategory: null,
        extractionScore: 0,
        confidence: 0,
        suggestedTitle: null,
        scoreBreakdown: { ...EMPTY_SCORE_BREAKDOWN },
        fieldVerdicts: {},
        issues: ['BUDGET_BLOCKED'],
        rawCompared,
        promptVersion: PROMPT_VERSION,
        reasoning: `LLM validation skipped: CostGuard blocked "${service}" (${guardDecision.reason})`,
        provider: this.provider,
        model: this.model,
      };
    }

    const prompt = buildPrompt(offer, rawData);

    try {
      const raw = await this.callWithRetry(prompt);
      await recordApiUsage(this.provider, service).catch(() => null);
      costGuard.invalidate(service);
      const parsed = parseJsonObject(raw);
      return {
        isValidOffer: Boolean(parsed.isValidOffer),
        inferredCategory: normalizeText(parsed.inferredCategory),
        extractionScore: clampNumber(parsed.extractionScore, 0, 100),
        confidence: clampNumber(parsed.confidence, 0, 1),
        suggestedTitle: normalizeText(parsed.suggestedTitle),
        scoreBreakdown: normalizeScoreBreakdown(parsed.scoreBreakdown),
        fieldVerdicts: normalizeFieldVerdicts(parsed.fieldVerdicts),
        issues: normalizeIssues(parsed.issues),
        rawCompared,
        promptVersion: PROMPT_VERSION,
        reasoning: normalizeText(parsed.reasoning) ?? '',
        provider: this.provider,
        model: this.model,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValidOffer: true,
        inferredCategory: null,
        extractionScore: 0,
        confidence: 0,
        suggestedTitle: null,
        scoreBreakdown: { ...EMPTY_SCORE_BREAKDOWN },
        fieldVerdicts: {},
        issues: ['LLM_VALIDATION_FAILED'],
        rawCompared,
        promptVersion: PROMPT_VERSION,
        reasoning: `LLM validation failed: ${message}`,
        provider: this.provider,
        model: this.model,
      };
    }
  }

  // ── Retry wrapper ──────────────────────────────────────────────────────────

  /**
   * Transient network faults (EAI_AGAIN DNS exhaustion during long batch runs,
   * resets, timeouts, 429/5xx) get retried with backoff before failing open.
   */
  private async callWithRetry(prompt: string, attempt = 0): Promise<string> {
    try {
      if (this.provider === 'gemini') return await this.callGemini(prompt);
      if (this.provider === 'deepseek') return await this.callDeepSeek(prompt);
      return await this.callOpenAI(prompt);
    } catch (err: unknown) {
      const e = err as { code?: string; response?: { status?: number }; message?: string };
      const status = e.response?.status;
      const transient =
        e.code === 'EAI_AGAIN' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' ||
        e.code === 'ECONNABORTED' || status === 429 || (status !== undefined && status >= 500);
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        return this.callWithRetry(prompt, attempt + 1);
      }
      throw err;
    }
  }

  // ── Provider implementations ───────────────────────────────────────────────

  private async callOpenAI(prompt: string): Promise<string> {
    const response = await axios.post<{
      choices: Array<{ message: { content: string } }>;
    }>(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a strict data validator. Return only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: this.timeoutMs,
      },
    );
    return response.data.choices[0]?.message.content ?? '{}';
  }

  private async callDeepSeek(prompt: string): Promise<string> {
    const response = await axios.post<{
      choices: Array<{ message: { content: string } }>;
    }>(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: this.model,
        messages: [
          { role: 'system', content: 'You are a strict data validator. Return only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: this.timeoutMs,
      },
    );
    return response.data.choices[0]?.message.content ?? '{}';
  }

  private async callGemini(prompt: string): Promise<string> {
    const response = await axios.post<{
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
      }>;
    }>(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeoutMs,
      },
    );

    return response.data.candidates[0]?.content.parts[0]?.text ?? '{}';
  }
}
