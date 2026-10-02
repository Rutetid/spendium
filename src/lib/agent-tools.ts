import { and, eq, inArray } from 'drizzle-orm';
import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@/db';
import { rules, transactions, type Rule, type Transaction } from '@/db/schema';
import {
  applyScopeOperation,
  effectiveFilters,
  filterTransactions,
  planRuleChange,
  summarizeTransactions,
  type ChatFilterState,
  type ScopeOperation,
} from './agent-plan';
import { CATEGORIES, type CategoryType } from './categories';
import { normalizeMatchKey } from './parse-statement';
import { sanitizeForLlm } from './sanitize-for-llm';

export interface AgentToolContext {
  userId: string;
  /** Ids of the transactions the client currently shows — all data tools
   * are scoped to this set so DB mutations match what the UI displays. */
  scopeIds: readonly string[];
  /** Shared mutable ref holding the client-sent filter scope for this turn;
   * set_scope mutates it, query_transactions reads it. */
  scopeRef: { current: ChatFilterState };
}

const categoryEnum = z.enum(CATEGORIES as [CategoryType, ...CategoryType[]]);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date, e.g. 2026-09-01');

/** Models sometimes double-encode nested tool args, sending a JSON *string*
 * where an object/array belongs (e.g. dateRange: "{\"from\":...}"). Decode
 * before validation instead of failing the call. */
const jsonish = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, schema);

/** Narration safe to hand to the model: raw `particulars` contain third-party
 * PII (UPI handles, phone/reference numbers) that must never reach the model
 * API. Every model-facing string goes through this — DB writes and pattern
 * matching keep using the raw rows. The client renders full detail by id from
 * its own store, so nothing here is display-facing. */
const safeParticulars = (row: { particulars: string }): string =>
  sanitizeForLlm(row) || '(no description)';

async function loadScopeRows({
  userId,
  scopeIds,
}: AgentToolContext): Promise<Transaction[]> {
  if (scopeIds.length === 0) return [];
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.id, [...scopeIds]),
      ),
    );
}

async function loadUserRules(userId: string): Promise<Rule[]> {
  return db.select().from(rules).where(eq(rules.userId, userId));
}

export function createAgentTools(ctx: AgentToolContext) {
  // The AI SDK runs tool calls within one step in parallel (Promise.all);
  // queue every execute so "set_scope, then query" runs in emission order.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const createRule = tool({
    description:
      'Remember a categorization correction for FUTURE uploads. Call this whenever the user states a lasting rule for a vendor (e.g. "X is really Y", "always mark X as Y").',
    inputSchema: z.object({
      vendorPattern: z
        .string()
        .min(1)
        .describe(
          'The vendor fragment as the user named it, e.g. "BITCANT" or "Kanishka". It is normalized (lowercased, stripped) before storing.',
        ),
      category: categoryEnum.describe('One of the allowed categories.'),
      tags: z
        .array(z.string())
        .max(3)
        .nullish()
        .describe('Optional short tags to remember with the rule.'),
    }),
    execute: async ({ vendorPattern, category, tags }) =>
      serialized(async () => {
        const existing = await loadUserRules(ctx.userId);
        const plan = planRuleChange(existing, vendorPattern, category);

        if (plan.action === 'insert') {
          const [row] = await db
            .insert(rules)
            .values({
              id: crypto.randomUUID(),
              userId: ctx.userId,
              vendorPattern: plan.vendorPattern,
              category: plan.category,
              tags: tags ?? [],
            })
            .returning();
          const tagNote =
            row && row.tags.length > 0 ? ` Tags: ${row.tags.join(', ')}.` : '';
          return `Created rule: transactions containing '${plan.vendorPattern}' will now be categorized as ${plan.category}.${tagNote}`;
        }

        if (plan.action === 'append-alternate') {
          const current = existing.find((r) => r.id === plan.ruleId);
          const alternates = [...(current?.alternates ?? []), plan.newAlternate];
          await db
            .update(rules)
            .set({ alternates })
            .where(eq(rules.id, plan.ruleId));
          return (
            `Rule for '${plan.vendorPattern}' already exists with category '${current?.category}'. ` +
            `Recorded '${plan.newAlternate}' as an alternate instead of overwriting; ` +
            `future matches will use '${current?.category}' and be flagged for review.`
          );
        }

        switch (plan.reason) {
          case 'empty-pattern':
            return `Cannot create a rule: '${vendorPattern}' contains no letters or digits.`;
          case 'same-category':
            return `Rule already exists: transactions containing '${plan.vendorPattern}' are already categorized as ${plan.category}.`;
          case 'already-alternate':
            return `'${plan.category}' is already recorded as an alternate for '${plan.vendorPattern}'.`;
        }
      }),
  });

  const applyBulkEdit = tool({
    description:
      'Apply a category to EXISTING transactions whose description contains the pattern. Use together with create_rule when a correction applies to already-uploaded rows. Returns how many rows were updated.',
    inputSchema: z.object({
      vendorPattern: z.string().min(1),
      category: categoryEnum,
    }),
    execute: async ({ vendorPattern, category }) =>
      serialized(async () => {
        const key = normalizeMatchKey(vendorPattern);
        if (key.length === 0) {
          return `No transactions updated: '${vendorPattern}' contains no letters or digits.`;
        }
        const rows = await loadScopeRows(ctx);
        const matched = rows.filter((row) =>
          normalizeMatchKey(row.particulars).includes(key),
        );
        if (matched.length === 0) {
          return `No transactions in the current table contain '${key}'.`;
        }
        await db
          .update(transactions)
          .set({ category })
          .where(
            inArray(
              transactions.id,
              matched.map((row) => row.id),
            ),
          );
        return `Updated ${matched.length} existing transaction(s) containing '${key}' to ${category}.`;
      }),
  });

  const setScope = tool({
    description:
      'Record a change to the structured query scope (date range and category inclusions/exclusions). Refinements ("exclude X", "also exclude Y", "only show Z", "spend Sep 1-15") -> the matching operation; a fresh unrelated topic -> "reset" first. Does NOT touch the database.',
    inputSchema: z.discriminatedUnion('operation', [
      z.object({
        operation: z.literal('exclude'),
        categories: jsonish(z.array(categoryEnum).min(1).max(10)).describe(
          'Categories to exclude from scope — a real JSON array of exact category names.',
        ),
      }),
      z.object({
        operation: z.literal('unexclude'),
        categories: jsonish(z.array(categoryEnum).min(1).max(10)).describe(
          'Categories to remove from the excluded list — a real JSON array.',
        ),
      }),
      z.object({
        operation: z.literal('set_inclusions'),
        categories: jsonish(z.array(categoryEnum).max(10)).describe(
          'Replace the allowed-category list ("only show these") — a real JSON array; empty array clears it.',
        ),
      }),
      z.object({
        operation: z.literal('set_date_range'),
        dateRange: jsonish(z.object({ from: isoDate, to: isoDate })).describe(
          'Inclusive ISO bounds — a real JSON object {from, to}, not a string.',
        ),
      }),
      z.object({ operation: z.literal('clear_date_range') }),
      z.object({ operation: z.literal('reset') }),
    ]),
    execute: async (input: ScopeOperation) =>
      serialized(async () => {
        if (input.operation === 'set_date_range' && input.dateRange.from > input.dateRange.to) {
          return 'Error: dateRange.from is after dateRange.to.';
        }
        ctx.scopeRef.current = applyScopeOperation(ctx.scopeRef.current, input);
        return JSON.stringify({
          operation: input.operation,
          scope: ctx.scopeRef.current,
        });
      }),
  });

  const queryTransactions = tool({
    description:
      'Read-only. Returns transactions matching the filters plus code-computed sums (totalDebit/totalCredit). The current query scope (date range, category exclusions/inclusions) applies automatically — change dates only via set_scope, never here. Pass ignoreScope:true only to locate a row the user references for a flag/mark action — never for spending totals. Use for every numeric question — never compute amounts yourself.',
    inputSchema: z.object({
      category: categoryEnum.nullish(),
      vendorPattern: z
        .string()
        .nullish()
        .describe('Match transactions whose description contains this text.'),
      needsReview: z
        .boolean()
        .nullish()
        .describe(
          'true = only rows flagged for review; false = only unflagged rows.',
        ),
      ignoreScope: z
        .boolean()
        .nullish()
        .describe(
          'true = bypass the current scope to locate a row the user referenced (for flag/mark actions). Never use for spending totals.',
        ),
    }),
    execute: async ({ category, vendorPattern, needsReview, ignoreScope }) =>
      serialized(async () => {
        const rows = await loadScopeRows(ctx);
        const filtered = filterTransactions(
          rows,
          effectiveFilters(ctx.scopeRef.current, {
            category: category ?? undefined,
            vendorPattern: vendorPattern ?? undefined,
            needsReview: needsReview ?? undefined,
            ignoreScope: ignoreScope ?? undefined,
          }),
        );
        const summary = summarizeTransactions(filtered);
        return JSON.stringify({
          ...summary,
          scope: ctx.scopeRef.current,
          transactions: filtered.map((row) => ({
            id: row.id,
            date: row.date,
            particulars: safeParticulars(row),
            amount: row.amount,
            type: row.type,
            category: row.category,
            tags: row.tags,
            isClarificationNeeded: row.isClarificationNeeded,
          })),
        });
      }),
  });

  const flagForReview = tool({
    description:
      'Set the review flag on a single transaction (by id, from a prior query_transactions result or the recent-query listing). Use when the user wants to revisit a row later.',
    inputSchema: z.object({
      transactionId: z.string().min(1),
    }),
    execute: async ({ transactionId }) =>
      serialized(async () => {
        const rows = await loadScopeRows(ctx);
        const row = rows.find((r) => r.id === transactionId);
        if (!row) {
          return `Transaction '${transactionId}' was not found in the current table.`;
        }
        if (row.isClarificationNeeded) {
          return `Transaction ${row.date} "${safeParticulars(row)}" is already flagged for review.`;
        }
        await db
          .update(transactions)
          .set({ isClarificationNeeded: true })
          .where(eq(transactions.id, row.id));
        return `Flagged transaction ${row.date} "${safeParticulars(row)}" (${row.amount.toFixed(2)}) for review.`;
      }),
  });

  return {
    create_rule: createRule,
    apply_bulk_edit: applyBulkEdit,
    set_scope: setScope,
    query_transactions: queryTransactions,
    flag_for_review: flagForReview,
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;

export const AGENT_MUTATING_TOOLS = new Set([
  'create_rule',
  'apply_bulk_edit',
  'flag_for_review',
]);
