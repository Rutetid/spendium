import { CATEGORIES, type CategoryType } from './categories';
import { normalizeMatchKey } from './parse-statement';

/**
 * Pure planning/summary helpers for the Phase 3 chat agent. No I/O and no
 * imports from `@/db` (the db module throws without DATABASE_URL, so unit
 * tests import this file directly).
 */

export interface RuleRecord {
  id: string;
  vendorPattern: string;
  category: CategoryType;
  confidence: number;
  alternates: readonly string[];
}

/**
 * Decides what `create_rule` should do with an incoming correction.
 * `vendorPattern` on every branch is the NORMALIZED pattern (same
 * normalization Step 2's matcher stores), never the raw user text.
 */
export type RuleChangePlan =
  | { action: 'insert'; vendorPattern: string; category: CategoryType }
  | {
      action: 'append-alternate';
      ruleId: string;
      vendorPattern: string;
      category: CategoryType;
      newAlternate: CategoryType;
    }
  | {
      action: 'noop';
      reason: 'empty-pattern' | 'same-category' | 'already-alternate';
      vendorPattern: string;
      category: CategoryType;
    };

export function planRuleChange(
  existing: readonly RuleRecord[],
  rawPattern: string,
  category: CategoryType,
): RuleChangePlan {
  const vendorPattern = normalizeMatchKey(rawPattern);
  if (vendorPattern.length === 0) {
    return { action: 'noop', reason: 'empty-pattern', vendorPattern, category };
  }
  const rule = existing.find((r) => r.vendorPattern === vendorPattern);
  if (!rule) {
    return { action: 'insert', vendorPattern, category };
  }
  if (rule.category === category) {
    return { action: 'noop', reason: 'same-category', vendorPattern, category };
  }
  if (rule.alternates.includes(category)) {
    return {
      action: 'noop',
      reason: 'already-alternate',
      vendorPattern,
      category,
    };
  }
  return {
    action: 'append-alternate',
    ruleId: rule.id,
    vendorPattern,
    category,
    newAlternate: category,
  };
}

export interface QueryFilters {
  category?: CategoryType;
  /** Rows must have one of these categories (OR). Merged from the client-held
   * scope; single-category calls collapse into `category` at the call site. */
  includedCategories?: readonly CategoryType[];
  /** Rows with these categories are dropped — applied AFTER inclusions. */
  excludedCategories?: readonly CategoryType[];
  dateRange?: { from?: string; to?: string };
  vendorPattern?: string;
  needsReview?: boolean;
}

/** Structured conversational scope for follow-up refinement chains ("exclude
 * trading" → "also exclude peer" → "just food"). Held client-side, sent with
 * every chat request, mutated ONLY through `applyScopeOperation` via the
 * set_scope tool — never re-derived from model prose. */
export interface ChatFilterState {
  dateRange?: { from: string; to: string };
  excludedCategories: CategoryType[];
  includedCategories: CategoryType[];
}

export function emptyScope(): ChatFilterState {
  return { excludedCategories: [], includedCategories: [] };
}

/** One deterministic state transition per set_scope call — the union keeps
 * each operation unambiguous for the model and trivially testable in code. */
export type ScopeOperation =
  | { operation: 'exclude'; categories: CategoryType[] }
  | { operation: 'unexclude'; categories: CategoryType[] }
  | { operation: 'set_inclusions'; categories: CategoryType[] }
  | { operation: 'set_date_range'; dateRange: { from: string; to: string } }
  | { operation: 'clear_date_range' }
  | { operation: 'reset' };

const dedupe = (values: CategoryType[]): CategoryType[] => [...new Set(values)];

export function applyScopeOperation(
  scope: ChatFilterState,
  op: ScopeOperation,
): ChatFilterState {
  switch (op.operation) {
    case 'exclude':
      return {
        ...scope,
        excludedCategories: dedupe([...scope.excludedCategories, ...op.categories]),
      };
    case 'unexclude':
      return {
        ...scope,
        excludedCategories: scope.excludedCategories.filter(
          (c) => !op.categories.includes(c),
        ),
      };
    case 'set_inclusions':
      return { ...scope, includedCategories: dedupe([...op.categories]) };
    case 'set_date_range':
      return { ...scope, dateRange: { ...op.dateRange } };
    case 'clear_date_range': {
      const next: ChatFilterState = { ...scope };
      delete next.dateRange;
      return next;
    }
    case 'reset':
      return emptyScope();
  }
}

/** Per-call arguments of query_transactions (the model-facing tool input). */
export interface CallFilters {
  category?: CategoryType;
  dateRange?: { from?: string; to?: string };
  vendorPattern?: string;
  needsReview?: boolean;
  /** Locate a row the user referenced even when the scope hides it (for
   * flag/mark actions). Never for spending totals. */
  ignoreScope?: boolean;
}

/** Base scope from the client + per-call overrides → filterTransactions input.
 * Precedence: explicit call args (category/dateRange) win over base for THIS
 * call; base exclusions always apply; `ignoreScope` drops the base entirely. */
export function effectiveFilters(
  base: ChatFilterState,
  call: CallFilters,
): QueryFilters {
  if (call.ignoreScope === true) {
    return {
      category: call.category,
      dateRange: call.dateRange,
      vendorPattern: call.vendorPattern,
      needsReview: call.needsReview,
    };
  }
  const inclusions =
    call.category !== undefined ? [call.category] : base.includedCategories;
  return {
    dateRange: call.dateRange ?? base.dateRange,
    includedCategories:
      inclusions.length > 0 ? [...inclusions] : undefined,
    excludedCategories:
      base.excludedCategories.length > 0
        ? [...base.excludedCategories]
        : undefined,
    vendorPattern: call.vendorPattern,
    needsReview: call.needsReview,
  };
}

/** Compact row summary persisted from the last query_transactions result so
 * the next turn can resolve "that one" / "the third one" by id. */
export interface RecentQueryRow {
  id: string;
  date: string;
  particulars: string;
  amount: number;
  type: 'debit' | 'credit';
  category: string | null;
  isClarificationNeeded: boolean;
}

export interface SummaryRow {
  id: string;
  date: string;
  particulars: string;
  amount: number;
  type: 'debit' | 'credit';
  category: string | null;
  tags: string[];
  isClarificationNeeded: boolean;
}

/** In-memory filter over an already scope-limited row set (vendor matching
 * reuses `normalizeMatchKey`, same as the Step 2 matcher). */
export function filterTransactions(
  rows: readonly SummaryRow[],
  filters: QueryFilters,
): SummaryRow[] {
  const key =
    filters.vendorPattern === undefined
      ? null
      : normalizeMatchKey(filters.vendorPattern);
  return rows.filter((row) => {
    if (filters.category !== undefined && row.category !== filters.category) {
      return false;
    }
    if (
      filters.includedCategories !== undefined &&
      filters.includedCategories.length > 0 &&
      (row.category === null ||
        !(filters.includedCategories as readonly string[]).includes(row.category))
    ) {
      return false;
    }
    if (
      filters.excludedCategories !== undefined &&
      row.category !== null &&
      (filters.excludedCategories as readonly string[]).includes(row.category)
    ) {
      return false;
    }
    if (filters.dateRange?.from !== undefined && row.date < filters.dateRange.from) {
      return false;
    }
    if (filters.dateRange?.to !== undefined && row.date > filters.dateRange.to) {
      return false;
    }
    if (
      filters.needsReview !== undefined &&
      row.isClarificationNeeded !== filters.needsReview
    ) {
      return false;
    }
    if (key !== null) {
      if (key.length === 0) return false;
      if (!normalizeMatchKey(row.particulars).includes(key)) return false;
    }
    return true;
  });
}

export interface TransactionSummary {
  count: number;
  totalDebit: number;
  totalCredit: number;
}

/** All arithmetic lives here — the LLM only ever relays these numbers. */
export function summarizeTransactions(
  rows: readonly { amount: number; type: 'debit' | 'credit' }[],
): TransactionSummary {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const row of rows) {
    if (row.type === 'debit') totalDebit += row.amount;
    else totalCredit += row.amount;
  }
  return {
    count: rows.length,
    totalDebit: Math.round((totalDebit + Number.EPSILON) * 100) / 100,
    totalCredit: Math.round((totalCredit + Number.EPSILON) * 100) / 100,
  };
}

/** Restores the client's original row order after a DB refresh, so the
 * table doesn't visibly reshuffle when the agent mutates rows. */
export function inClientOrder<T extends { id: string }>(
  ids: readonly string[],
  rows: readonly T[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}

export interface AgentPromptOptions {
  rules: readonly RuleRecord[];
  today: string;
  transactionCount: number;
  /** Structured scope the client sent with this message (pre-turn state). */
  scope: ChatFilterState;
  /** Rows of the most recent query_transactions result (pre-turn state) —
   * for resolving references like "that one" / "the third one". */
  recentRows?: readonly RecentQueryRow[];
}

const RECENT_ROWS_PROMPT_CAP = 40;

function describeScope(scope: ChatFilterState): string {
  const date = scope.dateRange
    ? `${scope.dateRange.from} to ${scope.dateRange.to}`
    : 'none';
  const excluded =
    scope.excludedCategories.length > 0
      ? scope.excludedCategories.join(', ')
      : 'none';
  const included =
    scope.includedCategories.length > 0
      ? scope.includedCategories.join(', ')
      : 'none';
  return `Current query scope (structured; the client sends it with every message and it persists across turns):
- date range: ${date}
- excluded categories: ${excluded}
- included categories: ${included}`;
}

function describeRecentRows(rows: readonly RecentQueryRow[]): string {
  const shown = rows.slice(0, RECENT_ROWS_PROMPT_CAP);
  const lines = shown.map(
    (r) =>
      `- [${r.id}] ${r.date} ${r.type} ${r.amount} ${r.category ?? '(uncategorized)'}${r.isClarificationNeeded ? ' [flagged]' : ''}: ${r.particulars.slice(0, 70)}`,
  );
  const hidden = rows.length - shown.length;
  return (
    'Most recent query result (each row includes its id — use these ids for flag/mark actions on referenced rows):\n' +
    lines.join('\n') +
    (hidden > 0 ? `\n…and ${hidden} more rows not shown (re-query if needed).` : '')
  );
}

export function buildAgentSystemPrompt({
  rules,
  today,
  transactionCount,
  scope,
  recentRows,
}: AgentPromptOptions): string {
  const ruleLines =
    rules.length === 0
      ? '(none saved yet)'
      : rules
          .map(
            (rule) =>
              `- description contains "${rule.vendorPattern}" -> ${rule.category}` +
              (rule.alternates.length > 0
                ? ` (alternates: ${rule.alternates.join(', ')})`
                : ''),
          )
          .join('\n');

  const recentSection =
    recentRows !== undefined && recentRows.length > 0
      ? `\n\n${describeRecentRows(recentRows)}\n`
      : '';

  return `You are Spendium's categorization assistant. You operate on the user's bank transactions through tools; you never mutate data yourself.

Today's date: ${today} (ISO; use it to interpret relative dates like "this month").

Allowed categories (exact strings): ${CATEGORIES.join(', ')}

Current saved rules — patterns are pre-normalized (lowercase, alphanumeric only), a rule matches a transaction when its description CONTAINS the pattern:
${ruleLines}

${describeScope(scope)}${recentSection}

Tools:
- create_rule: remember a categorization correction for FUTURE uploads.
- apply_bulk_edit: apply a categorization to EXISTING transactions right now.
- query_transactions: fetch matching transactions plus code-computed sums. Applies the current query scope automatically; pass ignoreScope:true only to LOCATE a row the user references for a flag/mark action — never for spending totals. Use this for ANY number — never add or estimate amounts yourself.
- set_scope: record scope changes ("exclude X", "also exclude Y", "only show Z", a date range) or reset it for a fresh topic. It does NOT touch the database.
- flag_for_review: set the review flag on a single transaction.

How to act:
- Scope rules: the structured scope above applies to every query_transactions call automatically. Decide by CUES in the user's message, not by whether the topic looks related to your last reply:
  • REFINING — the message contains a continuation cue ("also", "instead", "excluding", "exclude", "just", "only", "keep", "still", "add", "remove", "drop", "narrow", "but", "plus", or a date range): call set_scope FIRST with the matching operation, then query.
  • FRESH — the message contains NO continuation cue (e.g. a plain question like "How much did I spend on food?" even right after you showed a filtered food list): you MUST call set_scope with operation "reset" FIRST, then handle the question. A fresh answer must never inherit date/category filters from earlier turns.
  Never try to carry scope in prose — it lives only in this structured object.
- References: to resolve "that one", "the third one", "this row" use the most recent query result listed above (ids included), or run query_transactions yourself. If the referenced row is hidden by the current scope (e.g. the user excluded its category but now wants to act on it), re-query with ignoreScope:true to locate it for the action. If exactly one row matches the reference, act on it immediately (flag/mark with its id) without asking. If several rows match, name them briefly and ask which one. Row actions (flag/mark/undo) NEVER change the scope.
- You may see the immediately preceding exchange (the user's previous message and your reply to it) as context — follow-ups like "exclude the trading investment" refer to THAT exchange. Anything older is not in your context; the saved rules above are the long-term memory. If a follow-up could refer to something older, ask the user instead of guessing.
- The user's table currently shows ${transactionCount} transaction(s) from their uploaded statement — corrections about existing spending apply to THOSE rows.
- A categorization correction for a vendor ("X is really Y", "mark X as Y", "always mark X as Y", "remember X is Y") -> call create_rule AND apply_bulk_edit TOGETHER in the same turn. create_rule remembers it for future uploads; apply_bulk_edit fixes the rows already in the table. Example: "BITCANT is the college canteen, always mark it as Food & Grocery" -> BOTH tools with vendorPattern "BITCANT" and category "Food & Grocery", same turn.
- Skip apply_bulk_edit ONLY when the user explicitly protects existing rows ("for future uploads only", "don't change the existing ones").
- Questions ("how much", "show me", "what") -> query_transactions only; do not create rules.
- If create_rule reports an existing rule with a different category, tell the user the new category was recorded as an alternate and future matches will be flagged for review. Never claim the original rule was replaced.
- Reply concisely with the exact counts/amounts the tools returned. Never invent figures. If a tool reports an error or zero matches, say so plainly.`;
}
