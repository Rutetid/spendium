/**
 * Sanitize a transaction description before sending it to an LLM.
 *
 * Raw `particulars` contain OTHER people's personal data — UPI handles and
 * phone numbers of counterparties (e.g. "91******38@ib", "q60*****95@yb") —
 * which must NEVER reach a third-party model API.
 *
 * Strategy:
 * - When the parser extracted a `counterparty` (the name segment of a
 *   UPI /DR/ or /CR/ narration), send only that name.
 * - Otherwise fall back to `particulars`, stripping:
 *     - any `\S+@\S+` token (UPI handles / emails)
 *     - any digit run of 9+ characters (phone numbers, reference IDs)
 *
 * Both branches run the same stripping as defense in depth, so a hostile
 * counterparty value containing a handle or phone number is also cleaned.
 * The result may be an empty string — callers should substitute a neutral
 * placeholder rather than sending an empty description.
 */
export function sanitizeForLlm(input: {
  counterparty: string | null;
  particulars: string;
}): string {
  const base = input.counterparty ?? input.particulars;
  return base
    .replace(/\S+@\S+/g, ' ')
    .replace(/\d{9,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
