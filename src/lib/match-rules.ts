import type { CategoryType } from './categories';
import type { ParsedTransaction } from './parse-statement';

/**
 * A single rule as stored in the `rules` table.
 *
 * Contract: `vendorPattern` MUST be normalized at rule-insert time — same
 * normalization as `normalizeMatchKey` (lowercase, all non-alphanumerics
 * stripped). Normalization is intentionally NOT performed inside
 * `matchRules`, so the DB is the source of truth for what a pattern
 * matches. An empty pattern never matches (guard against matching
 * everything).
 */
export interface MatchRule {
  id: string;
  vendorPattern: string;
  category: CategoryType;
  confidence: number;
  alternates: readonly string[];
}

/**
 * A parsed transaction after rule matching. Unlike `ParsedTransaction`
 * (whose `category` is always the placeholder `'Other'`), `category` here
 * is `null` when no rule matched — `null` means "not yet categorized"
 * (the Step 3 LLM will process it), whereas `'Other'` means the
 * transaction was explicitly categorized as Other.
 */
export type MatchedTransaction = Omit<ParsedTransaction, 'category'> & {
  category: CategoryType | null;
};

/**
 * Pure local rule matcher. No I/O.
 *
 * For each transaction, `matchKey` (already normalized by the parser) is
 * scanned for substring containment of each pre-normalized rule pattern.
 *
 * Outcomes:
 * - No rule matches → `category: null`, `isClarificationNeeded: false`.
 * - Exactly one distinct rule matches with a consistent category record
 *   (`alternates` empty or all equal to `category`) → apply that category,
 *   `isClarificationNeeded: false` (safe to automate).
 * - Exactly one distinct rule matches but `alternates` conflict with
 *   `category` → apply `rule.category` (the highest-confidence label),
 *   `isClarificationNeeded: true` (human should confirm).
 * - More than one distinct rule matches (substring collision, e.g. a
 *   `food` rule also matching `seafood`) → apply the higher-confidence
 *   rule's category, `isClarificationNeeded: true`. Ties keep the first
 *   rule in input order (deterministic).
 *
 * Duplicate rule ids are counted once. Rules with an empty normalized
 * pattern are skipped.
 */
export function matchRules(
  transactions: readonly ParsedTransaction[],
  rules: readonly MatchRule[],
): MatchedTransaction[] {
  const seenIds = new Set<string>();
  const activeRules: MatchRule[] = [];
  for (const rule of rules) {
    if (rule.vendorPattern.length === 0 || seenIds.has(rule.id)) continue;
    seenIds.add(rule.id);
    activeRules.push(rule);
  }

  return transactions.map((txn) => {
    const matched = activeRules.filter((rule) =>
      txn.matchKey.includes(rule.vendorPattern),
    );

    if (matched.length === 0) {
      return { ...txn, category: null, isClarificationNeeded: false };
    }

    if (matched.length === 1) {
      const [rule] = matched;
      const consistent = rule.alternates.every(
        (alternate) => alternate === rule.category,
      );
      return {
        ...txn,
        category: rule.category,
        isClarificationNeeded: !consistent,
      };
    }

    let best = matched[0];
    for (const rule of matched) {
      if (rule.confidence > best.confidence) best = rule;
    }
    return { ...txn, category: best.category, isClarificationNeeded: true };
  });
}
