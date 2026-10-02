import { NoObjectGeneratedError, Output, generateText } from 'ai';
import { z } from 'zod';
import { CATEGORIES, type CategoryType } from './categories';
import { hasLlmProviders, withLlmFallback } from './llm-provider';
import type { MatchedTransaction } from './match-rules';
import { sanitizeForLlm } from './sanitize-for-llm';

/**
 * One LLM categorization result, in the order of the submitted payload.
 * `category` is constrained to the Phase 0 enum — the model cannot return
 * free text; an invalid category fails schema validation and rejects the
 * whole response (AI_NoObjectGeneratedError), it is never silently accepted.
 *
 * `confidence` accepts `medium` because gemini-class models emit it despite
 * the prompt's high/low guidance; `mergeLlmResults` treats anything below
 * `high` as low confidence (flagged for review).
 */
export const llmResultSchema = z.object({
  category: z.enum(CATEGORIES as [CategoryType, ...CategoryType[]]),
  tags: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});

export type LlmResult = z.infer<typeof llmResultSchema>;

export interface LlmPayloadRow {
  i: number;
  description: string;
  type: 'debit' | 'credit';
}

/**
 * Build the sanitized batch payload for exactly the transactions that still
 * need categorization (`category === null`), preserving their relative order
 * so results can be zipped back by position. Rule-matched transactions never
 * appear here — the LLM must not re-categorize them.
 */
export function buildLlmPayload(
  transactions: readonly MatchedTransaction[],
): LlmPayloadRow[] {
  return transactions
    .filter((txn) => txn.category === null)
    .map((txn, i) => ({
      i,
      description: sanitizeForLlm(txn) || '(no description available)',
      type: txn.type,
    }));
}

/**
 * Merge LLM results back into the transaction list.
 *
 * - Transactions already categorized by a rule are returned untouched.
 * - Null-category transactions are filled from `results` in order.
 * - `confidence` below `'high'` (`low`, and `medium` — emitted by
 *   gemini-class models) sets `isClarificationNeeded: true` (same flag the
 *   rule matcher uses for conflicting rules, so Phase 4 can treat both
 *   sources uniformly).
 * - A length mismatch (short or long results) throws — callers must fail
 *   the upload rather than insert a partially categorized statement.
 *
 * Pure function: testable with a mocked LLM response, no API involved.
 */
export function mergeLlmResults(
  transactions: readonly MatchedTransaction[],
  results: readonly LlmResult[],
): MatchedTransaction[] {
  let cursor = 0;
  const merged = transactions.map((txn) => {
    if (txn.category !== null) return { ...txn };
    const result = results[cursor];
    if (result === undefined) {
      throw new Error(
        `LLM results too short: no result for null-category transaction #${cursor}`,
      );
    }
    cursor += 1;
    return {
      ...txn,
      category: result.category,
      tags: result.tags,
      isClarificationNeeded:
        result.confidence === 'high' ? txn.isClarificationNeeded : true,
    };
  });
  if (cursor !== results.length) {
    throw new Error(
      `LLM results length mismatch: ${results.length - cursor} unused result(s)`,
    );
  }
  return merged;
}

/**
 * PLACEHOLDER few-shot set — hardcoded example categorizations using vendors
 * from the real test fixture. Replace with real per-user confirmed
 * categorizations once Phase 3 (rule management / user corrections) exists.
 */
const FEW_SHOT_EXAMPLES = [
  'GROWW -> Trading & Investments',
  'Blinkit -> Food & Grocery',
  'Flipkart -> General Shopping & Electronics',
  'IRCTC -> Travel & Trips',
  'SWIGGY -> Food & Grocery',
].join('\n');

export function buildPrompt(payload: readonly LlmPayloadRow[]): string {
  const list = payload
    .map((row) => `${row.i}. [${row.type}] ${row.description}`)
    .join('\n');
  return `Categorize bank transactions into exactly one category from this fixed list:
${CATEGORIES.join(', ')}

Output format: a JSON object {"elements": [...]} containing exactly ${payload.length} elements, one per input transaction, in the same order (element i corresponds to transaction i). Each element must be {"category": "<one category from the list>", "tags": ["short", "labels"], "confidence": "high" | "medium" | "low"}.

Confidence: "high" when the description clearly implies the category; "medium" when the merchant is recognizable but the category is only likely; "low" when you are guessing — unknown merchant, ambiguous wording, or a description that was partially redacted for privacy (handles and phone numbers were removed before sending).

Tags: 0 to 3 short labels (merchant/channel), no personal data.

Example categorizations (PLACEHOLDER set — swap for real confirmed rules later):
${FEW_SHOT_EXAMPLES}

Transactions:
${list}`;
}

export const LLM_RAW_LOG_PREFIX = '[llm:raw] ';

/**
 * Pure formatter for the raw-response line — emits nothing itself; the
 * caller decides emission (LLM_DEBUG === '1'). Distinct from the error path:
 * `source: 'error'` carries the raw text of a REJECTED, schema-invalid reply.
 */
export function buildRawLogLine(info: {
  source: 'success' | 'error';
  model: string;
  items: number;
  text?: string;
  usage?: unknown;
  response?: unknown;
}): string {
  const payload: Record<string, unknown> = {
    source: info.source,
    model: info.model,
    items: info.items,
  };
  if (info.text !== undefined) payload.text = info.text;
  if (info.usage !== undefined) payload.usage = info.usage;
  if (info.response !== undefined) payload.response = info.response;
  return `${LLM_RAW_LOG_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * Categorize all null-category transactions of one upload in a SINGLE
 * schema-validated LLM call via the provider fallback chain (see
 * llm-provider.ts — Cerebras → Groq → OpenRouter, configurable), then merge
 * the results back. Rule-matched transactions pass through untouched.
 *
 * Note: the spec asked for `generateObject`; in the installed ai@7 that API
 * is deprecated in favor of `generateText` + `Output.array({ element })`,
 * which provides the same Zod-validated structured output (invalid output
 * throws AI_NoObjectGeneratedError instead of being accepted).
 *
 * Throws if the key is missing, the model returns a schema-invalid /
 * wrong-length result, or the API call fails — callers should fail the
 * upload rather than persist partially categorized data.
 */
export async function categorizeTransactions(
  transactions: readonly MatchedTransaction[],
): Promise<MatchedTransaction[]> {
  const payload = buildLlmPayload(transactions);
  if (payload.length === 0) {
    return transactions.map((txn) => ({ ...txn }));
  }
  if (!hasLlmProviders()) {
    throw new Error('LLM API key is not set');
  }
  const debug = process.env.LLM_DEBUG === '1';
  let merged: MatchedTransaction[];
  let servedBy: string | undefined;
  try {
    const result = await withLlmFallback(
      'categorize',
      async (model, provider) => {
        servedBy = provider.model;
        return generateText({
          model,
          output: Output.array({
            element: llmResultSchema,
            minItems: payload.length,
            maxItems: payload.length,
          }),
          prompt: buildPrompt(payload),
          // Per-provider retries as in the chat route — exhausted retries fall
          // through withLlmFallback to the next provider (see llm-provider.ts).
          maxRetries: provider.retries,
        });
      },
    );
    if (debug) {
      console.log(
        buildRawLogLine({
          source: 'success',
          model: servedBy ?? 'unknown',
          items: payload.length,
          text: result.text,
          usage: result.usage,
          response: result.response,
        }),
      );
    }
    merged = mergeLlmResults(transactions, result.output);
  } catch (err) {
    if (debug && err instanceof NoObjectGeneratedError) {
      console.log(
        buildRawLogLine({
          source: 'error',
          model: servedBy ?? 'unknown',
          items: payload.length,
          text: err.text,
          usage: err.usage,
          response: err.response,
        }),
      );
    }
    throw err;
  }
  return merged;
}
