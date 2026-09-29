import { db } from '@/db';
import { rules, statements, transactions, type Transaction } from '@/db/schema';
import { auth } from '@/lib/auth';
import { categorizeTransactions } from '@/lib/llm-categorize';
import { matchRules } from '@/lib/match-rules';
import { parseStatement } from '@/lib/parse-statement';
import {
  extractAndSanitize,
  IngestionError,
  PAGE1_HEADER_STRIP_FRACTION,
  RAW_TEXT_TTL_DAYS,
} from '@/lib/pdf-extract';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return Response.json({ error: 'Not signed in.' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'Expected a file upload.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file provided.' }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: 'That file is empty.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: 'File is too large — statements should be under 15 MB.' },
      { status: 413 },
    );
  }

  // The upload lives only in memory for the lifetime of this request —
  // it is never written to disk or any blob storage.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, 1024),
  );
  if (!head.includes('%PDF-')) {
    return Response.json(
      { error: "That doesn't look like a PDF file." },
      { status: 400 },
    );
  }

  let extraction;
  try {
    extraction = await extractAndSanitize(bytes);
  } catch (error) {
    if (error instanceof IngestionError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error('[ingest] extraction failed:', error);
    return Response.json(
      { error: 'Something went wrong while reading this PDF.' },
      { status: 500 },
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log(
      `[ingest] pages=${extraction.totalPages} chars/page=[${extraction.pageCharCounts.join(', ')}] ` +
        `stripFrac=${PAGE1_HEADER_STRIP_FRACTION} stripped ${extraction.stripped.itemCount} items -> ` +
        `"${extraction.stripped.sample.slice(0, 400)}"`,
    );
  }

  let parsed;
  try {
    parsed = parseStatement(extraction.text);
  } catch (error) {
    console.error('[ingest] parse failed:', error);
    return Response.json(
      { error: "We couldn't find any transactions in this statement." },
      { status: 422 },
    );
  }

  const userRules = await db
    .select()
    .from(rules)
    .where(eq(rules.userId, session.user.id));
  const matched = matchRules(parsed.transactions, userRules);

  let categorized;
  try {
    categorized = await categorizeTransactions(matched);
  } catch (error) {
    console.error('[ingest] LLM categorization failed:', error);
    return Response.json(
      { error: 'Automatic categorization failed. Please try again.' },
      { status: 502 },
    );
  }
  if (categorized.some((t) => t.category === null)) {
    console.error('[ingest] categorization left null categories');
    return Response.json(
      { error: 'Automatic categorization failed. Please try again.' },
      { status: 502 },
    );
  }

  const [row] = await db
    .insert(statements)
    .values({
      id: crypto.randomUUID(),
      userId: session.user.id,
      rawText: extraction.text,
      rawTextExpiresAt: new Date(
        Date.now() + RAW_TEXT_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    })
    .returning();

  if (!row) {
    return Response.json(
      { error: 'Failed to save the statement.' },
      { status: 500 },
    );
  }

  const inserted: Transaction[] =
    categorized.length === 0
      ? []
      : await db
          .insert(transactions)
          .values(
            categorized.map((t) => ({
              id: crypto.randomUUID(),
              statementId: row.id,
              userId: session.user.id,
              date: t.date,
              particulars: t.particulars,
              amount: t.amount,
              type: t.type,
              category: t.category,
              tags: t.tags,
              isClarificationNeeded: t.isClarificationNeeded,
              userNotes: t.userNotes,
            })),
          )
          .returning();

  return Response.json({
    id: row.id,
    uploadedAt: row.uploadedAt,
    rawTextExpiresAt: row.rawTextExpiresAt,
    totalPages: extraction.totalPages,
    text: extraction.text,
    transactions: inserted,
  });
}
