import axios from 'axios';
import { Offer } from '@/core/types/offers';
import {
  EvidenceSnippet,
  FullOfferValidationProposal,
  FullOfferValidationProposalSchema,
  ValidationDecisionSchema,
  toFullOfferValidationProposal,
} from './schemas/offer-validation.schema';
import { COMPACT_OFFER_TOOL_DEFINITIONS } from './tools/offer-tool-registry';
import { OfferToolExecutor } from './tools/offer-tool-executor';
import { LlmProvider } from '@/core/types/validation';
import { resolveLlmProvider } from '@/parsing/validators/llm-validator';

export interface LlmToolSessionConfig {
  provider?: LlmProvider;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  maxInputTokens?: number;
}

export interface ModelToolCallResult {
  proposal: FullOfferValidationProposal | null;
  toolCallsExecuted: number;
  billableRequests: number;
  totalTokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  wallClockTimeMs: number;
  estimatedCostUsd: number;
  rawResponseText: string;
  provider: LlmProvider;
  model: string;
  isRealModelCall: boolean;
  error?: string;
}

/**
 * Truncates / compacts tool execution output before feeding back into conversation history
 * to prevent multi-turn context compounding (Phase 3 token optimization).
 */
function compactToolOutputForHistory(output: unknown): string {
  if (typeof output === 'string') {
    return output.length > 400 ? output.slice(0, 400) + '... [truncated]' : output;
  }
  const str = JSON.stringify(output);
  if (str.length > 600) {
    return str.slice(0, 600) + '... [truncated]';
  }
  return str;
}

/**
 * Executes a genuine multi-turn LLM tool-calling loop.
 * Passes the allowlisted compact tool definitions as native function declarations,
 * executes model-requested tool calls via the sandboxed OfferToolExecutor,
 * feeds compacted tool results back to the model, and validates the final structured proposal.
 */
export async function runLlmToolCallingSession(
  offer: Offer,
  evidence: EvidenceSnippet[],
  executor: OfferToolExecutor,
  attempt: number,
  previousFailures: string[] = [],
  sessionConfig: LlmToolSessionConfig = {}
): Promise<ModelToolCallResult> {
  const resolved = sessionConfig.apiKey
    ? { provider: sessionConfig.provider ?? 'gemini', apiKey: sessionConfig.apiKey }
    : resolveLlmProvider(sessionConfig.provider);

  const provider = resolved.provider;
  const apiKey = resolved.apiKey;
  const timeoutMs = sessionConfig.timeoutMs ?? 25_000;
  const model = sessionConfig.model ?? (provider === 'gemini' ? (process.env.GEMINI_MODEL || 'gemini-3.8-flash') : provider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : 'gpt-4o-mini');

  // If no API key is available, report truthfully as unverified/offline
  if (!apiKey) {
    return {
      proposal: null,
      toolCallsExecuted: 0,
      billableRequests: 0,
      totalTokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallClockTimeMs: 0,
      estimatedCostUsd: 0,
      rawResponseText: '',
      provider,
      model,
      isRealModelCall: false,
      error: `No API key configured for provider "${provider}"`,
    };
  }

  // System prompt enforcing strict evidence grounding and Invariant #8
  const systemPrompt = `You are the Lanka Offers Production Data Quality Validator.
Your mission is to strictly validate a scraped Sri Lankan bank promotion against factual source evidence.

CRITICAL INVARIANTS:
1. Every numeric percentage, spend threshold, and discount cap MUST physically and semantically exist in the source evidence. Never invent or round numbers.
2. Invariant #8: Only declare "isUpTo: true" when the bank's title or description literally states "up to" or "maximum of".
3. A 0% installment plan (e.g. 0% interest for 12 months) is an interest-free payment plan, NOT a 0% price discount. If parsed as a 0% discount, correct it to null or the genuine discount percentage.
4. Never invent branch coordinates or insert coordinates into street addresses.
5. If terms are contradictory or evidence is missing, set decision to "REVIEW_REQUIRED".

AVAILABLE TOOLS:
You have access to 6 inspection and submission tools:
- search_source_evidence: searches source text for keywords
- get_source_section: inspects a section of source text
- lookup_merchant_catalog: verifies Sri Lankan merchant identity
- query_bank_rules: checks bank card rules
- check_potential_duplicate: checks similarity against existing offers
- submit_validation_decision: submits your final structured decision

DECISION FORMAT:
When done investigating, call submit_validation_decision (or output JSON) matching:
{
  "decision": "ACCEPT" | "CORRECT" | "REVIEW_REQUIRED",
  "overallScore": 0-100,
  "corrections": [
    {
      "fieldPath": "dot.path.in.offer", // e.g. "offer.discountPercentage", "merchant.name", "merchant.addresses"
      "proposedValue": <corrected_value>,
      "originalValue": <original_value>,
      "evidenceIds": ["snippet_id_1"],
      "reason": "Clear explanation citing source text"
    }
  ],
  "unresolvedIssues": ["list of remaining issues if REVIEW_REQUIRED"],
  "summaryReasoning": "Concise summary citing source evidence",
  "locationScope": "ONLINE" | "NATIONWIDE" | "EXPLICIT_BRANCH" | "MULTIPLE_BRANCHES" | "AREA_ONLY" | "UNRESOLVED"
}
ONLY include fields in "corrections" that actually need correction. Do not repeat unchanged fields.`;

  // Initial user context includes normalized candidate and top evidence snippets to minimize unneeded queries
  const userContext = JSON.stringify({
    attempt,
    previousFailures,
    offerCandidate: {
      uniqueId: offer.uniqueId,
      bank: offer.source,
      title: offer.title,
      merchantName: offer.merchant?.name,
      addresses: offer.merchant?.addresses,
      discountPercentage: offer.offer?.discountPercentage,
      transactionRange: offer.transactionRange,
      validityPeriods: offer.validityPeriods?.map((p) => ({ validFrom: p.validFrom, validTo: p.validTo, text: p.rawPeriodText })),
    },
    topEvidenceSnippets: evidence.slice(0, 6).map((s) => ({
      id: s.id,
      field: s.sourceField,
      text: s.text.length > 250 ? s.text.slice(0, 250) + '... [truncated]' : s.text,
    })),
  });

  try {
    if (provider === 'gemini') {
      return await executeGeminiToolLoop(
        systemPrompt,
        userContext,
        evidence,
        executor,
        offer,
        apiKey,
        model,
        timeoutMs,
        sessionConfig.abortSignal,
        sessionConfig.maxInputTokens ?? 30_000
      );
    } else {
      return await executeOpenAIToolLoop(
        provider,
        systemPrompt,
        userContext,
        evidence,
        executor,
        offer,
        apiKey,
        model,
        timeoutMs,
        sessionConfig.abortSignal,
        sessionConfig.maxInputTokens ?? 30_000
      );
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      proposal: null,
      toolCallsExecuted: executor.getTotalCalls(),
      billableRequests: 0,
      totalTokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallClockTimeMs: 0,
      estimatedCostUsd: 0,
      rawResponseText: '',
      provider,
      model,
      isRealModelCall: true,
      error: errorMsg,
    };
  }
}

function computeCostUsd(provider: LlmProvider, model: string, inputTokens: number, outputTokens: number): number {
  if (provider === 'gemini') {
    return (inputTokens / 1_000_000) * 0.075 + (outputTokens / 1_000_000) * 0.30;
  }
  if (provider === 'deepseek') {
    return (inputTokens / 1_000_000) * 0.14 + (outputTokens / 1_000_000) * 0.28;
  }
  return (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.60;
}

/**
 * Multi-turn Gemini Tool Execution Loop
 */
async function executeGeminiToolLoop(
  systemPrompt: string,
  userPrompt: string,
  evidence: EvidenceSnippet[],
  executor: OfferToolExecutor,
  offer: Offer,
  apiKey: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxInputTokens: number = 30_000
): Promise<ModelToolCallResult> {
  const startTime = Date.now();
  let billableRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallsExecuted = 0;
  let lastRawText = '';
  const MAX_TURNS = 5;

  const geminiTools = [
    {
      functionDeclarations: COMPACT_OFFER_TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];

  const contents: Array<{
    role: 'user' | 'model' | 'function';
    parts: Array<Record<string, unknown>>;
  }> = [
    {
      role: 'user',
      parts: [{ text: `${systemPrompt}\n\nCandidate to evaluate:\n${userPrompt}` }],
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) throw new Error('Validation job aborted by signal');
    if (inputTokens >= maxInputTokens) {
      break;
    }

    billableRequests++;
    const response = await axios.post<{
      candidates: Array<{
        content: {
          parts: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    }>(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        contents,
        tools: geminiTools,
        generationConfig: {
          temperature: 0,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs,
        signal,
      }
    );

    inputTokens += response.data.usageMetadata?.promptTokenCount ?? 0;
    outputTokens += response.data.usageMetadata?.candidatesTokenCount ?? 0;

    const candidate = response.data.candidates?.[0];
    if (!candidate || !candidate.content?.parts) {
      break;
    }

    const parts = candidate.content.parts;
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const textPart = parts.find((p) => p.text)?.text ?? '';
      lastRawText = textPart;
      const parsed = parseJsonProposal(textPart, offer) || executor.getSubmittedProposal();
      return {
        proposal: parsed,
        toolCallsExecuted,
        billableRequests,
        totalTokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        wallClockTimeMs: Date.now() - startTime,
        estimatedCostUsd: computeCostUsd('gemini', model, inputTokens, outputTokens),
        rawResponseText: textPart,
        provider: 'gemini',
        model,
        isRealModelCall: true,
      };
    }

    contents.push({
      role: 'model',
      parts: parts as any,
    });

    for (const fc of functionCalls) {
      const call = fc.functionCall!;
      toolCallsExecuted++;
      const isSubmission = call.name === 'submit_validation_decision' || call.name === 'submit_offer_validation_proposal';
      const toolOutput = await executor.executeTool(call.name, call.args);

      if (isSubmission && toolOutput.success) {
        const proposal = executor.getSubmittedProposal();
        if (proposal) {
          return {
            proposal,
            toolCallsExecuted,
            billableRequests,
            totalTokensUsed: inputTokens + outputTokens,
            inputTokens,
            outputTokens,
            wallClockTimeMs: Date.now() - startTime,
            estimatedCostUsd: computeCostUsd('gemini', model, inputTokens, outputTokens),
            rawResponseText: JSON.stringify(toolOutput.data),
            provider: 'gemini',
            model,
            isRealModelCall: true,
          };
        }
      }

      contents.push({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: { output: compactToolOutputForHistory(toolOutput) },
            },
          },
        ],
      });
    }
  }

  const proposal = executor.getSubmittedProposal() || parseJsonProposal(lastRawText, offer);
  return {
    proposal,
    toolCallsExecuted,
    billableRequests,
    totalTokensUsed: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    wallClockTimeMs: Date.now() - startTime,
    estimatedCostUsd: computeCostUsd('gemini', model, inputTokens, outputTokens),
    rawResponseText: lastRawText,
    provider: 'gemini',
    model,
    isRealModelCall: true,
  };
}

/**
 * Multi-turn OpenAI/DeepSeek Tool Execution Loop
 */
async function executeOpenAIToolLoop(
  provider: 'openai' | 'deepseek',
  systemPrompt: string,
  userPrompt: string,
  evidence: EvidenceSnippet[],
  executor: OfferToolExecutor,
  offer: Offer,
  apiKey: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxInputTokens: number = 30_000
): Promise<ModelToolCallResult> {
  const startTime = Date.now();
  let billableRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallsExecuted = 0;
  let lastRawText = '';
  const MAX_TURNS = 5;

  const endpoint = provider === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  const openAiTools = COMPACT_OFFER_TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) throw new Error('Validation job aborted by signal');
    if (inputTokens >= maxInputTokens) {
      break;
    }

    billableRequests++;
    const response = await axios.post<{
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    }>(
      endpoint,
      {
        model,
        messages,
        tools: openAiTools,
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
        signal,
      }
    );

    inputTokens += response.data.usage?.prompt_tokens ?? 0;
    outputTokens += response.data.usage?.completion_tokens ?? 0;

    const choice = response.data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        toolCallsExecuted++;
        const isSubmission = tc.function.name === 'submit_validation_decision' || tc.function.name === 'submit_offer_validation_proposal';
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = {};
        }

        const toolOutput = await executor.executeTool(tc.function.name, parsedArgs);

        if (isSubmission && toolOutput.success) {
          const proposal = executor.getSubmittedProposal();
          if (proposal) {
            return {
              proposal,
              toolCallsExecuted,
              billableRequests,
              totalTokensUsed: inputTokens + outputTokens,
              inputTokens,
              outputTokens,
              wallClockTimeMs: Date.now() - startTime,
              estimatedCostUsd: computeCostUsd(provider, model, inputTokens, outputTokens),
              rawResponseText: JSON.stringify(toolOutput.data),
              provider,
              model,
              isRealModelCall: true,
            };
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: compactToolOutputForHistory(toolOutput),
        });
      }
    } else {
      lastRawText = msg.content ?? '';
      const parsed = parseJsonProposal(lastRawText, offer) || executor.getSubmittedProposal();
      return {
        proposal: parsed,
        toolCallsExecuted,
        billableRequests,
        totalTokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        wallClockTimeMs: Date.now() - startTime,
        estimatedCostUsd: computeCostUsd(provider, model, inputTokens, outputTokens),
        rawResponseText: lastRawText,
        provider,
        model,
        isRealModelCall: true,
      };
    }
  }

  const proposal = executor.getSubmittedProposal() || parseJsonProposal(lastRawText, offer);
  return {
    proposal,
    toolCallsExecuted,
    billableRequests,
    totalTokensUsed: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    wallClockTimeMs: Date.now() - startTime,
    estimatedCostUsd: computeCostUsd(provider, model, inputTokens, outputTokens),
    rawResponseText: lastRawText,
    provider,
    model,
    isRealModelCall: true,
  };
}

/**
 * Strips markdown code blocks and validates FullOfferValidationProposal
 * or converts differential ValidationDecision into FullOfferValidationProposal.
 */
export function parseJsonProposal(rawText: string, offer?: Offer): FullOfferValidationProposal | null {
  if (!rawText || rawText.trim().length === 0) return null;

  // Phase 5: Reject ambiguous responses with multiple JSON blocks rather than guessing
  const mdBlocks = rawText.match(/```(?:json)?\s*[\s\S]*?\s*```/gi) || [];
  if (mdBlocks.length > 1) {
    return null;
  }

  let obj: any = null;
  const clean = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    obj = JSON.parse(clean);
  } catch {
    if (mdBlocks.length === 1) {
      const blockContent = mdBlocks[0].replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      try {
        obj = JSON.parse(blockContent);
      } catch {
        return null; // Malformed JSON inside code fence — reject fail-closed
      }
    } else {
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          obj = JSON.parse(clean.slice(start, end + 1));
        } catch {
          return null; // Malformed or truncated payload — reject fail-closed
        }
      }
    }
  }

  if (!obj || typeof obj !== 'object') return null;

  // 1. Try differential ValidationDecisionSchema first (Phase 2 & 3 target)
  const diffCheck = ValidationDecisionSchema.safeParse(obj);
  if (diffCheck.success && offer) {
    return toFullOfferValidationProposal(diffCheck.data, offer);
  }

  // 2. Try monolithic FullOfferValidationProposalSchema (backwards compatibility)
  const fullCheck = FullOfferValidationProposalSchema.safeParse(obj);
  if (fullCheck.success) {
    return fullCheck.data;
  }

  // 3. Resilient fallback for slightly loose model keys when offer is provided
  if (offer && ('decision' in obj || 'corrections' in obj)) {
    try {
      const decisionStr = String(obj.decision || '').toUpperCase();
      const validDecision = decisionStr === 'ACCEPT' || decisionStr === 'CORRECT' ? decisionStr : 'REVIEW_REQUIRED';
      const coercedDecision = {
        decision: validDecision,
        overallScore: typeof obj.overallScore === 'number' ? Math.min(100, Math.max(0, obj.overallScore)) : 85,
        corrections: Array.isArray(obj.corrections) ? obj.corrections : [],
        unresolvedIssues: Array.isArray(obj.unresolvedIssues) ? obj.unresolvedIssues : [],
        summaryReasoning: typeof obj.summaryReasoning === 'string' && obj.summaryReasoning.length >= 10
          ? obj.summaryReasoning
          : typeof obj.reasoning === 'string' && obj.reasoning.length >= 10
          ? obj.reasoning
          : 'Decision parsed from structured model output with evidence grounding.',
        locationScope: obj.locationScope,
      };
      const coercedCheck = ValidationDecisionSchema.safeParse(coercedDecision);
      if (coercedCheck.success) {
        return toFullOfferValidationProposal(coercedCheck.data, offer);
      }
    } catch {}
  }

  return null;
}
