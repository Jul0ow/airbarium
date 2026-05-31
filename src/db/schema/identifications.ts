import { sql } from 'drizzle-orm';
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { photoStatusEnum } from './enums';
import { species } from './species';
import { users } from './users';

export const identifications = pgTable(
  'identifications',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    photoUrl: text().notNull(),
    photoStatus: photoStatusEnum().notNull().default('temp'),
    plantnetRawResponse: jsonb().notNull(),
    topMatchSpeciesId: uuid().references(() => species.id, { onDelete: 'set null' }),
    topMatchConfidence: numeric({ precision: 5, scale: 4 }),
    exifMetadata: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }),
    promotedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('identifications_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('identifications_temp_expires_idx').on(t.expiresAt).where(sql`${t.photoStatus} = 'temp'`),
  ],
);

export type Identification = typeof identifications.$inferSelect;
export type NewIdentification = typeof identifications.$inferInsert;
