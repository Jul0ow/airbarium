import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, rawClient } from '@/db/client';

let migrated = false;

export async function setupTestDb() {
  if (!migrated) {
    await migrate(db, { migrationsFolder: './src/db/migrations' });
    migrated = true;
  }
}

export async function truncateAll() {
  await db.execute(sql`
    TRUNCATE TABLE
      verification,
      session,
      account,
      rate_limit,
      plantnet_usage,
      specimens,
      identifications,
      species,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function teardownTestDb() {
  await rawClient.end();
}

export { db as testDb };
