import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, plantnetUsage, specimens, users } from '@/db/schema';
import { __setGarageForTests, getObject, putObject } from '@/lib/garage';
import {
  purgeExpiredIdentifications,
  purgeOldPlantnetUsage,
  purgeOldSoftDeletedSpecimens,
} from '@/services/purge';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { cleanupGarageObjects, setupTestSpecimens } from '../helpers/garage';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDb();
  await setupTestSpecimens();
});

beforeEach(async () => {
  await truncateAll();
});

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

async function makeUser(): Promise<string> {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@x.com`, name: 'U' });
  return id;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

describe('purgeExpiredIdentifications', () => {
  it('deletes expired temp identifications + their Garage objects, leaves others', async () => {
    const userId = await makeUser();
    const expiredId = uuid7();
    const expiredKey = `${userId}/${expiredId}.jpg`;
    const freshId = uuid7();
    const freshKey = `${userId}/${freshId}.jpg`;
    await putObject({
      bucket: 'specimens',
      key: expiredKey,
      body: JPEG,
      contentType: 'image/jpeg',
    });
    await putObject({ bucket: 'specimens', key: freshKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb.insert(identifications).values([
      {
        id: expiredId,
        userId,
        photoUrl: expiredKey,
        plantnetRawResponse: { results: [] },
        photoStatus: 'temp',
        expiresAt: new Date(Date.now() - 1000),
      },
      {
        id: freshId,
        userId,
        photoUrl: freshKey,
        plantnetRawResponse: { results: [] },
        photoStatus: 'temp',
        expiresAt: new Date(Date.now() + 1_000_000),
      },
    ]);

    const res = await purgeExpiredIdentifications();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    expect(res.garageDeleted).toBe(1);
    expect(
      await testDb.select().from(identifications).where(eq(identifications.id, expiredId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(identifications).where(eq(identifications.id, freshId)),
    ).toHaveLength(1);
    expect(await objectExists('specimens', expiredKey)).toBe(false);
    expect(await objectExists('specimens', freshKey)).toBe(true);

    await cleanupGarageObjects([{ bucket: 'specimens', key: freshKey }]);
  });

  it('counts garageFailed but does not error when Garage delete throws', async () => {
    const userId = await makeUser();
    const id = uuid7();
    const key = `${userId}/${id}.jpg`;
    await testDb.insert(identifications).values({
      id,
      userId,
      photoUrl: key,
      plantnetRawResponse: { results: [] },
      photoStatus: 'temp',
      expiresAt: new Date(Date.now() - 1000),
    });

    const restore = __setGarageForTests({
      deleteObject: async () => {
        throw new Error('garage down');
      },
    });
    try {
      const res = await purgeExpiredIdentifications();
      expect(res.rowsDeleted).toBe(1);
      expect(res.garageFailed).toBe(1);
      expect(res.errored).toBe(false);
      expect(
        await testDb.select().from(identifications).where(eq(identifications.id, id)),
      ).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe('purgeOldSoftDeletedSpecimens', () => {
  it('deletes specimens soft-deleted past retention, leaves recent + active', async () => {
    const userId = await makeUser();
    const oldId = uuid7();
    const recentId = uuid7();
    const activeId = uuid7();
    const oldKey = `${userId}/${oldId}.jpg`;
    const recentKey = `${userId}/${recentId}.jpg`;
    const activeKey = `${userId}/${activeId}.jpg`;
    for (const key of [oldKey, recentKey, activeKey]) {
      await putObject({ bucket: 'specimens', key, body: JPEG, contentType: 'image/jpeg' });
    }
    await testDb.insert(specimens).values([
      {
        id: oldId,
        userId,
        photoUrl: oldKey,
        collectedAt: new Date(),
        deletedAt: new Date(Date.now() - 31 * DAY_MS),
      },
      {
        id: recentId,
        userId,
        photoUrl: recentKey,
        collectedAt: new Date(),
        deletedAt: new Date(Date.now() - 5 * DAY_MS),
      },
      { id: activeId, userId, photoUrl: activeKey, collectedAt: new Date() },
    ]);

    const res = await purgeOldSoftDeletedSpecimens();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    expect(res.garageDeleted).toBe(1);
    expect(await testDb.select().from(specimens).where(eq(specimens.id, oldId))).toHaveLength(0);
    expect(await testDb.select().from(specimens).where(eq(specimens.id, recentId))).toHaveLength(1);
    expect(await testDb.select().from(specimens).where(eq(specimens.id, activeId))).toHaveLength(1);
    expect(await objectExists('specimens', oldKey)).toBe(false);
    expect(await objectExists('specimens', recentKey)).toBe(true);
    expect(await objectExists('specimens', activeKey)).toBe(true);

    await cleanupGarageObjects([
      { bucket: 'specimens', key: recentKey },
      { bucket: 'specimens', key: activeKey },
    ]);
  });
});

describe('purgeOldPlantnetUsage', () => {
  it('deletes usage rows older than retention, leaves recent', async () => {
    const userId = await makeUser();
    await testDb.insert(plantnetUsage).values([
      { userId, day: isoDaysAgo(10), count: 3 },
      // Exactly at the retention boundary: condition is `< 7 days`, so this row stays.
      { userId, day: isoDaysAgo(7), count: 2 },
      { userId, day: isoDaysAgo(0), count: 1 },
    ]);

    const res = await purgeOldPlantnetUsage();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    const remaining = await testDb
      .select()
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, userId));
    expect(remaining).toHaveLength(2);
    const days = remaining.map((r) => r.day).sort();
    expect(days).toEqual([isoDaysAgo(7), isoDaysAgo(0)].sort());
  });
});
