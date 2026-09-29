import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Output, generateText } from 'ai';
import { z } from 'zod';
import { CATEGORIES, type CategoryType } from './categories';
import type { MatchedTransaction } from './match-rules';
import { sanitizeForLlm } from './sanitize-for-llm';

/**
 * One LLM categorization result, in the order of the submitted payload.
 * `category` is constrained to the Phase 0 enum — the model cannot return
 * free text; an invalid category fails schema validation and rejects the
 * whole response (AI_NoObjectGeneratedError), it is never silently accepted.
 */
export const llmResultSchema = z.object({
  category: z.enum(CATEGORIES as [CategoryType, ...CategoryType[]]),
  tags: z.array(z.string()),
  confidence: z.enum(['high', 'low']),
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
 * - `confidence: 'low'` sets `isClarificationNeeded: true` (same flag the
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
        result.confidence === 'low' ? true : txn.isClarificationNeeded,
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

Output format: a JSON object {"elements": [...]} containing exactly ${payload.length} elements, one per input transaction, in the same order (element i corresponds to transaction i). Each element must be {"category": "<one category from the list>", "tags": ["short", "labels"], "confidence": "high" | "low"}.

Confidence: "high" when the description clearly implies the category; "low" when you are guessing — unknown merchant, ambiguous wording, or a description that was partially redacted for privacy (handles and phone numbers were removed before sending).

Tags: 0 to 3 short labels (merchant/channel), no personal data.

Example categorizations (PLACEHOLDER set — swap for real confirmed rules later):
${FEW_SHOT_EXAMPLES}

Transactions:
${list}`;
}

/**
 * Categorize all null-category transactions of one upload in a SINGLE
 * schema-validated LLM call (OpenRouter, OpenAI-compatible), then merge the
 * results back. Rule-matched transactions pass through untouched.
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });
  const { output } = await generateText({
    model: provider.chatModel(
      process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    ),
    output: Output.array({
      element: llmResultSchema,
      minItems: payload.length,
      maxItems: payload.length,
    }),
    prompt: buildPrompt(payload),
  });
  return mergeLlmResults(transactions, output);
}
