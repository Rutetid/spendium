import { generateText, stepCountIs } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { rules, transactions, type Rule, type Transaction } from '@/db/schema';
import { hasLlmProviders, withLlmFallback } from '@/lib/llm-provider';
import {
  AGENT_MUTATING_TOOLS,
  createAgentTools,
} from '@/lib/agent-tools';
import {
  buildAgentSystemPrompt,
  emptyScope,
  inClientOrder,
  type ChatFilterState,
  type RecentQueryRow,
} from '@/lib/agent-plan';
import { CATEGORIES, type CategoryType } from '@/lib/categories';
import { auth } from '@/lib/auth';
import { sanitizeForLlm } from '@/lib/sanitize-for-llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_IDS = 5000;
const CONTEXT_MAX_MESSAGES = 2;
/** Longest context text forwarded to the model — older replies can embed raw
 * tool output; only their opening (where answers live) is worth resending. */
const CONTEXT_SEND_CHARS = 4000;

const contextMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(50_000),
});

const categoryEnum = z.enum(CATEGORIES as [CategoryType, ...CategoryType[]]);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date, e.g. 2026-09-01');

/** Client-held structured scope — persisted in the chat store and sent with
 * every request so follow-up chains ("exclude X" → "also Y" → "just Z")
 * survive the 1-message context window. */
const filterStateSchema = z.object({
  dateRange: z.object({ from: isoDate, to: isoDate }).optional(),
  excludedCategories: z.array(categoryEnum).max(20).default([]),
  includedCategories: z.array(categoryEnum).max(20).default([]),
});

const recentRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  particulars: z.string().max(500),
  amount: z.number(),
  type: z.enum(['debit', 'credit']),
  category: z.string().nullable(),
  isClarificationNeeded: z.boolean(),
});

const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  // The immediately preceding exchange only (prior user message + assistant
  // reply), so follow-ups like "exclude the trading investment" can resolve
  // against the previous turn's answer. Everything older is NOT resent —
  // the rules table is the long-term memory (Phase 3 spec).
  context: z
    .array(contextMessageSchema)
    .max(CONTEXT_MAX_MESSAGES)
    .refine(
      (msgs) =>
        msgs.length !== 2 ||
        (msgs[0]!.role === 'user' && msgs[1]!.role === 'assistant'),
      'context must be the last exchange: user message followed by assistant reply',
    )
    .optional(),
  filterState: filterStateSchema.optional(),
  /** Rows of the most recent query result — lets the model resolve
   * references ("mark that one") by id within the one-turn window. */
  lastResultRows: z.array(recentRowSchema).max(120).optional(),
  transactionIds: z.array(z.string()).max(MAX_IDS),
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return Response.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Expected JSON body.' }, { status: 400 });
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid chat request.' }, { status: 400 });
  }
  const { message, context, filterState, lastResultRows, transactionIds } =
    parsed.data;
  const userId = session.user.id;
  const scopeRef: { current: ChatFilterState } = {
    current: filterState ?? emptyScope(),
  };

  const requestedRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.userId, userId));
  const owned = new Set(requestedRows.map((row) => row.id));
  const scopeIds = transactionIds.filter((id) => owned.has(id));

  const userRules = await db
    .select()
    .from(rules)
    .where(eq(rules.userId, userId));

  if (!hasLlmProviders()) {
    return Response.json(
      { error: 'Chat is not configured (missing API key).' },
      { status: 500 },
    );
  }

  let reply: string;
  let toolNames: string[] = [];
  let resultRows: RecentQueryRow[] | null | undefined;
  try {
    const contextMessages = (context ?? []).map((m) => ({
      role: m.role,
      content:
        m.content.length > CONTEXT_SEND_CHARS
          ? `${m.content.slice(0, CONTEXT_SEND_CHARS)}…`
          : m.content,
    }));
    const result = await withLlmFallback('chat', (model, provider) =>
      generateText({
        model,
        system: buildAgentSystemPrompt({
          rules: userRules,
          today: new Date().toISOString().slice(0, 10),
          transactionCount: scopeIds.length,
          scope: scopeRef.current,
          // Re-sanitize the echoed rows at the prompt boundary — tool output
          // is already sanitized at the source, but stale rows persisted by
          // older clients (localStorage) may still be raw.
          recentRows: lastResultRows?.map((row) => ({
            ...row,
            particulars: sanitizeForLlm(row) || '(no description)',
          })),
        }),
        // Exactly one exchange of short-term context (the immediately preceding
        // user message + assistant reply) plus the CURRENT message; persisted
        // history beyond that stays client-side for display only (per Phase 3
        // spec — the rules table is the long-term memory).
        messages: [
          ...contextMessages,
          { role: 'user' as const, content: message },
        ],
        tools: createAgentTools({ userId, scopeIds, scopeRef }),
        stopWhen: stepCountIs(5),
        // Per-provider SDK retries ride out retryable rate-limit windows in
        // place (same behavior as the old single-provider maxRetries: 6);
        // exhausted retries fall through withLlmFallback to the next provider.
        maxRetries: provider.retries,
      }),
    );
    reply = result.text.trim();
    toolNames = [
      ...new Set(
        result.steps.flatMap((step) =>
          step.toolCalls.map((call) => call.toolName),
        ),
      ),
    ];
    // Persist the newest query's rows for the NEXT request so references
    // ("mark that one") resolve inside the one-turn window. A scope reset
    // without a follow-up query clears them so stale rows can't be re-hit.
    const toolResults = result.steps.flatMap((step) => step.toolResults);
    const queriedRows = toolResults
      .filter((r) => r.toolName === 'query_transactions')
      .flatMap((r) => {
        try {
          const parsedOutput = JSON.parse(String(r.output)) as {
            transactions?: RecentQueryRow[];
          };
          return parsedOutput.transactions ?? [];
        } catch {
          return [];
        }
      });
    const resetRan = toolResults.some((r) => {
      if (r.toolName !== 'set_scope') return false;
      try {
        const parsedOutput = JSON.parse(String(r.output)) as {
          operation?: string;
        };
        return parsedOutput.operation === 'reset';
      } catch {
        return false;
      }
    });
    if (queriedRows.length > 0) {
      resultRows = queriedRows.slice(0, 80);
    } else if (resetRan) {
      resultRows = null;
    }
    if (reply.length === 0) {
      const outputs = result.steps
        .flatMap((step) => step.toolResults)
        .map((r) => String(r.output ?? ''))
        .filter(Boolean);
      reply = outputs.length > 0 ? outputs.join('\n') : 'Done.';
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[chat] steps=${result.steps.length} tools=[${toolNames.join(', ')}]`,
      );
    }
  } catch (error) {
    console.error('[chat] agent failed:', error);
    return Response.json(
      { error: 'Something went wrong while running the assistant.' },
      { status: 502 },
    );
  }

  let transactionsOut: Transaction[] | undefined;
  let rulesOut: Rule[] | undefined;
  const touchedData = toolNames.some((name) => AGENT_MUTATING_TOOLS.has(name));
  if (touchedData && toolNames.some((name) => name !== 'create_rule')) {
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId));
    const scope = new Set(scopeIds);
    const byScope = rows.filter((row) => scope.has(row.id));
    transactionsOut = inClientOrder(scopeIds, byScope);
  }
  if (toolNames.includes('create_rule')) {
    rulesOut = await db
      .select()
      .from(rules)
      .where(eq(rules.userId, userId));
  }

  return Response.json({
    reply,
    toolNames,
    filterState: scopeRef.current,
    ...(resultRows !== undefined ? { lastResultRows: resultRows } : {}),
    ...(transactionsOut ? { transactions: transactionsOut } : {}),
    ...(rulesOut ? { rules: rulesOut } : {}),
  });
}
