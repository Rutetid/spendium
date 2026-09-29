export type TransactionType = 'debit' | 'credit';

export interface ParsedTransaction {
  date: string;
  particulars: string;
  matchKey: string;
  counterparty: string | null;
  amount: number;
  type: TransactionType;
  category: 'Other';
  tags: string[];
  isClarificationNeeded: boolean;
  userNotes: string | null;
}

export interface ReportRow extends ParsedTransaction {
  si: number;
  statedBalance: number;
}

export interface RowIssue {
  si: number;
  date: string;
  particulars: string;
  detail: string;
}

export interface Divergence {
  si: number;
  date: string;
  particulars: string;
  statedBalance: number;
  expectedBalance: number;
  amount: number;
  type: TransactionType;
}

export interface ParseDiagnostics {
  openingBalanceSkipped: { si: number; line: string; balance: number } | null;
  preambleLines: string[];
  markerMismatches: RowIssue[];
  amountVsBalanceMismatches: RowIssue[];
  singleLineGapDecisions: { si: number; line: string; assigned: 'before' | 'after' }[];
  wideGaps: { afterSi: number; beforeSi: number; lines: string[] }[];
  firstDivergence: Divergence | null;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  rows: ReportRow[];
  totals: {
    opening: number;
    closing: number | null;
    statedDebits: number | null;
    statedCredits: number | null;
    parsedDebits: number;
    parsedCredits: number;
  };
  diagnostics: ParseDiagnostics;
  verified: boolean;
}

const HEADER_LINE = 'SI Date Particulars Chq Num Withdrawal Deposit Balance';
const PAGE_BREAK_RE = /^\d+ of \d+$/;
const OPENING_RE = /^(\d+)\s+Opening Balance\s+([\d,]+\.\d{2})(?:\s+(Cr|Dr))?$/;
const ANCHOR_RE =
  /^(\d{1,4})\s+(\d{2}-\d{2}-\d{4})\s+(?:(.*?)\s+)?(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})(?:\s+(Cr|Dr))?$/;
const NARRATION_START_RE = /^(?:UPI[A-Z]*|IMPS[A-Z]*|NEFT|RTGS|POS|REFUND|ATM)/;
const INLINE_DR_CR_RE = /\/(?:DR|CR)\//;
const TOLERANCE = 0.005;

type OpeningItem = { kind: 'opening'; si: number; line: string; balance: number };
type AnchorItem = {
  kind: 'anchor';
  si: number;
  line: string;
  date: string;
  inline: string;
  amount: number;
  balance: number;
};
type TextItem = { kind: 'text'; line: string };
type Item = OpeningItem | AnchorItem | TextItem;

function parseNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE;
}

function signedBalance(value: string, crDr?: string): number {
  const n = parseNum(value);
  return crDr && crDr.toUpperCase() === 'DR' ? -n : n;
}

function toIso(ddmmyyyy: string): string {
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

export function normalizeMatchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const COUNTERPARTY_RE = /UPI(?:AR|AB)\/[^/]+\/(?:DR|CR)\/([^/]+)/;

function extractCounterparty(narration: string): string | null {
  const m = narration.match(COUNTERPARTY_RE);
  if (!m) return null;
  const name = m[1].trim();
  return name.length > 0 ? name : null;
}

function extractTotal(lines: string[], re: RegExp): number | null {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return parseNum(m[1]);
  }
  return null;
}

export function parseStatement(rawText: string): ParseResult {
  const allLines = rawText.split(/\r?\n/);

  const statedDebits = extractTotal(allLines, /Total Debits\s*:\s*([\d,]+\.\d{2})/);
  const statedCredits = extractTotal(allLines, /Total Credits\s*:\s*([\d,]+\.\d{2})/);
  const closing = extractTotal(allLines, /Closing Balance\s*:\s*([\d,]+\.\d{2})/);

  let cutIdx = allLines.findIndex((l) => /^\s*Total Debits\b/.test(l));
  if (cutIdx < 0) cutIdx = allLines.findIndex((l) => /^\s*OTHER ACCOUNT DETAILS\b/.test(l));
  const bodyLines = cutIdx >= 0 ? allLines.slice(0, cutIdx) : allLines;

  const lines: string[] = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === HEADER_LINE) continue;
    if (PAGE_BREAK_RE.test(line)) continue;
    lines.push(line);
  }

  const items: Item[] = [];
  for (const line of lines) {
    const opening = line.match(OPENING_RE);
    if (opening) {
      items.push({
        kind: 'opening',
        si: Number(opening[1]),
        line,
        balance: signedBalance(opening[2], opening[3]),
      });
      continue;
    }
    const anchor = line.match(ANCHOR_RE);
    if (anchor) {
      items.push({
        kind: 'anchor',
        si: Number(anchor[1]),
        line,
        date: anchor[2],
        inline: (anchor[3] ?? '').trim(),
        amount: round2(parseNum(anchor[4])),
        balance: signedBalance(anchor[5], anchor[6]),
      });
      continue;
    }
    items.push({ kind: 'text', line });
  }

  const openPos = items.findIndex((it) => it.kind === 'opening');
  if (openPos < 0) throw new Error('parse-statement: no Opening Balance row found');
  const opening = items[openPos] as OpeningItem;

  const anchors: AnchorItem[] = [];
  for (const it of items) if (it.kind === 'anchor') anchors.push(it);
  if (anchors.length === 0) throw new Error('parse-statement: no transaction rows found');

  const diagnostics: ParseDiagnostics = {
    openingBalanceSkipped: { si: opening.si, line: opening.line, balance: opening.balance },
    preambleLines: items
      .slice(0, openPos)
      .filter((it): it is TextItem => it.kind === 'text')
      .map((it) => it.line),
    markerMismatches: [],
    amountVsBalanceMismatches: [],
    singleLineGapDecisions: [],
    wideGaps: [],
    firstDivergence: null,
  };

  const befores: string[][] = anchors.map(() => []);
  const afters: string[][] = anchors.map(() => []);

  let pending: string[] = [];
  let curAnchor = -1;
  for (let i = openPos + 1; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'text') {
      pending.push(it.line);
      continue;
    }
    if (it.kind === 'opening') continue;
    const idx = ++curAnchor;
    if (idx === 0) {
      befores[0] = pending;
    } else if (pending.length === 1) {
      const line = pending[0];
      const startsNarration = NARRATION_START_RE.test(line) || INLINE_DR_CR_RE.test(line);
      if (startsNarration) {
        befores[idx].push(line);
        diagnostics.singleLineGapDecisions.push({ si: anchors[idx].si, line, assigned: 'before' });
      } else {
        afters[idx - 1].push(line);
        diagnostics.singleLineGapDecisions.push({ si: anchors[idx - 1].si, line, assigned: 'after' });
      }
    } else {
      afters[idx - 1].push(pending[0]);
      befores[idx].push(...pending.slice(1));
      if (pending.length >= 3) {
        diagnostics.wideGaps.push({
          afterSi: anchors[idx - 1].si,
          beforeSi: anchors[idx].si,
          lines: pending,
        });
      }
    }
    pending = [];
  }
  if (curAnchor >= 0 && pending.length > 0) afters[curAnchor].push(...pending);

  const rows: ReportRow[] = [];
  const transactions: ParsedTransaction[] = [];
  let prevBalance = opening.balance;
  let parsedDebits = 0;
  let parsedCredits = 0;

  for (let idx = 0; idx < anchors.length; idx++) {
    const a = anchors[idx];
    const narration = [...befores[idx], a.inline, ...afters[idx]].join('');

    const delta = round2(a.balance - prevBalance);
    const type: TransactionType = delta >= 0 ? 'credit' : 'debit';
    const expectedBalance = round2(prevBalance + (type === 'credit' ? a.amount : -a.amount));

    if (!nearly(Math.abs(delta), a.amount)) {
      diagnostics.amountVsBalanceMismatches.push({
        si: a.si,
        date: a.date,
        particulars: narration,
        detail: `amount ${a.amount.toFixed(2)} != |balance delta| ${Math.abs(delta).toFixed(2)}`,
      });
    }
    if (!diagnostics.firstDivergence && !nearly(expectedBalance, a.balance)) {
      diagnostics.firstDivergence = {
        si: a.si,
        date: a.date,
        particulars: narration,
        statedBalance: a.balance,
        expectedBalance,
        amount: a.amount,
        type,
      };
    }

    const hasDR = /\/DR\//.test(narration);
    const hasCR = /\/CR\//.test(narration);
    if (hasDR && type !== 'debit') {
      diagnostics.markerMismatches.push({
        si: a.si,
        date: a.date,
        particulars: narration,
        detail: `narration has /DR/ but balance delta says ${type}`,
      });
    }
    if (hasCR && type !== 'credit') {
      diagnostics.markerMismatches.push({
        si: a.si,
        date: a.date,
        particulars: narration,
        detail: `narration has /CR/ but balance delta says ${type}`,
      });
    }

    if (type === 'credit') parsedCredits = round2(parsedCredits + a.amount);
    else parsedDebits = round2(parsedDebits + a.amount);

    const txn: ParsedTransaction = {
      date: toIso(a.date),
      particulars: narration,
      matchKey: normalizeMatchKey(narration),
      counterparty: extractCounterparty(narration),
      amount: a.amount,
      type,
      category: 'Other',
      tags: [],
      isClarificationNeeded: false,
      userNotes: null,
    };
    rows.push({ ...txn, si: a.si, statedBalance: a.balance });
    transactions.push(txn);
    prevBalance = a.balance;
  }

  const totals = {
    opening: opening.balance,
    closing,
    statedDebits,
    statedCredits,
    parsedDebits,
    parsedCredits,
  };

  const totalsOk =
    statedDebits !== null &&
    statedCredits !== null &&
    closing !== null &&
    nearly(parsedDebits, statedDebits) &&
    nearly(parsedCredits, statedCredits) &&
    nearly(round2(opening.balance + parsedCredits - parsedDebits), closing);

  const verified =
    totalsOk &&
    diagnostics.firstDivergence === null &&
    diagnostics.amountVsBalanceMismatches.length === 0 &&
    diagnostics.markerMismatches.length === 0;

  return { transactions, rows, totals, diagnostics, verified };
}
