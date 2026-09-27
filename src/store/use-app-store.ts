import { create } from 'zustand';
import type { Rule, Transaction } from '@/db/schema';

interface AppState {
  transactions: Transaction[];
  rules: Rule[];
  setTransactions: (transactions: Transaction[]) => void;
  updateTransaction: (id: string, patch: Partial<Transaction>) => void;
  setRules: (rules: Rule[]) => void;
  addRule: (rule: Rule) => void;
  removeRule: (id: string) => void;
  reset: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
  transactions: [],
  rules: [],
  setTransactions: (transactions) => set({ transactions }),
  updateTransaction: (id, patch) =>
    set((state) => ({
      transactions: state.transactions.map((txn) =>
        txn.id === id ? { ...txn, ...patch } : txn,
      ),
    })),
  setRules: (rules) => set({ rules }),
  addRule: (rule) =>
    set((state) => ({ rules: [...state.rules, rule] })),
  removeRule: (id) =>
    set((state) => ({ rules: state.rules.filter((rule) => rule.id !== id) })),
  reset: () => set({ transactions: [], rules: [] }),
}));
