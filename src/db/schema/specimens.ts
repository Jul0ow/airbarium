import { sql } from 'drizzle-orm';
import { index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { identificationSourceEnum } from './enums';
import { identifications } from './identifications';
import { species } from './species';
import { users } from './users';

export const specimens = pgTable(
  'specimens',
  {
    id: uuid().primaryKey(), // client-generated UUIDv7
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    identificationId: uuid().references(() => identifications.id, { onDelete: 'set null' }),
    speciesId: uuid().references(() => species.id, { onDelete: 'set null' }),
    photoUrl: text().notNull(),
    identifiedName: text(),
    scientificName: text(),
    family: text(),
    confidenceScore: numeric({ precision: 5, scale: 4 }),
    identificationSource: identificationSourceEnum().notNull().default('none'),
    lat: numeric({ precision: 9, scale: 6 }),
    lng: numeric({ precision: 9, scale: 6 }),
    locationLabel: text(),
    userNotes: text(),
    collectedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('specimens_user_deleted_collected_idx').on(t.userId, t.deletedAt, t.collectedAt.desc()),
    index('specimens_user_species_active_idx')
      .on(t.userId, t.speciesId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Cover the two non-default list sorts so pagination is an index scan, not a
    // filesort. Column order/direction mirrors services/specimens.ts orderBy:
    //   created_at_desc -> ORDER BY created_at DESC, id DESC
    //   name_asc        -> ORDER BY identified_name ASC NULLS LAST, id ASC
    // (a default ASC btree index already orders NULLS LAST). Partial on the same
    // active-rows predicate the list always applies.
    index('specimens_user_created_idx')
      .on(t.userId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('specimens_user_name_idx')
      .on(t.userId, t.identifiedName, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type Specimen = typeof specimens.$inferSelect;
export type NewSpecimen = typeof specimens.$inferInsert;
