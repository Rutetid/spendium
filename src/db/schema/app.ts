import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { CategoryType } from '../../lib/categories';
import { user } from './auth';

export type TransactionType = 'debit' | 'credit';

export const statements = pgTable('statements', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  rawTextExpiresAt: timestamp('raw_text_expires_at', {
    withTimezone: true,
  }).notNull(),
  rawText: text('raw_text'),
});

export const transactions = pgTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    statementId: text('statement_id')
      .notNull()
      .references(() => statements.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    particulars: text('particulars').notNull(),
    amount: doublePrecision('amount').notNull(),
    type: text('type').$type<TransactionType>().notNull(),
    category: text('category').$type<CategoryType>().notNull(),
    tags: text('tags').array().notNull().default([]),
    isClarificationNeeded: boolean('is_clarification_needed')
      .notNull()
      .default(false),
    userNotes: text('user_notes'),
  },
  (table) => [
    index('transactions_user_id_date_idx').on(table.userId, table.date),
    index('transactions_statement_id_idx').on(table.statementId),
  ],
);

export const rules = pgTable(
  'rules',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    vendorPattern: text('vendor_pattern').notNull(),
    category: text('category').$type<CategoryType>().notNull(),
    confidence: doublePrecision('confidence').notNull().default(1),
    alternates: text('alternates').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('rules_user_id_idx').on(table.userId)],
);

export const statementsRelations = relations(statements, ({ one, many }) => ({
  user: one(user, { fields: [statements.userId], references: [user.id] }),
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  statement: one(statements, {
    fields: [transactions.statementId],
    references: [statements.id],
  }),
  user: one(user, { fields: [transactions.userId], references: [user.id] }),
}));

export type Statement = typeof statements.$inferSelect;
export type NewStatement = typeof statements.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Rule = typeof rules.$inferSelect;
export type NewRule = typeof rules.$inferInsert;
