import { asc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ChatPanel } from '@/components/chat-panel';
import { SignOutButton } from '@/components/sign-out-button';
import { TransactionsTable } from '@/components/transactions-table';
import { UploadZone } from '@/components/upload-zone';
import { db } from '@/db';
import { transactions } from '@/db/schema';
import { auth } from '@/lib/auth';

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/sign-in');
  }

  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, session.user.id))
    .orderBy(asc(transactions.date), asc(transactions.id));

  return (
    <main className="mx-auto w-full max-w-6xl p-6">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{session.user.email}</p>
        </div>
        <SignOutButton />
      </header>
      <UploadZone />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <TransactionsTable data={rows} />
        <ChatPanel />
      </div>
    </main>
  );
}
