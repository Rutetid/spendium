import { and, isNotNull, lt } from 'drizzle-orm';
import { db, pool } from '../src/db';
import { statements } from '../src/db/schema';

async function main() {
  const expiredBefore = new Date();
  const result = await db
    .update(statements)
    .set({ rawText: null })
    .where(
      and(
        isNotNull(statements.rawText),
        lt(statements.rawTextExpiresAt, expiredBefore),
      ),
    );

  console.log(
    `Cleared rawText on ${result.rowCount ?? 0} expired statement(s).`,
  );
}

main()
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
