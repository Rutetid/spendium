/**
 * Sanitize a transaction description before sending it to an LLM.
 *
 * Raw `particulars` contain OTHER people's personal data — UPI handles and
 * phone numbers of counterparties (e.g. "91******38@ib", "q60*****95@yb") —
 * which must NEVER reach a third-party model API.
 *
 * Strip ONLY those PII tokens, wherever they occur in the narration:
 * - a slash-segment or whitespace token containing `@` (UPI handles / emails)
 * - any digit run of 9+ characters (phone numbers, reference IDs)
 *
 * Everything else is kept — every word-like segment, including vendor names
 * that appear after additional slashes (e.g. "nationalstock." in
 * "UPIAR/110741264530/DR/National/ICIC/nationalstock."). Truncating to the
 * parser's single `counterparty` segment discarded such vendor words and
 * caused miscategorization, so the full narration is always the input.
 *
 * Note the handle removal is segment-aware: in a space-less narration like
 * "UPIAR/624501585463/DR/Blinkit/HDFC/blinkit.payu@hdfcbank" a naive
 * `\S+@\S+` regex would match the whole line and wipe "Blinkit" too. Only
 * the slash-segment that carries the `@` is dropped.
 *
 * The result may be an empty string — callers should substitute a neutral
 * placeholder rather than sending an empty description.
 */
export function sanitizeForLlm(input: { particulars: string }): string {
  const kept: string[] = [];
  for (const token of input.particulars.split(/\s+/)) {
    if (!token.includes('@')) {
      kept.push(token);
    } else if (token.includes('/')) {
      const segments = token.split('/').filter((segment) => !segment.includes('@'));
      const joined = segments.join('/');
      if (joined !== '') kept.push(joined);
    }
    // whitespace token with '@' and no '/' is a bare handle/email — dropped
  }
  return kept
    .join(' ')
    .replace(/\d{9,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
