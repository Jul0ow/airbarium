import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const rateLimit = pgTable(
  'rate_limit',
  {
    key: text().notNull(),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    count: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index('rate_limit_expires_idx').on(t.expiresAt),
  ],
);

export type RateLimit = typeof rateLimit.$inferSelect;
export type NewRateLimit = typeof rateLimit.$inferInsert;
