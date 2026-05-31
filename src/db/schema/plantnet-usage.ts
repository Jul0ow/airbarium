import { date, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const plantnetUsage = pgTable(
  'plantnet_usage',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date({ mode: 'string' }).notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export type PlantnetUsage = typeof plantnetUsage.$inferSelect;
export type NewPlantnetUsage = typeof plantnetUsage.$inferInsert;
