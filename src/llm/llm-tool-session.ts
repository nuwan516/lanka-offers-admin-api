import axios from 'axios';
import { Offer } from '@/core/types/offers';
import {
  EvidenceSnippet,
  FullOfferValidationProposal,
  FullOfferValidationProposalSchema,
} from './schemas/offer-validation.schema';
import { OFFER_TOOL_DEFINITIONS } from './tools/offer-tool-registry';
import { OfferToolExecutor } from './tools/offer-tool-executor';
import { LlmProvider } from '@/core/types/validation';
import { resolveLlmProvider } from '@/parsing/validators/llm-validator';

export interface LlmToolSessionConfig {
  provider?: LlmProvider;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
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
 * Executes a genuine multi-turn LLM tool-calling loop.
 * Passes the allowlisted tool definitions as native function declarations,
 * executes model-requested tool calls via the sandboxed OfferToolExecutor,
 * feeds tool results back to the model, and validates the final structured proposal.
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
  const timeoutMs = sessionConfig.timeoutMs ?? 20_000;
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
3. A 0% installment plan (e.g. 0% interest for 12 months) is an interest-free payment plan, NOT a 0% price discount.
4. Never invent branch coordinates or insert coordinates into street addresses.
5. If terms are contradictory or evidence is missing, flag as REVIEW_REQUIRED.

You have access to 22 allowlisted inspection tools. Call tools when you need to verify sections, dates, financial consistency, or merchant identity.
When you have collected necessary evidence, output ONLY a valid JSON object matching the FullOfferValidationProposal schema.`;

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
    evidenceSnippetCount: evidence.length,
    availableSnippetIds: evidence.slice(0, 10).map((s) => s.id),
  });

  let toolCallsThisSession = 0;
  let totalTokens = 0;

  try {
    if (provider === 'gemini') {
      return await executeGeminiToolLoop(
        systemPrompt,
        userContext,
        evidence,
        executor,
        apiKey,
        model,
        timeoutMs,
        sessionConfig.abortSignal
      );
    } else {
      return await executeOpenAIToolLoop(
        provider,
        systemPrompt,
        userContext,
        evidence,
        executor,
        apiKey,
        model,
        timeoutMs,
        sessionConfig.abortSignal
      );
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      proposal: null,
      toolCallsExecuted: toolCallsThisSession,
      billableRequests: 0,
      totalTokensUsed: totalTokens,
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
  apiKey: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal
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
      functionDeclarations: OFFER_TOOL_DEFINITIONS.map((t) => ({
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
      // Model produced text output
      const textPart = parts.find((p) => p.text)?.text ?? '';
      lastRawText = textPart;
      const parsed = parseJsonProposal(textPart);
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

    // Append model's tool calls to contents
    contents.push({
      role: 'model',
      parts: parts as any,
    });

    // Execute each function call
    for (const fc of functionCalls) {
      const call = fc.functionCall!;
      toolCallsExecuted++;
      const toolOutput = await executor.executeTool(call.name, call.args);

      // Return function response to Gemini
      contents.push({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name: call.name,
              response: { output: toolOutput },
            },
          },
        ],
      });
    }
  }

  // If loop exited after max turns without text proposal, parse last raw text
  const parsed = parseJsonProposal(lastRawText);
  return {
    proposal: parsed,
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
  apiKey: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal
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

  const openAiTools = OFFER_TOOL_DEFINITIONS.map((t) => ({
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
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = {};
        }

        const toolOutput = await executor.executeTool(tc.function.name, parsedArgs);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(toolOutput),
        });
      }
    } else {
      lastRawText = msg.content ?? '';
      const parsed = parseJsonProposal(lastRawText);
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

  const parsed = parseJsonProposal(lastRawText);
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

/**
 * Strips markdown code blocks and validates FullOfferValidationProposal
 */
function parseJsonProposal(rawText: string): FullOfferValidationProposal | null {
  if (!rawText || rawText.trim().length === 0) return null;
  const clean = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const obj = JSON.parse(clean);
    const parsed = FullOfferValidationProposalSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(clean.slice(start, end + 1));
        const parsed = FullOfferValidationProposalSchema.safeParse(obj);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
