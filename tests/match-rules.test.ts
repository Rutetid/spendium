import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchRules, type MatchRule } from '../src/lib/match-rules';
import {
  normalizeMatchKey,
  parseStatement,
  type ParsedTransaction,
} from '../src/lib/parse-statement';

// --- fixtures ----------------------------------------------------------------

const fixtureRaw = readFileSync(
  fileURLToPath(new URL('./fixtures/union-bank-75.txt', import.meta.url)),
  'utf8',
);
const parsed = parseStatement(fixtureRaw);

interface SeedRow {
  id: string;
  date: string;
  particulars: string;
  amount: number;
  type: 'debit' | 'credit';
  category: string;
  tags: string[];
}

const seedRows: SeedRow[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../seed-transactions.json', import.meta.url)), 'utf8'),
);

function toParsed(row: SeedRow): ParsedTransaction {
  return {
    date: row.date,
    particulars: row.particulars,
    matchKey: normalizeMatchKey(row.particulars),
    counterparty: null,
    amount: row.amount,
    type: row.type,
    category: 'Other',
    tags: row.tags,
    isClarificationNeeded: false,
    userNotes: null,
  };
}

function txn(overrides: Partial<ParsedTransaction> = {}): ParsedTransaction {
  return {
    date: '2026-09-01',
    particulars: 'SAMPLE',
    matchKey: normalizeMatchKey('SAMPLE'),
    counterparty: null,
    amount: 100,
    type: 'debit',
    category: 'Other',
    tags: [],
    isClarificationNeeded: false,
    userNotes: null,
    ...overrides,
  };
}

let ruleSeq = 0;

function makeRule(
  partial: Partial<MatchRule> & { vendorPattern: string },
): MatchRule {
  ruleSeq += 1;
  return {
    id: partial.id ?? `rule_${ruleSeq}`,
    vendorPattern: partial.vendorPattern,
    category: partial.category ?? 'Other',
    confidence: partial.confidence ?? 1,
    alternates: partial.alternates ?? [],
  };
}

// --- spec-required cases -----------------------------------------------------

test('seed rule test: single consistent kanishka rule silently categorizes all 10 Kanishka seed transactions', () => {
  const seedTxns = seedRows.map(toParsed);
  const kanishkaRule = makeRule({
    vendorPattern: 'kanishka',
    category: 'Food & Grocery',
    confidence: 1,
    alternates: [],
  });

  const matched = matchRules(seedTxns, [kanishkaRule]);

  const hits = matched.filter((t) => t.matchKey.includes('kanishka'));
  assert.equal(hits.length, 10);
  for (const t of hits) {
    assert.equal(t.category, 'Food & Grocery');
    assert.equal(t.isClarificationNeeded, false);
  }

  const misses = matched.filter((t) => !t.matchKey.includes('kanishka'));
  assert.equal(misses.length, 64);
  for (const t of misses) {
    assert.equal(t.category, null);
    assert.equal(t.isClarificationNeeded, false);
  }
});

test('conflicting alternates: rule.category applied and transaction flagged for clarification; consistent alternates stay silent', () => {
  const txnWithRule = txn({ matchKey: normalizeMatchKey('UPIAR/123/DR/SWIGGY') });

  const conflicting = makeRule({
    vendorPattern: 'swiggy',
    category: 'Food & Grocery',
    confidence: 0.8,
    alternates: ['Travel & Trips'],
  });
  const [flagged] = matchRules([txnWithRule], [conflicting]);
  assert.equal(flagged.category, 'Food & Grocery');
  assert.equal(flagged.isClarificationNeeded, true);

  const consistent = makeRule({
    vendorPattern: 'swiggy',
    category: 'Food & Grocery',
    confidence: 0.8,
    alternates: ['Food & Grocery'],
  });
  const [silent] = matchRules([txnWithRule], [consistent]);
  assert.equal(silent.category, 'Food & Grocery');
  assert.equal(silent.isClarificationNeeded, false);
});

test('substring collision: both rules match one matchKey, higher-confidence rule wins and is flagged regardless of rule order', () => {
  const txnWithBoth = txn({ matchKey: normalizeMatchKey('MEESHOPLUS PAYTM QR') });
  const broader = makeRule({
    vendorPattern: 'meesho',
    category: 'General Shopping & Electronics',
    confidence: 0.5,
  });
  const narrower = makeRule({
    vendorPattern: 'meeshoplus',
    category: 'Clothing & Apparel',
    confidence: 0.9,
  });

  const [narrowerLast] = matchRules([txnWithBoth], [broader, narrower]);
  assert.equal(narrowerLast.category, 'Clothing & Apparel');
  assert.equal(narrowerLast.isClarificationNeeded, true);

  const [narrowerFirst] = matchRules([txnWithBoth], [narrower, broader]);
  assert.equal(narrowerFirst.category, 'Clothing & Apparel');
  assert.equal(narrowerFirst.isClarificationNeeded, true);

  // Equal confidence: first match in input order wins (deterministic tie-break).
  const tieA = makeRule({ vendorPattern: 'zomato', category: 'Food & Grocery', confidence: 1 });
  const tieB = makeRule({ vendorPattern: 'omat', category: 'Peer Transfers', confidence: 1 });
  const tiedTxn = txn({ matchKey: normalizeMatchKey('ZOMATO ORDER 8821') });
  const [tie] = matchRules([tiedTxn], [tieA, tieB]);
  assert.equal(tie.category, 'Food & Grocery');
  assert.equal(tie.isClarificationNeeded, true);
});

test('Union Bank fixture with zero rules: all 74 transactions stay category null and unflagged', () => {
  const matched = matchRules(parsed.transactions, []);
  assert.equal(matched.length, 74);
  for (const t of matched) {
    assert.equal(t.category, null);
    assert.equal(t.isClarificationNeeded, false);
  }
  // Parser placeholders are overridden, not carried through.
  assert.ok(matched.every((t) => t.particulars.length > 0));
});

// --- contract guards ---------------------------------------------------------

test('empty normalized pattern never matches (it would otherwise match every transaction)', () => {
  const empty = makeRule({ vendorPattern: '', category: 'Other' });
  const matched = matchRules(parsed.transactions, [empty]);
  assert.equal(matched.length, 74);
  assert.ok(matched.every((t) => t.category === null));
});

test('patterns are NOT normalized at match time: an un-normalized pattern does not match', () => {
  const seedTxns = seedRows.map(toParsed);
  const rawPattern = makeRule({
    vendorPattern: 'Kanishka',
    category: 'Food & Grocery',
    confidence: 1,
    alternates: [],
  });
  const matched = matchRules(seedTxns, [rawPattern]);
  assert.ok(matched.every((t) => t.category === null));
});

test('duplicate rule ids count as one distinct rule (no spurious clarification flag)', () => {
  const rule = makeRule({
    vendorPattern: 'kanishka',
    category: 'Food & Grocery',
    confidence: 1,
    alternates: [],
  });
  const [out] = matchRules([txn({ matchKey: normalizeMatchKey('KANISHKA') })], [
    rule,
    { ...rule },
  ] as MatchRule[]);
  assert.equal(out.category, 'Food & Grocery');
  assert.equal(out.isClarificationNeeded, false);
});
