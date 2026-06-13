# Lot 8b — Cron Purge Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-shot Bun cron worker that purges expired/old data (temp identifications, old soft-deleted specimens, old plantnet_usage) and reconciles orphaned Garage objects, then exits.

**Architecture:** A pure, testable `runPurgeCycle()` in `src/services/purge.ts` runs four steps (3 DB purges + Garage orphan reconciliation) and returns aggregate counters. A thin `src/cron.ts` entrypoint calls it, closes the DB connection, and `process.exit`s 0/1 (1 if any step had a DB/list error, so a k8s CronJob can retry). A new paginated `listObjects` capability is added to `src/lib/garage.ts`.

**Tech Stack:** Bun, Drizzle ORM (Postgres), `@aws-sdk/client-s3` (`ListObjectsV2Command`) via `lib/garage.ts`, `pino` logger, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-13-lot-8b-cron-purge-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/garage.ts` | **Modify.** Add `listObjects` (paginated ListObjectsV2) + `GarageObject` type, wired into the `Impl`/`__setGarageForTests` injection pattern. |
| `src/config/constants.ts` | **Modify.** Add `SPECIMEN_SOFT_DELETE_RETENTION_DAYS`, `PLANTNET_USAGE_RETENTION_DAYS`, `ORPHAN_GRACE_MS`. |
| `src/services/purge.ts` | **New.** `runPurgeCycle()` + `purgeExpiredIdentifications`, `purgeOldSoftDeletedSpecimens`, `purgeOldPlantnetUsage`, `reconcileOrphans`. Pure, no Hono. |
| `src/cron.ts` | **New.** One-shot entrypoint. |
| `package.json` | **Modify.** Add `"cron": "bun src/cron.ts"`. |
| `tests/unit/lib/garage.test.ts` | **Modify.** Add `listObjects` routing test. |
| `tests/integration/garage.test.ts` | **Modify.** Add real `listObjects` round-trip test. |
| `tests/integration/cron-purge.test.ts` | **New.** Purge + reconcile + cycle tests. |
| `README.md` | **Modify.** Cron section + `bun run cron` + lot 8b status. |

No Drizzle migration (no schema change). No new dependency.

**Pinned codebase facts (do not re-derive):**
- `bun`/`biome` are NOT on PATH — prefix every command with `nix develop --command` (e.g. `nix develop --command bun test ...`).
- Garage lib uses an `Impl` object + `__setGarageForTests(partial)` returning a `restore()`; exported bindings (`putObject`, `deleteObject`, …) delegate to `impl`. Add `listObjects` the same way.
- Garage keys: specimens at bucket `specimens`, key `<user_id>/<id>.jpg`; avatars at bucket `avatars`, key `<user_id>.jpg`. `specimens.photoUrl` / `identifications.photoUrl` / `users.avatarUrl` store the bare key.
- Schema columns: `identifications` has `photoStatus` (enum `'temp'|'promoted'|'expired'`), `expiresAt` (nullable timestamptz), `photoUrl`. `specimens` has `deletedAt` (nullable timestamptz), `photoUrl`. `plantnetUsage` has `day` (date, mode `'string'`).
- DB: `import { db, rawClient } from '@/db/client'`. Drizzle delete-returning: `db.delete(t).where(...).returning({ x: t.col })` → array.
- Tests run against the real test DB (`setupTestDb`/`truncateAll`/`testDb` from `tests/helpers/db`) and real Garage (`setupTestSpecimens`/`setupTestGarage`/`cleanupGarageObjects` from `tests/helpers/garage`). Garage is stubbable via `__setGarageForTests`. Postgres+Garage docker stack is running; env + node_modules set up.
- Minimal valid inserts: `users` `{ id, email, name }`; `identifications` `{ id, userId, photoUrl, plantnetRawResponse: { results: [] } }`; `specimens` `{ id, userId, photoUrl, collectedAt }`.
- `uuid7()` from `@/utils/uuid`. Logger: `import { logger } from '@/middleware/logger'`.

---

## Task 1: `listObjects` in `lib/garage.ts`

**Files:**
- Modify: `src/lib/garage.ts`
- Test: `tests/unit/lib/garage.test.ts`, `tests/integration/garage.test.ts`

- [ ] **Step 1: Write the failing unit (routing) test**

In `tests/unit/lib/garage.test.ts`, add `listObjects` to the imports from `@/lib/garage`, and add this test inside the `describe('lib/garage swap helper', …)` block:

```typescript
  it('routes listObjects through the swapped impl', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    restore = __setGarageForTests({
      listObjects: async ({ bucket, prefix }) => {
        return [{ key: `${bucket}/${prefix ?? ''}obj.jpg`, lastModified: stamp }];
      },
    });

    const out = await listObjects({ bucket: 'b1', prefix: 'p/' });
    expect(out).toEqual([{ key: 'b1/p/obj.jpg', lastModified: stamp }]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nix develop --command bun test tests/unit/lib/garage.test.ts`
Expected: FAIL — `listObjects` is not exported from `@/lib/garage`.

- [ ] **Step 3: Implement `listObjects`**

In `src/lib/garage.ts`:

Add `ListObjectsV2Command` to the `@aws-sdk/client-s3` import list.

Add the type and input near the other input types:
```typescript
export type GarageObject = { key: string; lastModified: Date };

export type ListObjectsInput = {
  bucket: string;
  prefix?: string;
};
```

Add `listObjects` to the `Impl` type:
```typescript
  listObjects: (input: ListObjectsInput) => Promise<GarageObject[]>;
```

Add the default implementation inside `defaultImpl` (after `deleteObject`):
```typescript
  async listObjects({ bucket, prefix }) {
    const s3 = getClient();
    const objects: GarageObject[] = [];
    let continuationToken: string | undefined;
    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of out.Contents ?? []) {
        if (obj.Key) {
          objects.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
        }
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  },
```

Add the exported binding next to the others:
```typescript
export const listObjects = (input: ListObjectsInput) => impl.listObjects(input);
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `nix develop --command bun test tests/unit/lib/garage.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Write the failing integration test**

In `tests/integration/garage.test.ts`, add `listObjects` to the imports from `@/lib/garage`, and add this `describe` block at the end of the file:

```typescript
describe('lib/garage listObjects', () => {
  it('lists objects under a prefix with their lastModified', async () => {
    const prefix = `listtest/${crypto.randomUUID()}/`;
    const keyA = `${prefix}a.bin`;
    const keyB = `${prefix}b.bin`;
    const body = new Uint8Array([1, 2, 3]);
    await putObject({ bucket: TEST_SPECIMENS_BUCKET, key: keyA, body, contentType: 'x' });
    await putObject({ bucket: TEST_SPECIMENS_BUCKET, key: keyB, body, contentType: 'x' });

    const out = await listObjects({ bucket: TEST_SPECIMENS_BUCKET, prefix });
    const keys = out.map((o) => o.key).sort();
    expect(keys).toEqual([keyA, keyB].sort());
    for (const o of out) {
      expect(o.lastModified).toBeInstanceOf(Date);
    }

    await cleanupGarageObjects([
      { bucket: TEST_SPECIMENS_BUCKET, key: keyA },
      { bucket: TEST_SPECIMENS_BUCKET, key: keyB },
    ]);
  });
});
```

- [ ] **Step 6: Run the integration test to verify it passes**

Run: `nix develop --command bun test tests/integration/garage.test.ts`
Expected: PASS (existing + new test). Requires docker stack (running).

- [ ] **Step 7: Commit**

```bash
git add src/lib/garage.ts tests/unit/lib/garage.test.ts tests/integration/garage.test.ts
git commit -m "feat(lot-8b): add paginated listObjects to garage lib"
```

---

## Task 2: Constants + the three DB purges

**Files:**
- Modify: `src/config/constants.ts`
- Create: `src/services/purge.ts`
- Test: `tests/integration/cron-purge.test.ts`

- [ ] **Step 1: Add constants**

Append to `src/config/constants.ts`:
```typescript
export const SPECIMEN_SOFT_DELETE_RETENTION_DAYS = 30;
export const PLANTNET_USAGE_RETENTION_DAYS = 7;
// Aligned with IDENTIFICATION_TEMP_TTL_MS: a Garage object that is unreferenced
// and older than this is necessarily a true orphan (no upload flow lasts that long).
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 2: Write the failing purge tests**

Create `tests/integration/cron-purge.test.ts`:

```typescript
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
    await putObject({ bucket: 'specimens', key: expiredKey, body: JPEG, contentType: 'image/jpeg' });
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
    expect(await testDb.select().from(identifications).where(eq(identifications.id, expiredId))).toHaveLength(0);
    expect(await testDb.select().from(identifications).where(eq(identifications.id, freshId))).toHaveLength(1);
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
      expect(await testDb.select().from(identifications).where(eq(identifications.id, id))).toHaveLength(0);
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
      { id: oldId, userId, photoUrl: oldKey, collectedAt: new Date(), deletedAt: new Date(Date.now() - 31 * DAY_MS) },
      { id: recentId, userId, photoUrl: recentKey, collectedAt: new Date(), deletedAt: new Date(Date.now() - 5 * DAY_MS) },
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
      { userId, day: isoDaysAgo(0), count: 1 },
    ]);

    const res = await purgeOldPlantnetUsage();

    expect(res.errored).toBe(false);
    expect(res.rowsDeleted).toBe(1);
    const remaining = await testDb.select().from(plantnetUsage).where(eq(plantnetUsage.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.day).toBe(isoDaysAgo(0));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nix develop --command bun test tests/integration/cron-purge.test.ts`
Expected: FAIL — `@/services/purge` does not exist.

- [ ] **Step 4: Implement the three purges**

Create `src/services/purge.ts`:

```typescript
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import {
  PLANTNET_USAGE_RETENTION_DAYS,
  SPECIMEN_SOFT_DELETE_RETENTION_DAYS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
import { db } from '@/db/client';
import { identifications, plantnetUsage, specimens } from '@/db/schema';
import { deleteObject } from '@/lib/garage';
import { logger } from '@/middleware/logger';

export type CategoryResult = {
  rowsDeleted: number;
  garageDeleted: number;
  garageFailed: number;
  errored: boolean;
};

function newCategoryResult(): CategoryResult {
  return { rowsDeleted: 0, garageDeleted: 0, garageFailed: 0, errored: false };
}

// Best-effort delete of the given keys in one bucket. Failures are logged and
// counted, never thrown — a Garage outage must not fail the purge.
async function purgeGarageKeys(bucket: string, keys: string[], res: CategoryResult): Promise<void> {
  const settled = await Promise.allSettled(keys.map((key) => deleteObject({ bucket, key })));
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      res.garageDeleted++;
    } else {
      res.garageFailed++;
      logger.warn({ err: s.reason, bucket, key: keys[i] }, 'cron.purge: garage delete failed');
    }
  });
}

export async function purgeExpiredIdentifications(): Promise<CategoryResult> {
  const res = newCategoryResult();
  let keys: string[];
  try {
    const rows = await db
      .delete(identifications)
      .where(and(eq(identifications.photoStatus, 'temp'), lt(identifications.expiresAt, sql`now()`)))
      .returning({ photoUrl: identifications.photoUrl });
    keys = rows.map((r) => r.photoUrl);
    res.rowsDeleted = keys.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeExpiredIdentifications: db delete failed');
    return res;
  }
  await purgeGarageKeys(SPECIMENS_BUCKET, keys, res);
  return res;
}

export async function purgeOldSoftDeletedSpecimens(): Promise<CategoryResult> {
  const res = newCategoryResult();
  let keys: string[];
  try {
    const rows = await db
      .delete(specimens)
      .where(
        and(
          isNotNull(specimens.deletedAt),
          lt(
            specimens.deletedAt,
            sql`now() - (interval '1 day' * ${SPECIMEN_SOFT_DELETE_RETENTION_DAYS})`,
          ),
        ),
      )
      .returning({ photoUrl: specimens.photoUrl });
    keys = rows.map((r) => r.photoUrl);
    res.rowsDeleted = keys.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeOldSoftDeletedSpecimens: db delete failed');
    return res;
  }
  await purgeGarageKeys(SPECIMENS_BUCKET, keys, res);
  return res;
}

export async function purgeOldPlantnetUsage(): Promise<CategoryResult> {
  const res = newCategoryResult();
  try {
    const rows = await db
      .delete(plantnetUsage)
      .where(lt(plantnetUsage.day, sql`current_date - ${PLANTNET_USAGE_RETENTION_DAYS}`))
      .returning({ day: plantnetUsage.day });
    res.rowsDeleted = rows.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeOldPlantnetUsage: db delete failed');
  }
  return res;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nix develop --command bun test tests/integration/cron-purge.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `nix develop --command bash -c 'bun run typecheck && bun run lint'` (run `bun run format` and re-check if lint flags formatting).

```bash
git add src/config/constants.ts src/services/purge.ts tests/integration/cron-purge.test.ts
git commit -m "feat(lot-8b): purge services for expired identifications, old specimens, old usage"
```

---

## Task 3: Orphan reconciliation + `runPurgeCycle`

**Files:**
- Modify: `src/services/purge.ts`
- Test: `tests/integration/cron-purge.test.ts`

- [ ] **Step 1: Write the failing reconcile + cycle tests**

In `tests/integration/cron-purge.test.ts`, add `reconcileOrphans` and `runPurgeCycle` to the import from `@/services/purge`, add `AVATARS_BUCKET` usage via the literal `'avatars'`, and append:

```typescript
describe('reconcileOrphans', () => {
  it('deletes old unreferenced objects, keeps referenced and recent ones', async () => {
    const userId = await makeUser();
    // referenced by a specimen row
    const refKey = `${userId}/ref.jpg`;
    await putObject({ bucket: 'specimens', key: refKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb.insert(specimens).values({ id: uuid7(), userId, photoUrl: refKey, collectedAt: new Date() });
    // two real unreferenced objects
    const orphanOldKey = `${userId}/orphan-old.jpg`;
    const orphanRecentKey = `${userId}/orphan-recent.jpg`;
    await putObject({ bucket: 'specimens', key: orphanOldKey, body: JPEG, contentType: 'image/jpeg' });
    await putObject({ bucket: 'specimens', key: orphanRecentKey, body: JPEG, contentType: 'image/jpeg' });

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
      expect(res.orphanReconciliation.scanned).toBe(0);
    } finally {
      restore();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nix develop --command bun test tests/integration/cron-purge.test.ts`
Expected: FAIL — `reconcileOrphans` / `runPurgeCycle` are not exported yet.

- [ ] **Step 3: Implement `reconcileOrphans` and `runPurgeCycle`**

In `src/services/purge.ts`:

Extend the constants import to add `AVATARS_BUCKET` and `ORPHAN_GRACE_MS`:
```typescript
import {
  AVATARS_BUCKET,
  ORPHAN_GRACE_MS,
  PLANTNET_USAGE_RETENTION_DAYS,
  SPECIMEN_SOFT_DELETE_RETENTION_DAYS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
```

Extend the schema import to add `users`:
```typescript
import { identifications, plantnetUsage, specimens, users } from '@/db/schema';
```

Extend the garage import to add `listObjects`:
```typescript
import { deleteObject, listObjects } from '@/lib/garage';
```

Append:
```typescript
export type ReconcileResult = {
  scanned: number;
  orphansDeleted: number;
  garageFailed: number;
  errored: boolean;
};

// Reconcile orphaned Garage objects: objects whose key is referenced by no DB
// row. Runs AFTER the purges, so freshly-purged objects are already gone and we
// only catch true orphans (failed purge/account-deletion deletes, aborted
// temp->promoted renames). A grace window protects in-flight uploads.
export async function reconcileOrphans(): Promise<ReconcileResult> {
  const res: ReconcileResult = { scanned: 0, orphansDeleted: 0, garageFailed: 0, errored: false };
  const now = Date.now();

  let buckets: Array<{ bucket: string; refs: Set<string> }>;
  try {
    const [specimenRows, identRows, avatarRows] = await Promise.all([
      db.select({ k: specimens.photoUrl }).from(specimens),
      db.select({ k: identifications.photoUrl }).from(identifications),
      db.select({ k: users.avatarUrl }).from(users).where(isNotNull(users.avatarUrl)),
    ]);
    const specimensRefs = new Set<string>([...specimenRows, ...identRows].map((r) => r.k));
    const avatarsRefs = new Set<string>(avatarRows.map((r) => r.k as string));
    buckets = [
      { bucket: SPECIMENS_BUCKET, refs: specimensRefs },
      { bucket: AVATARS_BUCKET, refs: avatarsRefs },
    ];
  } catch (err) {
    // Never delete on an incomplete reference set.
    res.errored = true;
    logger.error({ err }, 'cron.reconcileOrphans: failed to build referenced-key set; skipping');
    return res;
  }

  for (const { bucket, refs } of buckets) {
    let objects: Awaited<ReturnType<typeof listObjects>>;
    try {
      objects = await listObjects({ bucket });
    } catch (err) {
      res.errored = true;
      logger.error({ err, bucket }, 'cron.reconcileOrphans: listObjects failed; skipping bucket');
      continue;
    }
    res.scanned += objects.length;
    for (const obj of objects) {
      if (refs.has(obj.key)) continue;
      if (now - obj.lastModified.getTime() <= ORPHAN_GRACE_MS) continue;
      try {
        await deleteObject({ bucket, key: obj.key });
        res.orphansDeleted++;
      } catch (err) {
        res.garageFailed++;
        logger.warn({ err, bucket, key: obj.key }, 'cron.reconcileOrphans: orphan delete failed');
      }
    }
  }
  return res;
}

export type PurgeCycleResult = {
  expiredIdentifications: CategoryResult;
  oldSoftDeletedSpecimens: CategoryResult;
  oldPlantnetUsage: CategoryResult;
  orphanReconciliation: ReconcileResult;
  hadError: boolean;
};

export async function runPurgeCycle(): Promise<PurgeCycleResult> {
  logger.info('cron: purge cycle starting');
  const expiredIdentifications = await purgeExpiredIdentifications();
  const oldSoftDeletedSpecimens = await purgeOldSoftDeletedSpecimens();
  const oldPlantnetUsage = await purgeOldPlantnetUsage();
  const orphanReconciliation = await reconcileOrphans();
  const hadError =
    expiredIdentifications.errored ||
    oldSoftDeletedSpecimens.errored ||
    oldPlantnetUsage.errored ||
    orphanReconciliation.errored;
  const result: PurgeCycleResult = {
    expiredIdentifications,
    oldSoftDeletedSpecimens,
    oldPlantnetUsage,
    orphanReconciliation,
    hadError,
  };
  logger.info({ result }, 'cron: purge cycle complete');
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nix develop --command bun test tests/integration/cron-purge.test.ts`
Expected: PASS (all 7 tests in the file).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `nix develop --command bash -c 'bun run typecheck && bun run lint'` (format + recheck if needed).

```bash
git add src/services/purge.ts tests/integration/cron-purge.test.ts
git commit -m "feat(lot-8b): Garage orphan reconciliation + runPurgeCycle"
```

---

## Task 4: `cron.ts` entrypoint + script + README + full verify

**Files:**
- Create: `src/cron.ts`
- Modify: `package.json`, `README.md`

- [ ] **Step 1: Create the entrypoint**

Create `src/cron.ts`:
```typescript
import { rawClient } from '@/db/client';
import { logger } from '@/middleware/logger';
import { runPurgeCycle } from '@/services/purge';

const result = await runPurgeCycle();
await rawClient.end();
logger.info({ hadError: result.hadError }, 'cron: exiting');
process.exit(result.hadError ? 1 : 0);
```

- [ ] **Step 2: Add the script**

In `package.json`, add to `"scripts"` (after `"start"`):
```json
    "cron": "bun src/cron.ts",
```

- [ ] **Step 3: Smoke-run the worker**

Run: `nix develop --command bun run cron`
Expected: logs a "purge cycle starting" then "purge cycle complete" then "exiting" line, and the process exits 0 (no error on an empty/clean DB). Confirm the process actually terminates (does not hang) — this verifies `rawClient.end()` + `process.exit`.

- [ ] **Step 4: Update the README**

Read `README.md` first. Add a cron section consistent with the existing lot sections (French), documenting:
- the command `bun run cron` (one-shot: runs one purge cycle then exits);
- what it purges: temp identifications expirées, specimens soft-deleted > 30 j, plantnet_usage > 7 j, + réconciliation des objets Garage orphelins (non référencés, > 24 h) ;
- best-effort Garage, `exit(1)` si une étape DB échoue (le CronJob k8s du Lot 8e retentera) ;
- ordonnancement délégué au CronJob (Lot 8e), métriques `/metrics` à venir (Lot 8d).

Update the roadmap/status line: lot 8b livré (cron purge + réconciliation orphelins) ; reste 8c (rate-limit), 8d (observabilité), 8e (Helm).

- [ ] **Step 5: Full verification suite**

Run: `nix develop --command bash -c 'bun run typecheck && bun run lint && bun test'`
Expected: typecheck clean, lint clean, ALL tests pass (full suite incl. new cron-purge + garage tests). If a pre-existing unrelated test fails, do NOT fix unrelated code — report DONE_WITH_CONCERNS with details. The new tests MUST pass.

- [ ] **Step 6: Commit**

```bash
git add src/cron.ts package.json README.md
git commit -m "feat(lot-8b): one-shot cron entrypoint, cron script, README"
```

---

## Self-Review Notes

- **Spec coverage:** `listObjects` (Task 1); 3 purges with SQL cutoffs + best-effort Garage (Task 2); orphan reconciliation with referenced-set guard, grace window, after-purges ordering (Task 3); one-shot entrypoint with `exit(1)` on DB/list error, `cron` script, README (Task 4). Logging via `logger` throughout. Metrics/CronJob/Helm correctly out of scope.
- **Grace-window test:** uses a stubbed `listObjects` returning controlled `lastModified` while `deleteObject` stays real — the only reliable way to simulate >24h-old objects against live Garage. Documented in spec §9.
- **Guard test:** triggers via `listObjects` throwing (the achievable failure injection) and asserts `errored=true` + zero deletes. The reference-set-query guard is the same `try/catch` structure and returns before any delete.
- **Type consistency:** `CategoryResult` / `ReconcileResult` / `PurgeCycleResult` field names match across `purge.ts` and the tests (`rowsDeleted`, `garageDeleted`, `garageFailed`, `errored`, `scanned`, `orphansDeleted`, `hadError`). `GarageObject` = `{ key, lastModified }` used identically in lib + reconcile + tests.
- **No migration / no new dependency** confirmed.
