import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from 'ai';

export type ResolvedProvider = {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  retries: number;
  /** Hard per-attempt bound in ms (see attemptTimeoutMiddleware). */
  attemptTimeoutMs?: number;
};

type ProviderDefaults = {
  baseURL: string;
  defaultModel: string;
  /**
   * In-provider SDK retries for *retryable* errors (429 with a short
   * retry-after, 5xx): the AI SDK waits out rate-limit windows in place, which
   * is what makes a free-tier TPM window succeed without changing providers.
   * OpenRouter's free tier is a daily quota — waiting never helps — so it
   * fails fast and lets the caller's own retry take over.
   */
  retries: number;
  /**
   * Optional per-attempt timeout. Use it when the observed failure mode is a
   * slow/stalling connection rather than a clean rejection — the SDK's own
   * connect timeout does not bound a response that trickles in after the
   * headers arrive, and fewer retries alone still allow one attempt to hang
   * for tens of seconds.
   */
  attemptTimeoutMs?: number;
};

/**
 * Known OpenAI-compatible providers. Env prefix is the uppercased name, so
 * each one is configured with `{NAME}_API_KEY` (required — entries without a
 * key are skipped) plus optional `{NAME}_MODEL` / `{NAME}_BASE_URL` overrides.
 *
 * Gemini's free tier (30 RPM, 250K TPM, 500 RPD per model) is the widest
 * headroom in the chain — and quotas are per model, so `gemini31` on the
 * same key is a genuinely separate 500 RPD bucket, not a shared one. Chain
 * ORDER still comes from PROVIDER_FALLBACK_ORDER: a key reporting zero
 * quota (the Mistral failure mode: x-ratelimit-limit-req-minute: 0 on
 * every request) must not sit first.
 */
const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.5-flash-lite',
    // 30 RPM ≈ one request per 2s: a short backoff rides out a burst
    // window, but fewer retries than groq so a real outage falls through
    // the chain faster.
    retries: 4,
  },
  gemini31: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.1-flash-lite',
    retries: 4,
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
    retries: 6,
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    retries: 6,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    retries: 0,
  },
};

const DEFAULT_FALLBACK_ORDER = 'gemini,gemini31,groq,openrouter';

/**
 * Resolve the provider chain from PROVIDER_FALLBACK_ORDER (comma-separated,
 * default `gemini,gemini31,groq,openrouter`), skipping unknown names and
 * providers without an API key.
 */
export function resolveProviderChain(): ResolvedProvider[] {
  const rawOrder =
    process.env.PROVIDER_FALLBACK_ORDER || DEFAULT_FALLBACK_ORDER;
  const chain: ResolvedProvider[] = [];
  for (const entry of rawOrder.split(',')) {
    const name = entry.trim().toLowerCase();
    if (name === '') continue;
    const defaults = PROVIDER_DEFAULTS[name];
    if (!defaults) {
      console.warn(`[llm] unknown provider "${name}" in PROVIDER_FALLBACK_ORDER — skipped`);
      continue;
    }
    const prefix = name.toUpperCase();
    const apiKey = process.env[`${prefix}_API_KEY`];
    if (!apiKey) continue;
    chain.push({
      name,
      apiKey,
      baseURL: process.env[`${prefix}_BASE_URL`] || defaults.baseURL,
      model: process.env[`${prefix}_MODEL`] || defaults.defaultModel,
      retries: defaults.retries,
      attemptTimeoutMs: defaults.attemptTimeoutMs,
    });
  }
  return chain;
}

export function hasLlmProviders(): boolean {
  return resolveProviderChain().length > 0;
}

/**
 * Reasoning-capable models (e.g. gpt-oss on Groq) return reasoning text that
 * the OpenAI-compatible provider echoes back on the next agent step as
 * `reasoning_content` — which some endpoints (Groq) reject on input. Strip
 * reasoning parts from the outgoing prompt; the model does not need them.
 */
const stripEchoedReasoning: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    prompt: params.prompt.map((message) =>
      message.role === 'assistant' && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.filter((part) => part.type !== 'reasoning'),
          }
        : message,
    ),
  }),
};

/**
 * fetch wrapper that aborts a request — including a response body still in
 * flight after the headers arrived — once the attempt timeout elapses. The
 * abort frees the connection before the SDK's backoff triggers the next
 * attempt (relevant for 1-RPS providers, where a lingering request would
 * keep consuming the rate budget). A timeout before the headers arrive is
 * converted into a retryable APICallError here; timeouts observed later
 * during body consumption surface from doGenerate and are normalized by
 * attemptTimeoutMiddleware instead. Caller-initiated aborts are left alone
 * so they keep their no-retry/no-fallback semantics.
 */
function fetchWithAttemptTimeout(attemptTimeoutMs: number): typeof globalThis.fetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
    const callerSignal = init?.signal ?? null;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    try {
      return await globalThis.fetch(input, { ...init, signal });
    } catch (error) {
      if (timeoutSignal.aborted && !callerSignal?.aborted) {
        throw new APICallError({
          message: `Attempt timed out after ${attemptTimeoutMs}ms`,
          url: String(input),
          requestBodyValues: {},
          cause: error,
          isRetryable: true,
        });
      }
      throw error;
    }
  };
}

/**
 * Per-attempt timeout for providers whose observed failure mode is slow body
 * transfer. Races the whole doGenerate (headers AND body) against the
 * timeout and normalizes a timeout into a retryable APICallError — the SDK
 * retries it under maxRetries, and withLlmFallback classifies it as
 * transient, so an exhausted provider falls through to the next one instead
 * of failing the request. The hook runs on every doGenerate call, i.e. once
 * per attempt. Caller-initiated aborts (params.abortSignal) are rethrown
 * unchanged.
 */
function attemptTimeoutMiddleware(
  attemptTimeoutMs: number,
  url: string,
): LanguageModelMiddleware {
  const timedOutError = (cause?: unknown): APICallError =>
    new APICallError({
      message: `Attempt timed out after ${attemptTimeoutMs}ms`,
      url,
      requestBodyValues: {},
      cause,
      isRetryable: true,
    });
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timedOutError()), attemptTimeoutMs);
      });
      try {
        return await Promise.race([doGenerate(), timeout]);
      } catch (error) {
        if (params.abortSignal?.aborted) throw error;
        if (error instanceof APICallError) throw error;
        // AbortSignal.timeout rejection that escaped the fetch layer during
        // body consumption (name 'TimeoutError', unlike caller AbortErrors).
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { name?: string }).name === 'TimeoutError'
        ) {
          throw timedOutError(error);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function createProviderModel(provider: ResolvedProvider): LanguageModel {
  const compat = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    fetch: provider.attemptTimeoutMs
      ? fetchWithAttemptTimeout(provider.attemptTimeoutMs)
      : undefined,
  });
  const middleware: LanguageModelMiddleware = provider.attemptTimeoutMs
    ? {
        ...stripEchoedReasoning,
        ...attemptTimeoutMiddleware(
          provider.attemptTimeoutMs,
          `${provider.baseURL}/chat/completions`,
        ),
      }
    : stripEchoedReasoning;
  return wrapLanguageModel({
    model: compat.chatModel(provider.model),
    middleware,
  });
}

/**
 * Transient per-provider faults worth falling through: rate limits
 * (429 — daily/request limits; 413 — Groq TPM window), provider-side 5xx,
 * and network-level faults (connect/read timeouts and refused connections —
 * APICallError without an HTTP status, which the SDK marks retryable).
 * Everything else (400 bad request, 401/403 auth) is a real error that
 * would repeat on every provider, so it fails fast instead of being masked
 * by the chain. Schema-validation failures (`NoObjectGeneratedError`) are
 * handled at the call site in `withLlmFallback` — a model that ignored the
 * output schema is exactly the provider to skip, not to trust with a retry.
 */
function isTransientProviderError(error: unknown): boolean {
  if (error instanceof RetryError) {
    // SDK-level retries were exhausted (retryable statuses / network).
    return isTransientProviderError(error.lastError);
  }
  if (error instanceof APICallError) {
    const status = error.statusCode;
    // No HTTP status: network-level fault. Transient only when the SDK
    // classified it retryable — a bare abort or schema-shaped failure with
    // no status is not something the next provider can fix either.
    if (status === undefined) return error.isRetryable === true;
    return status === 429 || status === 413 || status >= 500;
  }
  return false;
}

function describeStatus(error: unknown): string {
  if (error instanceof APICallError && error.statusCode !== undefined) {
    return String(error.statusCode);
  }
  if (error instanceof RetryError) {
    return `retries-exhausted (${describeStatus(error.lastError)})`;
  }
  return 'unknown';
}

/**
 * Run `fn` against the configured provider chain, falling through to the next
 * provider on transient faults (429/413/5xx — including exhausted in-provider
 * SDK retries, see `ProviderDefaults.retries`) and on schema-invalid replies
 * (`NoObjectGeneratedError`) so a single provider's rate limits or a single
 * bad completion never fail the whole request. Non-transient errors are
 * rethrown immediately. Dev logs which provider served the request
 * (`[llm] <label>: served by <provider> (<model>)`, same style as the existing
 * `[chat]` logs) and warns on every fallback, so a provider that starts
 * failing is visible instead of silently eating requests. Call sites should
 * pass `maxRetries: provider.retries` to `generateText`. */
export async function withLlmFallback<T>(
  label: string,
  fn: (model: LanguageModel, provider: ResolvedProvider) => Promise<T>,
): Promise<T> {
  const chain = resolveProviderChain();
  if (chain.length === 0) {
    throw new Error('LLM API key is not set');
  }
  let lastError: unknown;
  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i];
    try {
      const result = await fn(createProviderModel(provider), provider);
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[llm] ${label}: served by ${provider.name} (${provider.model})`,
        );
      }
      return result;
    } catch (error) {
      if (process.env.LLM_DEBUG === '1') {
        const first =
          error instanceof RetryError && error.errors.length > 0
            ? error.errors[0]
            : error;
        if (first instanceof APICallError) {
          console.warn(
            `[llm] ${label}: ${provider.name} attempt-fail status=${first.statusCode ?? '?'} body=${(first.responseBody ?? first.message).slice(0, 240)}`,
          );
        } else {
          console.warn(
            `[llm] ${label}: ${provider.name} attempt-fail ${String(first instanceof Error ? first.message : first)}`.slice(0, 300),
          );
        }
      }
      const schemaInvalid = error instanceof NoObjectGeneratedError;
      if (!schemaInvalid && !isTransientProviderError(error)) throw error;
      lastError = error;
      const next = chain[i + 1];
      if (!next) break;
      console.warn(
        schemaInvalid
          ? `[llm] ${label}: ${provider.name} schema-invalid reply — falling back to ${next.name}`
          : `[llm] ${label}: ${provider.name} transient failure (${describeStatus(error)}) — falling back to ${next.name}`,
      );
    }
  }
  throw lastError;
}
