import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens, users, verification } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import { deleteAccount } from '@/services/account-deletion';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

let restoreGarage: () => void = () => {};
let deleteCalls: Array<{ bucket: string; key: string }> = [];

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
  deleteCalls = [];
  restoreGarage = __setGarageForTests({
    deleteObjects: async ({ bucket, keys }) => {
      for (const key of keys) deleteCalls.push({ bucket, key });
      return { deleted: keys, errors: [] };
    },
  });
});

afterEach(() => restoreGarage());

async function seedUser(): Promise<{ id: string; email: string }> {
  const id = uuid7();
  const email = `${id}@example.com`;
  await testDb.insert(users).values({ id, email, name: 'Doomed', avatarUrl: `${id}.jpg` });
  // two specimens, one of them soft-deleted (its Garage object still exists)
  await testDb.insert(specimens).values([
    { id: uuid7(), userId: id, photoUrl: `${id}/spec-active.jpg`, collectedAt: new Date() },
    {
      id: uuid7(),
      userId: id,
      photoUrl: `${id}/spec-deleted.jpg`,
      collectedAt: new Date(),
      deletedAt: new Date(),
    },
  ]);
  await testDb.insert(identifications).values({
    id: uuid7(),
    userId: id,
    photoUrl: `${id}/ident-temp.jpg`,
    plantnetRawResponse: { results: [] },
  });
  await testDb.insert(verification).values({
    id: uuid7(),
    identifier: email,
    value: 'tok',
    expiresAt: new Date(Date.now() + 1e6),
  });
  return { id, email };
}

describe('deleteAccount', () => {
  it('purges all user rows and deletes every Garage object (incl. soft-deleted specimens)', async () => {
    const { id, email } = await seedUser();

    await deleteAccount(id, email);

    // DB: user and all cascade-owned rows gone
    expect(await testDb.select().from(users).where(eq(users.id, id))).toHaveLength(0);
    expect(await testDb.select().from(specimens).where(eq(specimens.userId, id))).toHaveLength(0);
    expect(
      await testDb.select().from(identifications).where(eq(identifications.userId, id)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(verification).where(eq(verification.identifier, email)),
    ).toHaveLength(0);

    // Garage: every captured key targeted, in the right bucket
    expect(deleteCalls).toContainEqual({ bucket: 'specimens', key: `${id}/spec-active.jpg` });
    expect(deleteCalls).toContainEqual({ bucket: 'specimens', key: `${id}/spec-deleted.jpg` });
    expect(deleteCalls).toContainEqual({ bucket: 'specimens', key: `${id}/ident-temp.jpg` });
    expect(deleteCalls).toContainEqual({ bucket: 'avatars', key: `${id}.jpg` });
    expect(deleteCalls).toHaveLength(4);
  });

  it('swallows Garage errors and still purges the DB', async () => {
    restoreGarage();
    restoreGarage = __setGarageForTests({
      deleteObjects: async ({ keys }) => ({
        deleted: [],
        errors: keys.map((key) => ({ key, message: 'garage down' })),
      }),
    });
    const { id, email } = await seedUser();

    await deleteAccount(id, email); // must not throw

    expect(await testDb.select().from(users).where(eq(users.id, id))).toHaveLength(0);
  });

  it('handles a user with no avatar and no objects', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: `${id}@x.com`, name: 'Empty' });

    await deleteAccount(id, `${id}@x.com`);

    expect(deleteCalls).toHaveLength(0);
    expect(await testDb.select().from(users).where(eq(users.id, id))).toHaveLength(0);
  });
});
