import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatFilterState, RecentQueryRow } from '@/lib/agent-plan';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Ids of the query_transactions rows this assistant reply was based on
   * (the rows themselves only ever carry SANITIZED particulars — see
   * agent-tools). chat-panel hydrates full, unsanitized detail for display
   * from the app store by these ids, so no raw text needs to live here. */
  rowIds?: string[];
}

const emptyFilterState = (): ChatFilterState => ({
  excludedCategories: [],
  includedCategories: [],
});

interface ChatState {
  messages: ChatMessage[];
  /** Structured query scope for follow-up refinement chains — sent with every
   * request and updated from each response so it survives the 1-turn window. */
  filterState: ChatFilterState;
  /** Rows of the most recent query_transactions result (for references like
   * "mark that one"). Sent with every request; cleared with `clear()`. */
  lastResultRows: RecentQueryRow[];
  addMessage: (message: ChatMessage) => void;
  setFilterState: (scope: ChatFilterState) => void;
  setLastResultRows: (rows: RecentQueryRow[] | null) => void;
  clear: () => void;
}

/** Session-scoped chat history. Persisted for display across reloads; the API
 * only ever receives the CURRENT message plus the immediately preceding
 * exchange (last user message + assistant reply) as short-term context —
 * never this full log. The rules table is the long-term memory. */
export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      messages: [],
      filterState: emptyFilterState(),
      lastResultRows: [],
      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),
      setFilterState: (filterState) => set({ filterState }),
      setLastResultRows: (rows) => set({ lastResultRows: rows ?? [] }),
      clear: () =>
        set({
          messages: [],
          filterState: emptyFilterState(),
          lastResultRows: [],
        }),
    }),
    {
      name: 'spendium-chat',
      // Older persisted state may lack the scope fields — never let them hydrate
      // as undefined (the request schema would reject the payload).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ChatState>;
        return {
          ...current,
          ...p,
          filterState: p.filterState ?? current.filterState,
          lastResultRows: p.lastResultRows ?? current.lastResultRows,
        };
      },
    },
  ),
);
