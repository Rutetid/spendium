import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLlmPayload,
  buildPrompt,
  mergeLlmResults,
  type LlmResult,
} from '../src/lib/llm-categorize';
import type { MatchedTransaction } from '../src/lib/match-rules';

function txn(overrides: Partial<MatchedTransaction>): MatchedTransaction {
  return {
    date: '2026-09-10',
    particulars: 'SAMPLE',
    matchKey: 'sample',
    counterparty: null,
    amount: 10,
    type: 'debit',
    category: null,
    tags: [],
    isClarificationNeeded: false,
    userNotes: null,
    ...overrides,
  };
}

const ruleMatched = txn({
  particulars: 'UPIAR/1/DR/Kanishka/SBIN/ 9125923638@ib',
  matchKey: 'upiar1drkanishkasbin9125923638ib',
  counterparty: 'Kanishka',
  category: 'Food & Grocery',
});
const ruleFlagged = txn({
  particulars: 'CONFLICTING HISTORY VENDOR',
  matchKey: 'conflictinghistoryvendor',
  category: 'Travel & Trips',
  isClarificationNeeded: true,
});
const needsLlmA = txn({
  particulars: 'IMPSAB/625414978253/GrowwInvest Tech P/9876543210',
  matchKey: 'impsab625414978253growwinvesttechp9876543210',
});
const needsLlmB = txn({
  particulars: 'UPIAR/9/DR/Blinkit',
  matchKey: 'upiar9drblinkit',
  counterparty: 'Blinkit',
  type: 'credit',
});

const llmA: LlmResult = {
  category: 'Trading & Investments',
  tags: ['groww'],
  confidence: 'high',
};
const llmB: LlmResult = {
  category: 'Food & Grocery',
  tags: ['blinkit'],
  confidence: 'low',
};

test('buildLlmPayload: only null-category rows, in order, sanitized, sequentially indexed', () => {
  const payload = buildLlmPayload([ruleMatched, needsLlmA, ruleFlagged, needsLlmB]);
  assert.equal(payload.length, 2);
  assert.deepEqual(payload[0], {
    i: 0,
    description: 'IMPSAB/ /GrowwInvest Tech P/', // phone 9876543210 + ref stripped
    type: 'debit',
  });
  assert.deepEqual(payload[1], {
    i: 1,
    description: 'Blinkit', // counterparty branch, not raw narration
    type: 'credit',
  });
});

test('merge with mocked LLM response: rule-matched rows untouched, only nulls overwritten', () => {
  const input = [ruleMatched, needsLlmA, ruleFlagged, needsLlmB];
  const merged = mergeLlmResults(input, [llmA, llmB]);

  // Rule-matched rows: identical content (including the clarification flag).
  assert.deepEqual(merged[0], ruleMatched);
  assert.deepEqual(merged[2], ruleFlagged);

  // Null rows filled from the mocked response, in order.
  assert.equal(merged[1].category, 'Trading & Investments');
  assert.deepEqual(merged[1].tags, ['groww']);
  assert.equal(merged[1].isClarificationNeeded, false); // confidence: high
  assert.equal(merged[3].category, 'Food & Grocery');
  assert.deepEqual(merged[3].tags, ['blinkit']);
  assert.equal(merged[3].isClarificationNeeded, true); // confidence: low

  // Nothing left for Step 3.
  assert.ok(merged.every((t) => t.category !== null));
});

test('merge does not mutate its input', () => {
  const input = [needsLlmA];
  mergeLlmResults(input, [llmA]);
  assert.equal(input[0].category, null);
});

test('merge: too-short results throw instead of inserting partial data', () => {
  assert.throws(
    () => mergeLlmResults([needsLlmA, needsLlmB], [llmA]),
    /too short/,
  );
});

test('merge: extra results throw (length mismatch)', () => {
  assert.throws(
    () => mergeLlmResults([needsLlmA], [llmA, llmB]),
    /unused result/,
  );
});

test('merge: no nulls + empty results passes through untouched', () => {
  const allRuleMatched = [ruleMatched, ruleFlagged];
  assert.deepEqual(mergeLlmResults(allRuleMatched, []), allRuleMatched);
});

test('buildPrompt: includes fixed category list, batch size, few-shot placeholder and sanitized descriptions', () => {
  const payload = buildLlmPayload([needsLlmB]);
  const prompt = buildPrompt(payload);
  assert.match(prompt, /Food & Grocery/);
  assert.match(prompt, /Trading & Investments/);
  assert.match(prompt, /exactly 1 elements/);
  assert.match(prompt, /\{"elements": \[\.\.\.\]\}/);
  assert.match(prompt, /PLACEHOLDER/);
  assert.match(prompt, /GROWW -> Trading & Investments/);
  assert.match(prompt, /0\. \[credit\] Blinkit/);
  // Raw PII never appears in the prompt text.
  assert.doesNotMatch(prompt, /@\S+/);
  assert.doesNotMatch(prompt, /\d{9,}/);
});
