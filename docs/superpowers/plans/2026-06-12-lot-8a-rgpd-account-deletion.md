# Lot 8a — RGPD Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `DELETE /v1/me` — a RGPD hard delete that purges all of a user's data from Postgres (cascade) and Garage (best-effort).

**Architecture:** A thin Hono route delegates to a new `account-deletion` service. The service captures every Garage object key inside a Postgres transaction *before* deleting the `users` row (the DB cascade then wipes specimens, identifications, plantnet_usage, account, session), then purges the captured Garage objects best-effort outside the transaction. Garage failures are logged and swallowed — the DB delete is never rolled back.

**Tech Stack:** Bun, Hono, Drizzle ORM (Postgres), `@aws-sdk/client-s3` via `lib/garage.ts`, Better Auth, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-12-lot-8a-rgpd-account-deletion-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/account-deletion.ts` | **New.** `deleteAccount(userId, userEmail)` — capture keys + cascade delete (tx) + best-effort Garage purge. |
| `src/routes/me.ts` | **Modify.** Add `route.delete('/me', …)` delegating to the service + clear session cookie. |
| `tests/unit/services/account-deletion.test.ts` | **New.** Service tested against real test DB with Garage stubbed (`__setGarageForTests`). |
| `tests/integration/me-delete.test.ts` | **New.** HTTP route against real Postgres + real Garage. |
| `README.md` | **Modify.** Add `DELETE /v1/me` to the exposed endpoints. |

No Drizzle migration: every user-owned table already has `onDelete: 'cascade'` on `userId` (verified in `src/db/schema/`). No new dependency.

**Key facts pinned from the codebase (do not re-derive):**
- Garage buckets: specimens at bucket `specimens` key `<user_id>/<id>.jpg`; avatar at bucket `avatars` key `<user_id>.jpg`. `users.avatarUrl` / `specimens.photoUrl` / `identifications.photoUrl` store the **bare key**, not a URL.
- `lib/garage.ts` exposes `deleteObject({ bucket, key })` and `__setGarageForTests(stub) => restore`.
- Service-layer "unit" tests in this repo use the **real** test DB (`setupTestDb`/`truncateAll`/`testDb`) and stub only Garage — follow `tests/unit/services/photo-storage.test.ts`.
- `requireUser(c)` returns the Better Auth user (has `.id` and `.email`).
- Minimal valid inserts: `specimens` needs `{ id, userId, photoUrl, collectedAt }`; `identifications` needs `{ id, userId, photoUrl, plantnetRawResponse }` (use `{ results: [] }`).

---

## Task 1: `account-deletion` service

**Files:**
- Create: `src/services/account-deletion.ts`
- Test: `tests/unit/services/account-deletion.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/account-deletion.test.ts`:

```typescript
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
    deleteObject: async ({ bucket, key }) => {
      deleteCalls.push({ bucket, key });
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
  await testDb
    .insert(verification)
    .values({ id: uuid7(), identifier: email, value: 'tok', expiresAt: new Date(Date.now() + 1e6) });
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
      deleteObject: async () => {
        throw new Error('garage down');
      },
    });
    const { id } = await seedUser();

    await deleteAccount(id, `${id}@example.com`); // must not throw

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/services/account-deletion.test.ts`
Expected: FAIL — `Cannot find module '@/services/account-deletion'` (the service does not exist yet).

- [ ] **Step 3: Write the service**

Create `src/services/account-deletion.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { identifications, specimens, users, verification } from '@/db/schema';
import { deleteObject } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const SPECIMENS_BUCKET = 'specimens';
const AVATARS_BUCKET = 'avatars';

/**
 * RGPD hard delete. Captures every Garage object key inside a transaction
 * BEFORE deleting the user row (the DB cascade wipes specimens, identifications,
 * plantnet_usage, account and session). Garage objects are then purged
 * best-effort OUTSIDE the transaction: failures are logged and swallowed so a
 * Garage outage never rolls back the structured-data deletion.
 */
export async function deleteAccount(userId: string, userEmail: string): Promise<void> {
  // 1. Capture keys + cascade delete, atomically.
  const { specimenKeys, identificationKeys, avatarKey } = await db.transaction(async (tx) => {
    const specimenRows = await tx
      .select({ photoUrl: specimens.photoUrl })
      .from(specimens)
      .where(eq(specimens.userId, userId)); // ALL rows, incl. soft-deleted
    const identificationRows = await tx
      .select({ photoUrl: identifications.photoUrl })
      .from(identifications)
      .where(eq(identifications.userId, userId));
    const [userRow] = await tx
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, userId));

    await tx.delete(verification).where(eq(verification.identifier, userEmail));
    await tx.delete(users).where(eq(users.id, userId));

    return {
      specimenKeys: specimenRows.map((r) => r.photoUrl),
      identificationKeys: identificationRows.map((r) => r.photoUrl),
      avatarKey: userRow?.avatarUrl ?? null,
    };
  });

  // 2. Best-effort Garage purge, deduplicated, outside the transaction.
  const seen = new Set<string>();
  const targets: Array<{ bucket: string; key: string }> = [];
  for (const key of [...specimenKeys, ...identificationKeys]) {
    const dedupId = `${SPECIMENS_BUCKET}\n${key}`;
    if (!seen.has(dedupId)) {
      seen.add(dedupId);
      targets.push({ bucket: SPECIMENS_BUCKET, key });
    }
  }
  if (avatarKey) targets.push({ bucket: AVATARS_BUCKET, key: avatarKey });

  const results = await Promise.allSettled(targets.map((t) => deleteObject(t)));
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      logger.warn(
        { err: res.reason, bucket: targets[i].bucket, key: targets[i].key, userId },
        'account-deletion: garage purge failed',
      );
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/services/account-deletion.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/account-deletion.ts tests/unit/services/account-deletion.test.ts
git commit -m "feat(lot-8a): account-deletion service (cascade DB + best-effort Garage purge)"
```

---

## Task 2: `DELETE /v1/me` route

**Files:**
- Modify: `src/routes/me.ts`
- Test: `tests/integration/me-delete.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/me-delete.test.ts`:

```typescript
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens, users } from '@/db/schema';
import { __setGarageForTests, getObject, putObject } from '@/lib/garage';
import { uuid7 } from '@/utils/uuid';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { cleanupGarageObjects, setupTestGarage, setupTestSpecimens } from '../helpers/garage';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';

let mailer: MockMailerHandle;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

beforeAll(async () => {
  await setupTestDb();
  await setupTestGarage();
  await setupTestSpecimens();
});

beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
});

afterEach(() => mailer.restore());

type ErrorBody = { error: { code: string; message: string } };

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

describe('DELETE /v1/me', () => {
  it('returns 401 without authentication', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/me', { method: 'DELETE' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('hard-deletes the user, cascade rows, and Garage objects', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'doomed@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Doomed',
    });

    // avatar
    const avatarKey = `${u.userId}.jpg`;
    await putObject({ bucket: 'avatars', key: avatarKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb.update(users).set({ avatarUrl: avatarKey }).where(eq(users.id, u.userId));

    // active + soft-deleted specimen, each with a real Garage object
    const activeKey = `${u.userId}/spec-active.jpg`;
    const deletedKey = `${u.userId}/spec-deleted.jpg`;
    const identKey = `${u.userId}/ident.jpg`;
    for (const key of [activeKey, deletedKey, identKey]) {
      await putObject({ bucket: 'specimens', key, body: JPEG, contentType: 'image/jpeg' });
    }
    await testDb.insert(specimens).values([
      { id: uuid7(), userId: u.userId, photoUrl: activeKey, collectedAt: new Date() },
      {
        id: uuid7(),
        userId: u.userId,
        photoUrl: deletedKey,
        collectedAt: new Date(),
        deletedAt: new Date(),
      },
    ]);
    await testDb.insert(identifications).values({
      id: uuid7(),
      userId: u.userId,
      photoUrl: identKey,
      plantnetRawResponse: { results: [] },
    });

    const res = await app.request('/v1/me', {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(204);

    // DB purged (cascade)
    expect(await testDb.select().from(users).where(eq(users.id, u.userId))).toHaveLength(0);
    expect(
      await testDb.select().from(specimens).where(eq(specimens.userId, u.userId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(identifications).where(eq(identifications.userId, u.userId)),
    ).toHaveLength(0);

    // Garage purged
    expect(await objectExists('avatars', avatarKey)).toBe(false);
    expect(await objectExists('specimens', activeKey)).toBe(false);
    expect(await objectExists('specimens', deletedKey)).toBe(false);
    expect(await objectExists('specimens', identKey)).toBe(false);

    // session invalid afterwards
    const after = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    expect(after.status).toBe(401);
  });

  it('still returns 204 and purges the DB when Garage delete fails', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'garagedown@example.com',
      password: 'correct-horse-battery-staple',
      name: 'GarageDown',
    });
    const key = `${u.userId}/spec.jpg`;
    await testDb
      .insert(specimens)
      .values({ id: uuid7(), userId: u.userId, photoUrl: key, collectedAt: new Date() });

    const restore = __setGarageForTests({
      deleteObject: async () => {
        throw new Error('garage down');
      },
    });
    try {
      const res = await app.request('/v1/me', {
        method: 'DELETE',
        headers: bearerHeaders(u.sessionToken),
      });
      expect(res.status).toBe(204);
      expect(await testDb.select().from(users).where(eq(users.id, u.userId))).toHaveLength(0);
    } finally {
      restore();
      await cleanupGarageObjects([{ bucket: 'specimens', key }]);
    }
  });

  it('does not touch another user’s data', async () => {
    const app = buildTestApp();
    const victim = await signUpTestUser(app, {
      email: 'victim@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Victim',
    });
    const bystander = await signUpTestUser(app, {
      email: 'bystander@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Bystander',
    });

    const res = await app.request('/v1/me', {
      method: 'DELETE',
      headers: bearerHeaders(victim.sessionToken),
    });
    expect(res.status).toBe(204);

    expect(await testDb.select().from(users).where(eq(users.id, bystander.userId))).toHaveLength(1);
    const ok = await app.request('/v1/me', { headers: bearerHeaders(bystander.sessionToken) });
    expect(ok.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/integration/me-delete.test.ts`
Expected: FAIL — the `DELETE /v1/me` route does not exist, so the authenticated call returns 404 (not 204) and the cascade assertions fail. (Requires `docker compose up -d`.)

- [ ] **Step 3: Add the route**

In `src/routes/me.ts`, add the import for the cookie helper and the service near the existing imports:

```typescript
import { deleteCookie } from 'hono/cookie';
import { deleteAccount } from '@/services/account-deletion';
```

Then add this route handler (place it after the existing `route.delete('/me/avatar', …)` block, before `export default route;`):

```typescript
route.delete('/me', authMiddleware(), async (c) => {
  const user = requireUser(c);
  await deleteAccount(user.id, user.email);
  // Real invalidation is the cascade-deleted session row (Bearer clients hold
  // no cookie); clearing the cookie is cosmetic cleanup for web clients.
  deleteCookie(c, 'better-auth.session_token');
  deleteCookie(c, '__Secure-better-auth.session_token');
  return c.body(null, 204);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/integration/me-delete.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/me.ts tests/integration/me-delete.test.ts
git commit -m "feat(lot-8a): DELETE /v1/me route (RGPD account deletion)"
```

---

## Task 3: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the endpoint**

In `README.md`, locate the list of exposed endpoints under the profile/account section (near the other `/v1/me` routes) and add a row/line:

```
DELETE /v1/me          # RGPD : hard delete du compte (DB cascade + purge Garage), 204
```

If the README tracks roadmap status, note that lot 8a (RGPD account deletion) is delivered; the rest of lot 8 (cron 8b, rate-limit 8c, observability 8d, Helm 8e) remains pending.

- [ ] **Step 2: Run the full verification suite**

Run: `bun run typecheck && bun run lint && bun test`
Expected: typecheck clean, lint clean, all tests pass (new unit + integration green). Requires `docker compose up -d`.

If lint reports formatting issues, run `bun run format` and re-run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(lot-8a): document DELETE /v1/me and lot 8a status"
```

---

## Self-Review Notes

- **Spec coverage:** contract + 401 (Task 2 test 1), route delegation (Task 2 step 3), capture-before-cascade + transaction (Task 1 service), purge all specimens incl. soft-deleted (Task 1 & 2 tests), identifications + avatar purge (both tests), `verification` by email (Task 1 service + test), best-effort Garage resilience (both tests), session invalidation (Task 2 test 2), no over-deletion (Task 2 test 4), README (Task 3). Idempotent re-delete is covered implicitly: after deletion the session row is gone, so a second `DELETE /v1/me` returns 401 (same as Task 2 test 1's unauthenticated path).
- **No new dependency / no migration** — cascade FKs already exist.
- **Type consistency:** service exports `deleteAccount(userId: string, userEmail: string): Promise<void>`; both route and tests call it / the route with exactly that signature. Garage stub shape matches `__setGarageForTests(Partial<Impl>)`.
