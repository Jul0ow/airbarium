import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const species = pgTable('species', {
  id: uuid().primaryKey(),
  scientificName: text().notNull().unique(),
  commonName: text(),
  family: text(),
  description: text(),
  referencePhotoUrl: text(),
  wikipediaUrl: text(),
  wikipediaFetchedAt: timestamp({ withTimezone: true }),
  rarityLevel: integer(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type Species = typeof species.$inferSelect;
export type NewSpecies = typeof species.$inferInsert;
