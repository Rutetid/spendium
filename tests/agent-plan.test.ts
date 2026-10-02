import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyScopeOperation,
  buildAgentSystemPrompt,
  effectiveFilters,
  emptyScope,
  filterTransactions,
  inClientOrder,
  planRuleChange,
  summarizeTransactions,
  type ChatFilterState,
  type RuleRecord,
  type SummaryRow,
} from '../src/lib/agent-plan';
import { parseStatement } from '../src/lib/parse-statement';

function rule(overrides: Partial<RuleRecord>): RuleRecord {
  return {
    id: 'r1',
    vendorPattern: 'bitcant',
    category: 'Food & Grocery',
    confidence: 1,
    alternates: [],
    ...overrides,
  };
}

function row(overrides: Partial<SummaryRow>): SummaryRow {
  return {
    id: 't1',
    date: '2026-09-10',
    particulars: 'UPIAR/1/DR/SAMPLE',
    amount: 100,
    type: 'debit',
    category: 'Other',
    tags: [],
    isClarificationNeeded: false,
    ...overrides,
  };
}

test('planRuleChange: new pattern inserts, normalized exactly like Step 2', () => {
  const plan = planRuleChange([], 'BITCANT!! ', 'Food & Grocery');
  assert.deepEqual(plan, {
    action: 'insert',
    vendorPattern: 'bitcant',
    category: 'Food & Grocery',
  });
});

test('planRuleChange: same category is a noop, not a duplicate rule', () => {
  const plan = planRuleChange(
    [rule({})],
    'Bitcant',
    'Food & Grocery',
  );
  assert.equal(plan.action, 'noop');
  assert.equal(
    plan.action === 'noop' ? plan.reason : '',
    'same-category',
  );
});

test('planRuleChange: different category lands in alternates, never overwrites', () => {
  const plan = planRuleChange(
    [rule({ category: 'Trading & Investments' })],
    'bitcant',
    'Food & Grocery',
  );
  assert.equal(plan.action, 'append-alternate');
  if (plan.action === 'append-alternate') {
    assert.equal(plan.ruleId, 'r1');
    assert.equal(plan.newAlternate, 'Food & Grocery');
  }
});

test('planRuleChange: repeat conflict is idempotent (already an alternate)', () => {
  const plan = planRuleChange(
    [rule({ category: 'Trading & Investments', alternates: ['Food & Grocery'] })],
    'bitcant',
    'Food & Grocery',
  );
  assert.equal(plan.action, 'noop');
  assert.equal(
    plan.action === 'noop' ? plan.reason : '',
    'already-alternate',
  );
});

test('planRuleChange: pattern without letters/digits never matches everything', () => {
  const plan = planRuleChange([], '///', 'Other');
  assert.equal(plan.action, 'noop');
  assert.equal(plan.action === 'noop' ? plan.reason : '', 'empty-pattern');
});

test('filterTransactions: category, inclusive date bounds, needsReview', () => {
  const rows = [
    row({ id: 'a', date: '2026-09-01', category: 'Food & Grocery' }),
    row({ id: 'b', date: '2026-09-30', category: 'Other' }),
    row({
      id: 'c',
      date: '2026-08-15',
      category: 'Food & Grocery',
      isClarificationNeeded: true,
    }),
    row({ id: 'd', date: '2026-10-01', category: 'Food & Grocery' }),
  ];
  const foodSept = filterTransactions(rows, {
    category: 'Food & Grocery',
    dateRange: { from: '2026-09-01', to: '2026-09-30' },
  });
  assert.deepEqual(foodSept.map((r) => r.id), ['a']);

  const flagged = filterTransactions(rows, { needsReview: true });
  assert.deepEqual(flagged.map((r) => r.id), ['c']);

  const unflagged = filterTransactions(rows, { needsReview: false });
  assert.deepEqual(unflagged.map((r) => r.id), ['a', 'b', 'd']);
});

test('filterTransactions: vendor pattern uses normalizeMatchKey containment on real narration', () => {
  const parsed = parseStatement(
    readFileSync(
      path.join(__dirname, 'fixtures', 'union-bank-75.txt'),
      'utf8',
    ),
  );
  const rows: SummaryRow[] = parsed.transactions.map((txn, i) => ({
    id: String(i),
    date: txn.date,
    particulars: txn.particulars,
    amount: txn.amount,
    type: txn.type,
    category: 'Other',
    tags: [],
    isClarificationNeeded: false,
  }));

  const bitcant = filterTransactions(rows, { vendorPattern: 'BITCANT ' });
  assert.equal(bitcant.length, 2);
  assert.ok(bitcant.every((r) => r.particulars.includes('BITCANT')));

  const groww = filterTransactions(rows, { vendorPattern: 'groww' });
  assert.ok(groww.length >= 6);

  assert.equal(
    filterTransactions(rows, { vendorPattern: '///' }).length,
    0,
    'empty normalized pattern must match nothing',
  );
});

test('summarizeTransactions: code-computed debit/credit totals, rounded to 2dp', () => {
  const summary = summarizeTransactions([
    row({ amount: 100.005, type: 'debit' }),
    row({ amount: 200.456, type: 'debit' }),
    row({ amount: 50, type: 'credit' }),
    row({ amount: 25.5, type: 'credit' }),
  ]);
  assert.deepEqual(summary, {
    count: 4,
    totalDebit: 300.46,
    totalCredit: 75.5,
  });
});

test('inClientOrder: restores client order, drops missing ids and extras', () => {
  const rows = [
    { id: 'x', n: 1 },
    { id: 'y', n: 2 },
    { id: 'z', n: 3 },
  ];
  assert.deepEqual(
    inClientOrder(['y', 'x', 'missing'], rows),
    [
      { id: 'y', n: 2 },
      { id: 'x', n: 1 },
    ],
  );
  assert.deepEqual(inClientOrder([], rows), []);
});

test('buildAgentSystemPrompt: date, categories, rule state, both-tool guidance, no-invention rule', () => {
  const prompt = buildAgentSystemPrompt({
    rules: [
      rule({
        vendorPattern: 'kanishka',
        category: 'Trading & Investments',
        alternates: ['Food & Grocery'],
      }),
    ],
    today: '2026-09-29',
    transactionCount: 74,
    scope: emptyScope(),
  });
  assert.match(prompt, /Today's date: 2026-09-29/);
  assert.match(prompt, /currently shows 74 transaction/);
  assert.match(prompt, /Food & Grocery/);
  assert.match(prompt, /Bank Charges/);
  assert.match(prompt, /description contains "kanishka" -> Trading & Investments/);
  assert.match(prompt, /alternates: Food & Grocery/);
  assert.match(prompt, /create_rule AND apply_bulk_edit TOGETHER/);
  assert.match(prompt, /never add or estimate amounts yourself/);
  assert.match(prompt, /Never invent figures/);
  assert.match(prompt, /immediately preceding exchange/);
  assert.match(prompt, /ask the user instead of guessing/);

  const empty = buildAgentSystemPrompt({
    rules: [],
    today: '2026-09-29',
    transactionCount: 0,
    scope: emptyScope(),
  });
  assert.match(empty, /none saved yet/);
});

test('applyScopeOperation: union semantics — exclude/unexclude dedupe, inclusions replace, date ops, reset clears all', () => {
  let scope: ChatFilterState = emptyScope();

  scope = applyScopeOperation(scope, {
    operation: 'exclude',
    categories: ['Trading & Investments'],
  });
  scope = applyScopeOperation(scope, {
    operation: 'exclude',
    categories: ['Trading & Investments', 'Peer Transfers'],
  });
  assert.deepEqual(scope.excludedCategories, [
    'Trading & Investments',
    'Peer Transfers',
  ]);

  scope = applyScopeOperation(scope, {
    operation: 'unexclude',
    categories: ['Trading & Investments'],
  });
  assert.deepEqual(scope.excludedCategories, ['Peer Transfers']);

  scope = applyScopeOperation(scope, {
    operation: 'set_inclusions',
    categories: ['Food & Grocery'],
  });
  scope = applyScopeOperation(scope, {
    operation: 'set_inclusions',
    categories: ['Travel & Trips', 'Subscriptions & Utilities'],
  });
  assert.deepEqual(scope.includedCategories, [
    'Travel & Trips',
    'Subscriptions & Utilities',
  ]);
  scope = applyScopeOperation(scope, {
    operation: 'set_inclusions',
    categories: [],
  });
  assert.deepEqual(scope.includedCategories, []);

  scope = applyScopeOperation(scope, {
    operation: 'set_date_range',
    dateRange: { from: '2026-09-01', to: '2026-09-15' },
  });
  assert.deepEqual(scope.dateRange, { from: '2026-09-01', to: '2026-09-15' });
  scope = applyScopeOperation(scope, { operation: 'clear_date_range' });
  assert.equal(scope.dateRange, undefined);
  assert.deepEqual(scope.excludedCategories, ['Peer Transfers']);

  scope = applyScopeOperation(scope, { operation: 'reset' });
  assert.deepEqual(scope, emptyScope());
});

test('effectiveFilters: scope + call precedence — call args override for this call, base exclusions always apply', () => {
  const base: ChatFilterState = {
    dateRange: { from: '2026-09-01', to: '2026-09-30' },
    excludedCategories: ['Trading & Investments'],
    includedCategories: [],
  };

  const fromBase = effectiveFilters(base, {});
  assert.deepEqual(fromBase, {
    dateRange: { from: '2026-09-01', to: '2026-09-30' },
    includedCategories: undefined,
    excludedCategories: ['Trading & Investments'],
    vendorPattern: undefined,
    needsReview: undefined,
  });

  const narrowed = effectiveFilters(base, {
    dateRange: { from: '2026-09-01', to: '2026-09-15' },
    vendorPattern: 'groww',
  });
  assert.deepEqual(narrowed.dateRange, { from: '2026-09-01', to: '2026-09-15' });
  assert.deepEqual(narrowed.excludedCategories, ['Trading & Investments']);
  assert.equal(narrowed.vendorPattern, 'groww');

  const singleCategory = effectiveFilters(base, { category: 'Food & Grocery' });
  assert.deepEqual(singleCategory.includedCategories, ['Food & Grocery']);

  const ignored = effectiveFilters(base, {
    vendorPattern: 'groww',
    ignoreScope: true,
  });
  assert.equal(ignored.dateRange, undefined);
  assert.equal(ignored.excludedCategories, undefined);
  assert.equal(ignored.vendorPattern, 'groww');
});

test('filterTransactions: excluded/included category sets compose with dates', () => {
  const rows = [
    row({ id: 'trade', category: 'Trading & Investments', amount: 500 }),
    row({ id: 'food', category: 'Food & Grocery', amount: 100 }),
    row({ id: 'peer', category: 'Peer Transfers', amount: 700 }),
    row({ id: 'uncat', category: null, amount: 50 }),
  ];

  const excl = filterTransactions(rows, {
    excludedCategories: ['Trading & Investments', 'Peer Transfers'],
  });
  assert.deepEqual(excl.map((r) => r.id), ['food', 'uncat']);

  const incl = filterTransactions(rows, {
    includedCategories: ['Food & Grocery', 'Peer Transfers'],
  });
  assert.deepEqual(incl.map((r) => r.id), ['food', 'peer']);

  const both = filterTransactions(rows, {
    includedCategories: ['Food & Grocery', 'Peer Transfers'],
    excludedCategories: ['Peer Transfers'],
    dateRange: { from: '2026-09-01', to: '2026-09-30' },
  });
  assert.deepEqual(both.map((r) => r.id), ['food']);
});

test('buildAgentSystemPrompt: scope section, set_scope tool, reset-on-fresh rule, ignoreScope/reference guidance', () => {
  const prompt = buildAgentSystemPrompt({
    rules: [],
    today: '2026-09-29',
    transactionCount: 74,
    scope: {
      dateRange: { from: '2026-09-01', to: '2026-09-15' },
      excludedCategories: ['Trading & Investments'],
      includedCategories: [],
    },
  });
  assert.match(prompt, /Current query scope \(structured/);
  assert.match(prompt, /date range: 2026-09-01 to 2026-09-15/);
  assert.match(prompt, /excluded categories: Trading & Investments/);
  assert.match(prompt, /included categories: none/);
  assert.match(prompt, /set_scope: record scope changes/);
  assert.match(prompt, /call set_scope with operation "reset" FIRST/);
  assert.match(prompt, /Never try to carry scope in prose/);
  assert.match(prompt, /ignoreScope:true to locate it/);
  assert.match(prompt, /Row actions \(flag\/mark\/undo\) NEVER change the scope/);
});

test('buildAgentSystemPrompt: recent query rows list ids for references, capped', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: `row-${i + 1}`,
    date: '2026-09-10',
    particulars: `UPIAR/1/DR/VENDOR${i + 1}`,
    amount: 100 + i,
    type: 'debit' as const,
    category: 'Other' as string | null,
    isClarificationNeeded: false,
  }));
  const prompt = buildAgentSystemPrompt({
    rules: [],
    today: '2026-09-29',
    transactionCount: 74,
    scope: emptyScope(),
    recentRows: rows,
  });
  assert.match(prompt, /Most recent query result/);
  assert.match(prompt, /\[row-1\]/);
  assert.match(prompt, /\[row-40\]/);
  assert.doesNotMatch(prompt, /\[row-41\]/);
  assert.match(prompt, /…and 10 more rows not shown/);

  const none = buildAgentSystemPrompt({
    rules: [],
    today: '2026-09-29',
    transactionCount: 74,
    scope: emptyScope(),
    recentRows: [],
  });
  assert.doesNotMatch(none, /Most recent query result/);
});
