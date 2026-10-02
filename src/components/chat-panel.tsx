'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Rule, Transaction } from '@/db/schema';
import type { ChatFilterState, RecentQueryRow } from '@/lib/agent-plan';
import { useAppStore } from '@/store/use-app-store';
import { useChatStore, type ChatMessage } from '@/store/use-chat-store';

interface ChatResponse {
  reply: string;
  toolNames: string[];
  filterState?: ChatFilterState;
  lastResultRows?: RecentQueryRow[] | null;
  transactions?: Transaction[];
  rules?: Rule[];
}

/** Longest row list rendered beneath a reply; the aggregate answer is in the
 * reply text itself — this is the full-detail reference the model can't show. */
const MAX_VISIBLE_ROWS = 10;

/**
 * Full-detail rows for one assistant reply, hydrated from the app store by id.
 * The model only ever saw SANITIZED particulars; these are the real ones from
 * the client's already-loaded data — no fetch, no matching against the reply.
 */
function ResultRowList({ rowIds }: { rowIds: readonly string[] }) {
  const transactions = useAppStore((state) => state.transactions);
  const rows = useMemo(() => {
    const byId = new Map(transactions.map((txn) => [txn.id, txn]));
    return rowIds
      .map((id) => byId.get(id))
      .filter((txn): txn is Transaction => txn !== undefined)
      .slice(0, MAX_VISIBLE_ROWS);
  }, [rowIds, transactions]);

  if (rows.length === 0) return null;
  const hidden = rowIds.length - rows.length;
  return (
    <div className="mt-2 space-y-1.5 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground">
        Query result
      </p>
      <ul className="space-y-1.5">
        {rows.map((txn) => (
          <li key={txn.id} className="text-xs">
            <div className="flex justify-between gap-2">
              <span className="whitespace-nowrap text-muted-foreground">
                {txn.date}
              </span>
              <span className="shrink-0 tabular-nums">
                {txn.amount.toFixed(2)} ({txn.type})
              </span>
            </div>
            <p className="break-words">{txn.particulars}</p>
            <p className="text-muted-foreground">
              {txn.category ?? 'uncategorized'}
              {txn.isClarificationNeeded ? ' · flagged' : ''}
            </p>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">+ {hidden} more…</p>
      )}
    </div>
  );
}

export function ChatPanel() {
  const [input, setInput] = useState('');
  const messages = useChatStore((state) => state.messages);
  const addMessage = useChatStore((state) => state.addMessage);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = useMutation({
    mutationFn: async ({
      text,
      context,
    }: {
      text: string;
      context: ChatMessage[];
    }) => {
      const transactionIds = useAppStore
        .getState()
        .transactions.map((txn) => txn.id);
      const { filterState, lastResultRows } = useChatStore.getState();
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          // Last exchange only (prior user message + assistant reply) — the
          // server resends it as short-term context so follow-ups resolve;
          // anything older stays client-side (Phase 3 spec).
          context: context.map(({ role, content }) => ({ role, content })),
          filterState,
          lastResultRows,
          transactionIds,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error ?? 'Chat failed.');
      }
      return json as ChatResponse;
    },
    onSuccess: (data) => {
      if (data.transactions) {
        useAppStore.getState().setTransactions(data.transactions);
      }
      if (data.rules) {
        useAppStore.getState().setRules(data.rules);
      }
      if (data.filterState) {
        useChatStore.getState().setFilterState(data.filterState);
      }
      if (data.lastResultRows !== undefined) {
        useChatStore.getState().setLastResultRows(data.lastResultRows);
      }
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply,
        // Attach the queried row ids to THIS reply so the list renders beneath
        // it; the rows themselves stay in lastResultRows for the next request.
        rowIds: data.lastResultRows?.map((row) => row.id),
      });
    },
    onError: (error) => {
      addMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `Something went wrong: ${error.message}`,
      });
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (text.length === 0 || send.isPending) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    };
    // Capture the preceding exchange BEFORE appending the new message, so
    // the server gets user(n-1) + assistant(n-1) as context for this turn.
    const prev = messages.at(-2);
    const last = messages.at(-1);
    const context =
      prev !== undefined &&
      last !== undefined &&
      prev.role === 'user' &&
      last.role === 'assistant'
        ? [prev, last]
        : [];
    addMessage(userMessage);
    setInput('');
    send.mutate({ text, context });
  };

  return (
    <section className="flex h-[560px] flex-col rounded-lg border">
      <header className="border-b px-4 py-2">
        <h2 className="text-sm font-medium">Assistant</h2>
        <p className="text-xs text-muted-foreground">
          Corrections become saved rules — future uploads need fewer LLM calls
        </p>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Try: &ldquo;BITCANT is the college canteen, always mark it as Food
            &amp; Grocery&rdquo; or &ldquo;How much did I spend on food this
            month?&rdquo;
          </p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === 'user'
                ? 'ml-8 whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm'
                : 'mr-8 whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm'
            }
          >
            {message.content}
            {message.role === 'assistant' &&
              message.rowIds !== undefined &&
              message.rowIds.length > 0 && (
                <ResultRowList rowIds={message.rowIds} />
              )}
          </div>
        ))}
        {send.isPending && (
          <p className="text-xs text-muted-foreground">Thinking…</p>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t p-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder='e.g. "BITCANT is the college canteen, always mark it as Food & Grocery"'
          aria-label="Message the assistant"
          disabled={send.isPending}
          className="h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={send.isPending || input.trim().length === 0}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
