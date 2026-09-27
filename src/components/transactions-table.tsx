'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import type { Transaction } from '@/db/schema';

interface TransactionsTableProps {
  data: Transaction[];
}

export function TransactionsTable({ data }: TransactionsTableProps) {
  const transactions = useAppStore((state) => state.transactions);
  const setTransactions = useAppStore((state) => state.setTransactions);

  useEffect(() => {
    setTransactions(data);
  }, [data, setTransactions]);

  if (transactions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No transactions yet. Run <code>pnpm db:seed</code> to load test data.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Particulars</th>
            <th className="py-2 pr-4 text-right font-medium">Amount</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Category</th>
            <th className="py-2 pr-4 font-medium">Tags</th>
            <th className="py-2 font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => (
            <tr key={txn.id} className="border-b">
              <td className="py-2 pr-4 whitespace-nowrap">{txn.date}</td>
              <td className="py-2 pr-4">{txn.particulars}</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap">
                {txn.amount.toFixed(2)}
              </td>
              <td className="py-2 pr-4">{txn.type}</td>
              <td className="py-2 pr-4">{txn.category}</td>
              <td className="py-2 pr-4">{txn.tags.join(', ')}</td>
              <td className="py-2">
                {txn.isClarificationNeeded ? 'Yes' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-sm text-muted-foreground">
        {transactions.length} transaction{transactions.length === 1 ? '' : 's'}
      </p>
    </div>
  );
}
