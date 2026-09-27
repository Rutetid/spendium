import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { db, pool } from '../src/db';
import {
  statements,
  transactions,
  user,
  type NewTransaction,
} from '../src/db/schema';

const TEST_EMAIL = process.env.SEED_USER_EMAIL ?? 'test@example.com';
const TEST_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'password123';
const SEED_STATEMENT_ID = 'stmt_seed_001';
const RAW_TEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function ensureTestUser() {
  const findUser = () =>
    db.select().from(user).where(eq(user.email, TEST_EMAIL)).limit(1);

  const existing = await findUser();
  if (existing[0]) {
    console.log(`Using existing user ${TEST_EMAIL}`);
    return existing[0];
  }

  const { auth } = await import('../src/lib/auth');
  try {
    await auth.api.signUpEmail({
      body: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: 'Test User',
      },
    });
    console.log(`Created user ${TEST_EMAIL}`);
  } catch (error) {
    const raced = await findUser();
    if (!raced[0]) throw error;
    return raced[0];
  }

  const created = await findUser();
  if (!created[0]) throw new Error('User creation did not persist');
  return created[0];
}

async function ensureStatement(userId: string) {
  const existing = await db
    .select()
    .from(statements)
    .where(eq(statements.id, SEED_STATEMENT_ID))
    .limit(1);

  if (existing[0]) return existing[0];

  const [row] = await db
    .insert(statements)
    .values({
      id: SEED_STATEMENT_ID,
      userId,
      rawText: null,
      rawTextExpiresAt: new Date(Date.now() + RAW_TEXT_TTL_MS),
    })
    .returning();

  if (!row) throw new Error('Failed to create seed statement');
  console.log(`Created statement ${SEED_STATEMENT_ID}`);
  return row;
}

interface SeedTransaction {
  id: string;
  date: string;
  particulars: string;
  amount: number;
  type: 'debit' | 'credit';
  category: NewTransaction['category'];
  tags: string[];
}

async function seedTransactions(userId: string, statementId: string) {
  const path = join(process.cwd(), 'seed-transactions.json');
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as SeedTransaction[];

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('seed-transactions.json is empty or invalid');
  }

  const rows: NewTransaction[] = parsed.map((txn) => ({
    id: txn.id,
    statementId,
    userId,
    date: txn.date,
    particulars: txn.particulars,
    amount: txn.amount,
    type: txn.type,
    category: txn.category,
    tags: txn.tags ?? [],
    isClarificationNeeded: false,
    userNotes: null,
  }));

  const result = await db
    .insert(transactions)
    .values(rows)
    .onConflictDoNothing({ target: transactions.id });

  console.log(
    `Inserted ${result.rowCount ?? 0} of ${rows.length} transactions`,
  );
}

async function main() {
  const testUser = await ensureTestUser();
  const statement = await ensureStatement(testUser.id);
  await seedTransactions(testUser.id, statement.id);

  const [row] = await db
    .select({ value: count() })
    .from(transactions)
    .where(eq(transactions.userId, testUser.id));

  console.log(
    `Done. User ${testUser.email} now has ${row?.value ?? 0} transactions.`,
  );
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
