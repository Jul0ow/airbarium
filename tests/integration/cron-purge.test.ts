import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AUTH_RATE_LIMIT_MAX_WINDOW_MS } from '@/config/constants';
import {
  authRateLimit,
  identifications,
  plantnetUsage,
  rateLimit,
  specimens,
  users,
} from '@/db/schema';
import { __setGarageForTests, getObject, putObject } from '@/lib/garage';
import {
  purgeExpiredIdentifications,
  purgeExpiredRateLimits,
  purgeOldPlantnetUsage,
  purgeOldSoftDeletedSpecimens,
  purgeStaleAuthRateLimits,
  reconcileOrphans,
  runPurgeCycle,
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

describe('reconcileOrphans', () => {
  it('deletes old unreferenced objects, keeps referenced and recent ones', async () => {
    const userId = await makeUser();
    // referenced by a specimen row
    const refKey = `${userId}/ref.jpg`;
    await putObject({ bucket: 'specimens', key: refKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb
      .insert(specimens)
      .values({ id: uuid7(), userId, photoUrl: refKey, collectedAt: new Date() });
    // two real unreferenced objects
    const orphanOldKey = `${userId}/orphan-old.jpg`;
    const orphanRecentKey = `${userId}/orphan-recent.jpg`;
    await putObject({
      bucket: 'specimens',
      key: orphanOldKey,
      body: JPEG,
      contentType: 'image/jpeg',
    });
    await putObject({
      bucket: 'specimens',
      key: orphanRecentKey,
      body: JPEG,
      contentType: 'image/jpeg',
    });

    // Stub only the listing (to control lastModified); deleteObject stays real.
    const restore = __setGarageForTests({
      listObjects: async ({ bucket }) => {
        if (bucket !== 'specimens') return [];
        return [
          { key: refKey, lastModified: new Date(Date.now() - 48 * 60 * 60 * 1000) },
          { key: orphanOldKey, lastModified: new Date(Date.now() - 25 * 60 * 60 * 1000) },
          { key: orphanRecentKey, lastModified: new Date() },
        ];
      },
    });
    try {
      const res = await reconcileOrphans();
      expect(res.errored).toBe(false);
      expect(res.orphansDeleted).toBe(1);
      expect(await objectExists('specimens', orphanOldKey)).toBe(false);
      expect(await objectExists('specimens', orphanRecentKey)).toBe(true);
      expect(await objectExists('specimens', refKey)).toBe(true);
    } finally {
      restore();
      await cleanupGarageObjects([
        { bucket: 'specimens', key: refKey },
        { bucket: 'specimens', key: orphanRecentKey },
      ]);
    }
  });

  it('deletes nothing and reports errored when listing fails (guard)', async () => {
    // Covers the per-bucket listObjects-failure path; the DB reference-set-failure
    // guard (early return before any listing) is covered by code inspection.
    let deleteCalled = false;
    const restore = __setGarageForTests({
      listObjects: async () => {
        throw new Error('list down');
      },
      deleteObject: async () => {
        deleteCalled = true;
      },
    });
    try {
      const res = await reconcileOrphans();
      expect(res.errored).toBe(true);
      expect(res.orphansDeleted).toBe(0);
      expect(deleteCalled).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('purgeExpiredRateLimits', () => {
  it('deletes expired rate_limit rows, leaves fresh ones', async () => {
    const expiredKey = 'user:expired@x.com';
    const freshKey = 'user:fresh@x.com';
    const windowStart = new Date();
    await testDb.insert(rateLimit).values([
      {
        key: expiredKey,
        windowStart,
        count: 5,
        expiresAt: new Date(Date.now() - 60 * 1000), // 1 minute ago
      },
      {
        key: freshKey,
        windowStart,
        count: 2,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      },
    ]);

    const res = await purgeExpiredRateLimits();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    expect(await testDb.select().from(rateLimit).where(eq(rateLimit.key, expiredKey))).toHaveLength(
      0,
    );
    expect(await testDb.select().from(rateLimit).where(eq(rateLimit.key, freshKey))).toHaveLength(
      1,
    );
  });
});

describe('purgeStaleAuthRateLimits', () => {
  it('deletes stale auth_rate_limit rows (older than window), leaves fresh ones', async () => {
    const staleId = uuid7();
    const freshId = uuid7();
    const staleTs = Date.now() - 2 * AUTH_RATE_LIMIT_MAX_WINDOW_MS; // 2 hours ago
    const freshTs = Date.now(); // now
    await testDb.insert(authRateLimit).values([
      { id: staleId, key: `sign-in:${staleId}`, count: 3, lastRequest: staleTs },
      { id: freshId, key: `sign-in:${freshId}`, count: 1, lastRequest: freshTs },
    ]);

    const res = await purgeStaleAuthRateLimits();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    expect(
      await testDb.select().from(authRateLimit).where(eq(authRateLimit.id, staleId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(authRateLimit).where(eq(authRateLimit.id, freshId)),
    ).toHaveLength(1);
  });

  it('keeps a row that is just inside the window (strict < boundary)', async () => {
    const boundaryId = uuid7();
    // The delete condition is lastRequest < (Date.now() - AUTH_RATE_LIMIT_MAX_WINDOW_MS).
    // A row at (now - window + 5s) is 5s inside the window at insert time and will
    // stay inside even if a slow/suspended CI runner advances Date.now() by several
    // seconds between this insert and the purge call.
    const justInsideWindow = Date.now() - AUTH_RATE_LIMIT_MAX_WINDOW_MS + 5000;
    await testDb.insert(authRateLimit).values({
      id: boundaryId,
      key: `sign-in:${boundaryId}`,
      count: 1,
      lastRequest: justInsideWindow,
    });

    const res = await purgeStaleAuthRateLimits();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(0);
    expect(
      await testDb.select().from(authRateLimit).where(eq(authRateLimit.id, boundaryId)),
    ).toHaveLength(1);
  });
});

describe('runPurgeCycle', () => {
  it('runs all steps, aggregates counters, hadError=false on a clean run', async () => {
    const userId = await makeUser();
    // one expired identification (will be purged)
    const idnId = uuid7();
    const idnKey = `${userId}/${idnId}.jpg`;
    await putObject({ bucket: 'specimens', key: idnKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb.insert(identifications).values({
      id: idnId,
      userId,
      photoUrl: idnKey,
      plantnetRawResponse: { results: [] },
      photoStatus: 'temp',
      expiresAt: new Date(Date.now() - 1000),
    });
    // one old plantnet_usage row
    await testDb.insert(plantnetUsage).values({ userId, day: isoDaysAgo(10), count: 2 });

    // Stub listObjects to [] so reconciliation is deterministic (no cross-test scan).
    const restore = __setGarageForTests({ listObjects: async () => [] });
    try {
      const res = await runPurgeCycle();
      expect(res.hadError).toBe(false);
      expect(res.expiredIdentifications.rowsDeleted).toBe(1);
      expect(res.oldPlantnetUsage.rowsDeleted).toBe(1);
      expect(res.expiredRateLimits.rowsDeleted).toBe(0);
      expect(res.staleAuthRateLimits.rowsDeleted).toBe(0);
      expect(res.orphanReconciliation.scanned).toBe(0);
    } finally {
      restore();
    }
  });
});
