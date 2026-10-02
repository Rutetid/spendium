import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { withLlmFallback } from '../src/lib/llm-provider';

/** Dummy keys + an explicit two-provider chain, restored after the test. */
function withChain(fn: () => Promise<void>): Promise<void> {
  const saved = {
    order: process.env.PROVIDER_FALLBACK_ORDER,
    gemini: process.env.GEMINI_API_KEY,
    groq: process.env.GROQ_API_KEY,
  };
  process.env.PROVIDER_FALLBACK_ORDER = 'gemini,groq';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GROQ_API_KEY = 'test-key';
  return fn().finally(() => {
    if (saved.order === undefined) delete process.env.PROVIDER_FALLBACK_ORDER;
    else process.env.PROVIDER_FALLBACK_ORDER = saved.order;
    if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.gemini;
    if (saved.groq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved.groq;
  });
}

function schemaError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'No object generated: response did not match schema.',
    text: '{"elements":[]}',
    response: { id: 'resp_test', modelId: 'test-model', timestamp: new Date() },
    usage: {
      inputTokens: 1,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 1,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      totalTokens: 2,
    },
    finishReason: 'stop',
  });
}

test('schema-invalid reply falls through to the next provider', () =>
  withChain(async () => {
    let calls = 0;
    const result = await withLlmFallback('test-schema', async (_model, provider) => {
      calls += 1;
      if (provider.name === 'gemini') throw schemaError();
      return `served-by-${provider.name}`;
    });
    assert.equal(result, 'served-by-groq');
    assert.equal(calls, 2);
  }));

test('transient 429 falls through to the next provider', () =>
  withChain(async () => {
    let calls = 0;
    const result = await withLlmFallback('test-transient', async (_model, provider) => {
      calls += 1;
      if (provider.name === 'gemini') {
        throw new APICallError({
          message: 'rate limited',
          url: 'https://example.invalid',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true,
        });
      }
      return `served-by-${provider.name}`;
    });
    assert.equal(result, 'served-by-groq');
    assert.equal(calls, 2);
  }));

test('non-transient error still fails fast without falling through', () =>
  withChain(async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withLlmFallback('test-fatal', async () => {
          calls += 1;
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(calls, 1);
  }));

test('exhausted chain rethrows the last schema error', () =>
  withChain(async () => {
    process.env.PROVIDER_FALLBACK_ORDER = 'gemini';
    let calls = 0;
    await assert.rejects(
      () =>
        withLlmFallback('test-exhausted', async () => {
          calls += 1;
          throw schemaError();
        }),
      /No object generated/,
    );
    assert.equal(calls, 1);
  }));
