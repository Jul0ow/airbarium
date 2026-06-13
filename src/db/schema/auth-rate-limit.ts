import { bigint, integer, pgTable, text } from 'drizzle-orm/pg-core';

export const authRateLimit = pgTable('auth_rate_limit', {
  id: text().primaryKey(),
  key: text().notNull().unique(),
  count: integer().notNull().default(0),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});

export type AuthRateLimit = typeof authRateLimit.$inferSelect;
export type NewAuthRateLimit = typeof authRateLimit.$inferInsert;
