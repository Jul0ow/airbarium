# Lot 7 — Sync offline + retry identify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the offline-sync branch of `POST /v1/specimens` (multipart photo, server-side synchronous identification) and `POST /v1/specimens/:id/identify` (retry) to the Airbarium backend.

**Architecture:** `POST /v1/specimens` dispatches on Content-Type — `application/json` keeps the Lot 6 online flow untouched; `multipart/form-data` enters a new offline branch in `services/specimens.ts:create()` that uploads the photo to Garage, inserts a `source='none'` specimen, then best-effort identifies it synchronously (no 0.70 threshold). A new `retryIdentify()` re-fetches the photo from Garage and re-runs PlantNet for specimens still `source='none'`. Quota follows the Lot 5 convention: refund only on errors ≠ 200 PlantNet (timeout/5xx/quota), never on no_match.

**Tech Stack:** Bun, Hono, Drizzle (postgres-js), Zod v4, `@aws-sdk/client-s3` (Garage), PlantNet adapter. Tests: `bun test` against real Postgres + Garage (integration) and real Postgres + stubbed Garage/PlantNet (unit).

**Spec:** `docs/superpowers/specs/2026-06-11-lot-7-offline-sync-design.md`

**Worktree:** `/home/juloow/Documents/airbarium/.claude/worktrees/lot-7-offline` on branch `feat/lot-7-offline` (already created from `main` @ `1743ee7`).

**Pre-flight (run once before Task 1):**
```bash
docker compose up -d         # postgres + garage + mailhog
nix develop --command bun run db:migrate   # no new migration expected; schema unchanged
```

All commands below assume the `nix develop --command` prefix for `bun` (the toolchain is pinned via the Nix flake). Run from the worktree root.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `src/lib/garage.ts` | + `getObject({ bucket, key }): Promise<Uint8Array>` and its test stub | 1 |
| `src/schemas/specimens-offline.ts` | `CreateSpecimenOfflineFormSchema` — parse/validate multipart fields | 2 |
| `src/services/specimens.ts` | offline branch in `create()` + `retryIdentify()` | 3, 4 |
| `src/routes/specimens.ts` | Content-Type dispatch on POST + `/:id/identify` route | 5 |
| `tests/unit/services/specimens-offline.test.ts` | unit coverage for offline create + retry | 3, 4 |
| `tests/integration/specimens.test.ts` | E2E offline + retry | 6 |
| `README.md` | Lot 7 quickstart + roadmap status | 7 |

---

## Task 1: `getObject` in the Garage adapter

The retry flow re-downloads the specimen photo from Garage. The adapter currently has no read primitive. `GetObjectCommand` is already imported for `getSignedUrl`, so this is a small addition. The AWS SDK v3 `GetObjectCommand` returns a stream body with a `transformToByteArray()` helper.

**Files:**
- Modify: `src/lib/garage.ts`
- Test: `tests/integration/db` is not relevant; use a new integration-style test against real Garage at `tests/integration/garage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/garage.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'bun:test';
import { getObject, putObject } from '@/lib/garage';
import { cleanupGarageObjects, setupTestSpecimens, TEST_SPECIMENS_BUCKET } from '../helpers/garage';

beforeAll(async () => {
  await setupTestSpecimens();
});

describe('lib/garage getObject', () => {
  it('round-trips bytes put then get', async () => {
    const key = `gettest/${crypto.randomUUID()}.bin`;
    const body = new Uint8Array([1, 2, 3, 4, 5, 0xff, 0xd8, 0xff]);
    await putObject({ bucket: TEST_SPECIMENS_BUCKET, key, body, contentType: 'application/octet-stream' });

    const out = await getObject({ bucket: TEST_SPECIMENS_BUCKET, key });
    expect(Array.from(out)).toEqual(Array.from(body));

    await cleanupGarageObjects([{ bucket: TEST_SPECIMENS_BUCKET, key }]);
  });

  it('throws a NoSuchKey-shaped error for a missing key', async () => {
    let caught: unknown;
    try {
      await getObject({ bucket: TEST_SPECIMENS_BUCKET, key: `missing/${crypto.randomUUID()}.bin` });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const name = (caught as { name?: string }).name;
    expect(name === 'NoSuchKey' || name === 'NotFound').toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix develop --command bun test tests/integration/garage.test.ts`
Expected: FAIL — `getObject` is not exported from `@/lib/garage`.

- [ ] **Step 3: Add `getObject` to the adapter**

In `src/lib/garage.ts`, extend the `Impl` type and `defaultImpl`, then export. Add a `GetObjectInput` type next to the other input types:

```ts
export type GetObjectInput = {
  bucket: string;
  key: string;
};
```

Add to the `Impl` type:

```ts
type Impl = {
  ensureBucket: (bucket: string) => Promise<void>;
  putObject: (input: PutObjectInput) => Promise<void>;
  getObject: (input: GetObjectInput) => Promise<Uint8Array>;
  deleteObject: (input: DeleteObjectInput) => Promise<void>;
  getPresignedUrl: (input: PresignInput) => Promise<string>;
};
```

Add to `defaultImpl` (after `putObject`):

```ts
  async getObject({ bucket, key }) {
    const out = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) {
      // Object exists in metadata but has no body — treat as missing.
      const err = new Error(`garage.getObject: empty body for ${bucket}/${key}`);
      err.name = 'NoSuchKey';
      throw err;
    }
    return out.Body.transformToByteArray();
  },
```

Add the exported binding next to the others:

```ts
export const getObject = (input: GetObjectInput) => impl.getObject(input);
```

`GetObjectCommand` is already imported at the top of the file — no new import needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `nix develop --command bun test tests/integration/garage.test.ts`
Expected: PASS (2 tests). The missing-key case relies on the real Garage returning a `NoSuchKey`/`NotFound` error — the SDK surfaces `err.name === 'NoSuchKey'`.

- [ ] **Step 5: Verify the existing swap-helper unit test still passes**

The `__setGarageForTests` merges partial stubs over `defaultImpl`, so `getObject` is automatically available in stubs without changing `tests/unit/lib/garage.test.ts`. Confirm:

Run: `nix develop --command bun test tests/unit/lib/garage.test.ts`
Expected: PASS (3 tests, unchanged).

- [ ] **Step 6: Typecheck + commit**

```bash
nix develop --command bun run typecheck
git add src/lib/garage.ts tests/integration/garage.test.ts
git commit -m "feat(lot-7): add getObject to garage adapter"
```

---

## Task 2: Offline multipart schema

The multipart fields arrive as strings. This schema coerces `lat`/`lng` to numbers, pins `identification_source` to the literal `'none'`, and rejects unknown fields (including `identification_id` / `chosen_species_id`) via `.strict()`.

**Files:**
- Create: `src/schemas/specimens-offline.ts`
- Test: `tests/unit/schemas/specimens-offline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/schemas/specimens-offline.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { CreateSpecimenOfflineFormSchema } from '@/schemas/specimens-offline';
import { uuid7 } from '@/utils/uuid';

const base = () => ({
  id: uuid7(),
  identification_source: 'none',
  collected_at: '2026-06-11T10:00:00Z',
});

describe('CreateSpecimenOfflineFormSchema', () => {
  it('accepts minimal valid input and parses collected_at to a Date', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse(base());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.collected_at).toBeInstanceOf(Date);
  });

  it('coerces lat/lng strings to numbers within bounds', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), lat: '48.8566', lng: '2.3522' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.lat).toBeCloseTo(48.8566, 4);
      expect(r.data.lng).toBeCloseTo(2.3522, 4);
    }
  });

  it('rejects lat out of range', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), lat: '120' });
    expect(r.success).toBe(false);
  });

  it('rejects identification_source other than none', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), identification_source: 'plantnet_auto' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown fields like identification_id (strict)', () => {
    const r = CreateSpecimenOfflineFormSchema.safeParse({ ...base(), identification_id: uuid7() });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix develop --command bun test tests/unit/schemas/specimens-offline.test.ts`
Expected: FAIL — module `@/schemas/specimens-offline` does not exist.

- [ ] **Step 3: Implement the schema**

Create `src/schemas/specimens-offline.ts`:

```ts
import { z } from 'zod';

const isoTimestamp = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const CreateSpecimenOfflineFormSchema = z
  .object({
    id: z.uuid(),
    identification_source: z.literal('none'),
    collected_at: isoTimestamp,
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    location_label: z.string().min(1).max(256).optional(),
    user_notes: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type CreateSpecimenOfflineInput = z.infer<typeof CreateSpecimenOfflineFormSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nix develop --command bun test tests/unit/schemas/specimens-offline.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/specimens-offline.ts tests/unit/schemas/specimens-offline.test.ts
git commit -m "feat(lot-7): offline specimen multipart schema"
```

---

## Task 3: Offline branch of `services/specimens.ts:create()`

Split `CreateInput` into a discriminated union and add the offline branch. The online branch (Lot 6) stays byte-for-byte the same — it just moves behind an `if ('identification_id' in input)` guard. The offline branch uploads to Garage, inserts a `source='none'` specimen (reusing the Lot 6 23505 idempotent-recovery helper), then calls a best-effort `tryIdentifyOffline`.

**Files:**
- Modify: `src/services/specimens.ts`
- Test: `tests/unit/services/specimens-offline.test.ts`

- [ ] **Step 1: Write the failing test (create offline paths)**

Create `tests/unit/services/specimens-offline.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DAILY_PLANTNET_QUOTA } from '@/config/constants';
import { plantnetUsage, specimens, users } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import * as service from '@/services/specimens';
import type { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';
import { installMockPlantnet } from '../../helpers/plantnet';
import { flushPendingEnrichments } from '@/services/species-enrichment';
import { installMockWikipedia } from '../../helpers/wikipedia';

const restores: Array<() => void> = [];
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
  restores.length = 0;
  restores.push(
    __setGarageForTests({
      putObject: async () => {},
      getObject: async () => PHOTO,
      getPresignedUrl: async ({ key }) => `https://garage.test/${key}?sig=stub`,
    }),
  );
  restores.push(installMockWikipedia({ summary: null }));
});
afterEach(async () => {
  await flushPendingEnrichments();
  while (restores.length) restores.pop()?.();
});

async function makeUser(): Promise<string> {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'U' });
  return id;
}

function offlineInput(id: string) {
  return {
    id,
    photo: PHOTO,
    identification_source: 'none' as const,
    collected_at: new Date('2026-06-11T10:00:00Z'),
  };
}

async function usageCount(userId: string): Promise<number> {
  const [row] = await testDb
    .select({ count: plantnetUsage.count })
    .from(plantnetUsage)
    .where(eq(plantnetUsage.userId, userId));
  return row?.count ?? 0;
}

describe('service.create offline — PlantNet OK', () => {
  it('identifies the top match with no threshold (high confidence)', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet()); // default top = Lycoris radiata @ 0.9233
    const id = uuid7();
    const out = await service.create(uid, offlineInput(id));
    expect(out.wasCreated).toBe(true);
    expect(out.specimen.identification_source).toBe('plantnet_auto');
    expect(out.specimen.scientific_name).toBe('Lycoris radiata');
    expect(out.specimen.species_id).not.toBeNull();
    expect(out.specimen.confidence_score).toBeCloseTo(0.9233, 4);
  });

  it('identifies even when confidence is below 0.70 (no threshold offline)', async () => {
    const uid = await makeUser();
    restores.push(
      installMockPlantnet({
        results: [
          { scientificName: 'Acer rubrum', commonName: 'Érable', family: 'Sapindaceae', referencePhotoUrl: null, score: 0.21 },
        ],
      }),
    );
    const out = await service.create(uid, offlineInput(uuid7()));
    expect(out.specimen.identification_source).toBe('plantnet_auto');
    expect(out.specimen.scientific_name).toBe('Acer rubrum');
    expect(out.specimen.confidence_score).toBeCloseTo(0.21, 4);
  });
});

describe('service.create offline — PlantNet KO leaves source=none', () => {
  it('timeout → source none, quota refunded', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ fail: 'timeout' }));
    const out = await service.create(uid, offlineInput(uuid7()));
    expect(out.specimen.identification_source).toBe('none');
    expect(out.specimen.species_id).toBeNull();
    expect(await usageCount(uid)).toBe(0);
  });

  it('upstream 5xx → source none, quota refunded', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ fail: 'unavailable' }));
    const out = await service.create(uid, offlineInput(uuid7()));
    expect(out.specimen.identification_source).toBe('none');
    expect(await usageCount(uid)).toBe(0);
  });

  it('no_match → source none, quota NOT refunded (200 legit)', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ noMatch: true }));
    const out = await service.create(uid, offlineInput(uuid7()));
    expect(out.specimen.identification_source).toBe('none');
    expect(out.specimen.species_id).toBeNull();
    expect(await usageCount(uid)).toBe(1);
  });

  it('quota already exhausted → source none, PlantNet not consulted', async () => {
    const uid = await makeUser();
    const today = new Date().toISOString().slice(0, 10);
    await testDb.insert(plantnetUsage).values({ userId: uid, day: today, count: DAILY_PLANTNET_QUOTA });
    restores.push(installMockPlantnet()); // would succeed if called
    const out = await service.create(uid, offlineInput(uuid7()));
    expect(out.specimen.identification_source).toBe('none');
    // incrementOrThrow bumped then refunded itself on QUOTA_EXCEEDED → back to limit
    expect(await usageCount(uid)).toBe(DAILY_PLANTNET_QUOTA);
  });
});

describe('service.create offline — idempotence', () => {
  it('replaying the same id returns the existing specimen (200, no overwrite)', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    const id = uuid7();
    const first = await service.create(uid, offlineInput(id));
    expect(first.wasCreated).toBe(true);
    const second = await service.create(uid, offlineInput(id));
    expect(second.wasCreated).toBe(false);
    expect(second.specimen.id).toBe(id);
    expect(second.specimen.identification_source).toBe(first.specimen.identification_source);
  });

  it('id owned by another user → 409 ID_CONFLICT', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    restores.push(installMockPlantnet());
    const id = uuid7();
    await service.create(u1, offlineInput(id));
    try {
      await service.create(u2, offlineInput(id));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe('ID_CONFLICT');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix develop --command bun test tests/unit/services/specimens-offline.test.ts`
Expected: FAIL — `service.create` does not accept the offline input shape (TypeScript error) and/or throws because `identification_id` is missing.

- [ ] **Step 3: Refactor `CreateInput` into a union and guard the online branch**

In `src/services/specimens.ts`, rename the existing `CreateInput` type to `CreateOnlineInput` and add the offline variant + union:

```ts
export type CreateOnlineInput = {
  id: string;
  identification_id: string;
  chosen_species_id: string;
  identification_source: 'plantnet_auto' | 'plantnet_picked';
  collected_at: Date;
  lat?: number | undefined;
  lng?: number | undefined;
  location_label?: string | undefined;
  user_notes?: string | undefined;
};

export type CreateOfflineInput = {
  id: string;
  photo: Uint8Array;
  identification_source: 'none';
  collected_at: Date;
  lat?: number | undefined;
  lng?: number | undefined;
  location_label?: string | undefined;
  user_notes?: string | undefined;
};

export type CreateInput = CreateOnlineInput | CreateOfflineInput;
```

In `create()`, keep the step-1 idempotence block exactly as-is (it operates on `input.id`, common to both shapes), then branch right after it:

```ts
export async function create(userId: string, input: CreateInput): Promise<CreateResult> {
  // 1. Idempotence check (common to online + offline)
  const [existing] = await db.select().from(specimens).where(eq(specimens.id, input.id));
  if (existing) {
    if (existing.userId !== userId) {
      throw new AppError('ID_CONFLICT', `specimen id ${input.id} belongs to another user`, 409);
    }
    return { specimen: await toSpecimenResponse(existing), wasCreated: false };
  }

  if (!('identification_id' in input)) {
    return createOffline(userId, input);
  }

  // ... existing Lot 6 online flow (steps 2–6) unchanged ...
}
```

The existing online code from "// 2. Load identification" through the final `return { specimen: ..., wasCreated: true };` stays verbatim.

- [ ] **Step 4: Add `createOffline` and `tryIdentifyOffline`**

Add these below `create()` in `src/services/specimens.ts`. Import the PlantNet error classes, `identifyRaw`, quota helpers, `upsertFromPlantnet`, `scheduleEnrichment`, and `logger` at the top of the file:

```ts
import { logger } from '@/middleware/logger';
import {
  identifyRaw,
  PlantnetQuotaExhaustedError,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';
import { putObject } from '@/lib/garage';
import { incrementOrThrow, refund } from '@/services/quota';
import { upsertFromPlantnet } from '@/services/species';
import { scheduleEnrichment } from '@/services/species-enrichment';
```

(`getPresignedUrl` is already imported; add `putObject` to that import line. `eq`, `and` already imported.)

```ts
async function createOffline(userId: string, input: CreateOfflineInput): Promise<CreateResult> {
  const key = `${userId}/${input.id}.jpg`;
  await putObject({ bucket: SPECIMENS_BUCKET, key, body: input.photo, contentType: 'image/jpeg' });

  let inserted: Specimen;
  try {
    const [row] = await db
      .insert(specimens)
      .values({
        id: input.id,
        userId,
        photoUrl: key,
        identificationSource: 'none',
        lat: input.lat === undefined ? null : input.lat.toFixed(6),
        lng: input.lng === undefined ? null : input.lng.toFixed(6),
        locationLabel: input.location_label ?? null,
        userNotes: input.user_notes ?? null,
        collectedAt: input.collected_at,
      })
      .returning();
    if (!row) throw new AppError('INVARIANT', 'offline specimen insert returned no row', 500);
    inserted = row;
  } catch (err: unknown) {
    if (isUniquePkViolation(err)) {
      const [existing] = await db.select().from(specimens).where(eq(specimens.id, input.id));
      if (existing) {
        if (existing.userId !== userId) {
          throw new AppError('ID_CONFLICT', `specimen id ${input.id} belongs to another user`, 409);
        }
        return { specimen: await toSpecimenResponse(existing), wasCreated: false };
      }
    }
    throw err;
  }

  const final = await tryIdentifyOffline(userId, inserted, input.photo);
  return { specimen: await toSpecimenResponse(final), wasCreated: true };
}

// Best-effort: never throws. Returns the updated specimen if PlantNet matched,
// otherwise the original (source still 'none'). Quota is refunded only on
// errors ≠ 200 PlantNet (timeout / 5xx / global quota) — never on no_match,
// which is a legitimate 200 response (Lot 5 convention, MVP §8.1).
async function tryIdentifyOffline(
  userId: string,
  specimen: Specimen,
  photo: Uint8Array,
): Promise<Specimen> {
  try {
    await incrementOrThrow(userId);
  } catch {
    // QUOTA_EXCEEDED already refunds itself inside incrementOrThrow.
    return specimen;
  }

  let results: Awaited<ReturnType<typeof identifyRaw>>['results'];
  try {
    ({ results } = await identifyRaw(photo));
  } catch (err) {
    if (
      err instanceof PlantnetTimeoutError ||
      err instanceof PlantnetUnavailableError ||
      err instanceof PlantnetQuotaExhaustedError
    ) {
      await refund(userId);
      if (err instanceof PlantnetQuotaExhaustedError) {
        logger.error({ userId }, 'plantnet.global_quota_exhausted');
      }
      return specimen;
    }
    throw err; // unexpected, surface it
  }

  const top = results[0];
  if (!top) return specimen; // no_match: 200 legit, no refund, stays 'none'

  const pair = await upsertFromPlantnet({
    scientificName: top.scientificName,
    commonName: top.commonName,
    family: top.family,
    referencePhotoUrl: top.referencePhotoUrl,
  });
  if (pair.isNew) scheduleEnrichment(pair.species.id);

  const [updated] = await db
    .update(specimens)
    .set({
      speciesId: pair.species.id,
      identifiedName: top.commonName,
      scientificName: top.scientificName,
      family: top.family,
      confidenceScore: top.score.toFixed(4),
      identificationSource: 'plantnet_auto',
      updatedAt: new Date(),
    })
    .where(eq(specimens.id, specimen.id))
    .returning();
  return updated ?? specimen;
}
```

- [ ] **Step 5: Run the offline create tests**

Run: `nix develop --command bun test tests/unit/services/specimens-offline.test.ts`
Expected: PASS (all `create offline` describe blocks). `retryIdentify` tests are added in Task 4.

- [ ] **Step 6: Run the full Lot 6 unit suite for regressions**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts`
Expected: PASS (unchanged) — the online branch moved behind the `'identification_id' in input` guard but its body is identical.

- [ ] **Step 7: Typecheck + commit**

```bash
nix develop --command bun run typecheck
git add src/services/specimens.ts tests/unit/services/specimens-offline.test.ts
git commit -m "feat(lot-7): offline branch of specimen create with best-effort identify"
```

---

## Task 4: `retryIdentify` service

Re-identifies a `source='none'` specimen on demand. Quota is incremented up front (429 propagates), the photo is re-fetched from Garage, PlantNet runs, and the specimen is updated. Refund on 502 and photo-missing; no refund on no_match.

**Files:**
- Modify: `src/services/specimens.ts`
- Test: `tests/unit/services/specimens-offline.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append to the offline test file)**

Append to `tests/unit/services/specimens-offline.test.ts`:

```ts
async function makeNoneSpecimen(userId: string): Promise<string> {
  const id = uuid7();
  await testDb.insert(specimens).values({
    id,
    userId,
    photoUrl: `${userId}/${id}.jpg`,
    identificationSource: 'none',
    collectedAt: new Date(),
  });
  return id;
}

describe('service.retryIdentify', () => {
  it('identifies a none specimen → plantnet_auto, snapshot filled', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    const sid = await makeNoneSpecimen(uid);
    const out = await service.retryIdentify(uid, sid);
    expect(out.identification_source).toBe('plantnet_auto');
    expect(out.scientific_name).toBe('Lycoris radiata');
    expect(out.species_id).not.toBeNull();
  });

  it('404 when specimen does not exist', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    try {
      await service.retryIdentify(uid, uuid7());
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
      expect((e as AppError).code).toBe('SPECIMEN_NOT_FOUND');
    }
  });

  it('409 ALREADY_IDENTIFIED when source is plantnet_auto', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    const id = uuid7();
    await testDb.insert(specimens).values({
      id,
      userId: uid,
      photoUrl: `${uid}/${id}.jpg`,
      identificationSource: 'plantnet_auto',
      collectedAt: new Date(),
    });
    try {
      await service.retryIdentify(uid, id);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe('ALREADY_IDENTIFIED');
    }
  });

  it('409 ALREADY_IDENTIFIED when source is plantnet_picked', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    const id = uuid7();
    await testDb.insert(specimens).values({
      id,
      userId: uid,
      photoUrl: `${uid}/${id}.jpg`,
      identificationSource: 'plantnet_picked',
      collectedAt: new Date(),
    });
    try {
      await service.retryIdentify(uid, id);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('ALREADY_IDENTIFIED');
    }
  });

  it('429 when quota already exhausted (no refund beyond self-refund)', async () => {
    const uid = await makeUser();
    const today = new Date().toISOString().slice(0, 10);
    await testDb.insert(plantnetUsage).values({ userId: uid, day: today, count: DAILY_PLANTNET_QUOTA });
    restores.push(installMockPlantnet());
    const sid = await makeNoneSpecimen(uid);
    try {
      await service.retryIdentify(uid, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(429);
    }
    expect(await usageCount(uid)).toBe(DAILY_PLANTNET_QUOTA);
  });

  it('502 on PlantNet unavailable, quota refunded', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ fail: 'unavailable' }));
    const sid = await makeNoneSpecimen(uid);
    try {
      await service.retryIdentify(uid, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(502);
      expect((e as AppError).code).toBe('PLANTNET_UNAVAILABLE');
    }
    expect(await usageCount(uid)).toBe(0);
  });

  it('422 NO_MATCH on empty results, quota NOT refunded', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ noMatch: true }));
    const sid = await makeNoneSpecimen(uid);
    try {
      await service.retryIdentify(uid, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(422);
      expect((e as AppError).code).toBe('NO_MATCH');
    }
    expect(await usageCount(uid)).toBe(1);
  });

  it('500 PHOTO_NOT_FOUND when garage has no object, quota refunded', async () => {
    const uid = await makeUser();
    // Override getObject to simulate a missing key.
    restores.push(
      __setGarageForTests({
        getObject: async () => {
          const err = new Error('missing');
          err.name = 'NoSuchKey';
          throw err;
        },
      }),
    );
    restores.push(installMockPlantnet());
    const sid = await makeNoneSpecimen(uid);
    try {
      await service.retryIdentify(uid, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(500);
      expect((e as AppError).code).toBe('PHOTO_NOT_FOUND');
    }
    expect(await usageCount(uid)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix develop --command bun test tests/unit/services/specimens-offline.test.ts`
Expected: FAIL — `service.retryIdentify` is not exported.

- [ ] **Step 3: Implement `retryIdentify`**

Add `getObject` to the garage import line, then add the export to `src/services/specimens.ts`:

```ts
export async function retryIdentify(userId: string, id: string): Promise<SpecimenResponse> {
  const [s] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!s) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  if (s.identificationSource !== 'none') {
    throw new AppError('ALREADY_IDENTIFIED', `specimen ${id} is already identified`, 409);
  }

  await incrementOrThrow(userId); // 429 QUOTA_EXCEEDED propagates

  let photo: Uint8Array;
  try {
    photo = await getObject({ bucket: SPECIMENS_BUCKET, key: s.photoUrl });
  } catch (err) {
    await refund(userId);
    logger.error({ userId, id, key: s.photoUrl, err }, 'specimens.retry.photo_missing');
    throw new AppError('PHOTO_NOT_FOUND', `photo for specimen ${id} is missing in storage`, 500);
  }

  let results: Awaited<ReturnType<typeof identifyRaw>>['results'];
  try {
    ({ results } = await identifyRaw(photo));
  } catch (err) {
    await refund(userId);
    if (err instanceof PlantnetQuotaExhaustedError) {
      logger.error({ userId }, 'plantnet.global_quota_exhausted');
    }
    throw new AppError('PLANTNET_UNAVAILABLE', 'PlantNet upstream unavailable', 502);
  }

  const top = results[0];
  if (!top) {
    // no_match is a legitimate 200 — quota stays consumed (Lot 5 convention).
    throw new AppError('NO_MATCH', 'PlantNet returned no candidates', 422);
  }

  const pair = await upsertFromPlantnet({
    scientificName: top.scientificName,
    commonName: top.commonName,
    family: top.family,
    referencePhotoUrl: top.referencePhotoUrl,
  });
  if (pair.isNew) scheduleEnrichment(pair.species.id);

  const [updated] = await db
    .update(specimens)
    .set({
      speciesId: pair.species.id,
      identifiedName: top.commonName,
      scientificName: top.scientificName,
      family: top.family,
      confidenceScore: top.score.toFixed(4),
      identificationSource: 'plantnet_auto',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(specimens.id, id),
        eq(specimens.userId, userId),
        eq(specimens.identificationSource, 'none'),
      ),
    )
    .returning();

  if (!updated) {
    // A concurrent retry won the race and already identified this specimen.
    const [current] = await db
      .select()
      .from(specimens)
      .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
    if (!current) throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
    return toSpecimenResponse(current);
  }
  return toSpecimenResponse(updated);
}
```

- [ ] **Step 4: Run the full offline test file**

Run: `nix develop --command bun test tests/unit/services/specimens-offline.test.ts`
Expected: PASS (create + retry blocks).

- [ ] **Step 5: Typecheck + commit**

```bash
nix develop --command bun run typecheck
git add src/services/specimens.ts tests/unit/services/specimens-offline.test.ts
git commit -m "feat(lot-7): retryIdentify service for source=none specimens"
```

---

## Task 5: Route wiring — Content-Type dispatch + `/:id/identify`

`POST /v1/specimens` must accept JSON (Lot 6) or multipart (offline). Because `zValidator('json', ...)` consumes the body as JSON, the dispatch happens inside a single handler that reads `Content-Type` first. The JSON branch reproduces the Lot 6 validator hook behaviour (`OFFLINE_SOURCE_NOT_ALLOWED`). A `bodyLimit` guards the multipart upload before auth, mirroring `POST /identifications`.

**Files:**
- Modify: `src/routes/specimens.ts`
- Test: covered by integration (Task 6); no separate unit test for routing.

- [ ] **Step 1: Rewrite the POST handler and add the retry route**

Replace the `createValidator` usage and the `route.post('/specimens', ...)` block in `src/routes/specimens.ts`. Keep `parseSpecimenIdOr404`, `patchValidator`, `issuesPayload`, and the GET/PATCH/DELETE routes unchanged.

New imports at the top:

```ts
import { bodyLimit } from 'hono/body-limit';
import { CreateSpecimenOfflineFormSchema } from '@/schemas/specimens-offline';
import { JPEG_BODY_LIMIT_BYTES, validateJpeg } from '@/utils/jpeg';
```

Keep the existing `CreateSpecimenSchema` import. The `createValidator` helper is no longer used by the POST route — its `OFFLINE_SOURCE_NOT_ALLOWED` logic moves into the JSON branch below. Remove the `createValidator` definition.

Add a JSON-branch validation helper (reusing the Lot 6 hook semantics):

```ts
async function handleJsonCreate(c: Context<AppEnv>, userId: string) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  const result = CreateSpecimenSchema.safeParse(raw);
  if (!result.success) {
    const sourceIssue = result.error.issues.find(
      (i) => i.path.length === 1 && i.path[0] === 'identification_source',
    );
    if (sourceIssue) {
      throw new AppError(
        'OFFLINE_SOURCE_NOT_ALLOWED',
        'identification_source must be plantnet_auto or plantnet_picked',
        400,
        issuesPayload(result.error.issues),
      );
    }
    throw new ValidationError('Invalid request body', issuesPayload(result.error.issues));
  }
  return service.create(userId, result.data);
}
```

Add a multipart-branch helper:

```ts
async function handleMultipartCreate(c: Context<AppEnv>, userId: string) {
  const form = await c.req.parseBody();
  const photo = form.photo;
  if (!(photo instanceof File)) {
    throw new AppError('MISSING_FIELD', 'photo field is required', 400);
  }
  if (photo.type !== 'image/jpeg') {
    throw new AppError('INVALID_CONTENT_TYPE', 'photo must be image/jpeg', 400, {
      received: photo.type,
    });
  }
  const buffer = new Uint8Array(await photo.arrayBuffer());
  validateJpeg(buffer);

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k !== 'photo' && typeof v === 'string') fields[k] = v;
  }
  const result = CreateSpecimenOfflineFormSchema.safeParse(fields);
  if (!result.success) {
    throw new ValidationError('Invalid request body', issuesPayload(result.error.issues));
  }

  return service.create(userId, {
    id: result.data.id,
    photo: buffer,
    identification_source: 'none',
    collected_at: result.data.collected_at,
    lat: result.data.lat,
    lng: result.data.lng,
    location_label: result.data.location_label,
    user_notes: result.data.user_notes,
  });
}
```

Replace the POST route:

```ts
route.post(
  '/specimens',
  bodyLimit({
    maxSize: JPEG_BODY_LIMIT_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'File exceeds upload body limit', 413);
    },
  }),
  authMiddleware(),
  async (c) => {
    const user = requireUser(c);
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    let out: Awaited<ReturnType<typeof service.create>>;
    if (ct.startsWith('application/json')) {
      out = await handleJsonCreate(c, user.id);
    } else if (ct.startsWith('multipart/form-data')) {
      out = await handleMultipartCreate(c, user.id);
    } else {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected application/json or multipart/form-data', 415);
    }
    return c.json(out.specimen, out.wasCreated ? 201 : 200);
  },
);
```

Add the retry route after the DELETE route:

```ts
route.post('/specimens/:id/identify', authMiddleware(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  return c.json(await service.retryIdentify(user.id, id), 200);
});
```

Add the `Context` type import from Hono:

```ts
import type { Context } from 'hono';
```

- [ ] **Step 2: Typecheck**

Run: `nix develop --command bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run the Lot 6 integration suite for regressions (JSON path)**

Run: `nix develop --command bun test tests/integration/specimens.test.ts`
Expected: PASS (existing Lot 6 tests still green — the JSON dispatch preserves `OFFLINE_SOURCE_NOT_ALLOWED` and all status codes).

- [ ] **Step 4: Commit**

```bash
git add src/routes/specimens.ts
git commit -m "feat(lot-7): POST /specimens content-type dispatch + retry route"
```

---

## Task 6: Integration tests — offline sync + retry

End-to-end through the real app, real Postgres, real Garage, mocked PlantNet/Wikipedia. Append to `tests/integration/specimens.test.ts`.

**Files:**
- Modify: `tests/integration/specimens.test.ts`

- [ ] **Step 1: Add the offline-sync describe block**

Use the existing `tinyJpeg`, `makeUser`, `bearerHeaders`, `installMockPlantnet`, `createdKeys`, `restores` machinery already in the file. Append:

```ts
describe('POST /v1/specimens — offline sync (multipart)', () => {
  it('201 and identifies the specimen when PlantNet matches', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-a');
    restores.push(installMockPlantnet());
    const sid = uuid7();
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${sid}.jpg` });

    const form = new FormData();
    form.append('id', sid);
    form.append('identification_source', 'none');
    form.append('collected_at', '2026-06-11T10:00:00Z');
    form.append('photo', tinyJpeg(), 'flower.jpg');

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; identification_source: string; scientific_name: string | null; photo_url: string };
    expect(body.id).toBe(sid);
    expect(body.identification_source).toBe('plantnet_auto');
    expect(body.scientific_name).toBe('Lycoris radiata');
    expect(body.photo_url).toContain('X-Amz-Signature');
  });

  it('201 with source none when PlantNet is unavailable', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-b');
    restores.push(installMockPlantnet({ fail: 'unavailable' }));
    const sid = uuid7();
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${sid}.jpg` });

    const form = new FormData();
    form.append('id', sid);
    form.append('identification_source', 'none');
    form.append('collected_at', '2026-06-11T10:00:00Z');
    form.append('photo', tinyJpeg(), 'flower.jpg');

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { identification_source: string; species_id: string | null };
    expect(body.identification_source).toBe('none');
    expect(body.species_id).toBeNull();
  });

  it('replaying the same id is idempotent (200)', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-c');
    restores.push(installMockPlantnet());
    const sid = uuid7();
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${sid}.jpg` });

    const mk = () => {
      const form = new FormData();
      form.append('id', sid);
      form.append('identification_source', 'none');
      form.append('collected_at', '2026-06-11T10:00:00Z');
      form.append('photo', tinyJpeg(), 'flower.jpg');
      return app.request('/v1/specimens', { method: 'POST', headers: bearerHeaders(u.sessionToken), body: form });
    };
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(200);
  });

  it('400 when identification_source is not none in multipart', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-d');
    const form = new FormData();
    form.append('id', uuid7());
    form.append('identification_source', 'plantnet_auto');
    form.append('collected_at', '2026-06-11T10:00:00Z');
    form.append('photo', tinyJpeg(), 'flower.jpg');
    const res = await app.request('/v1/specimens', { method: 'POST', headers: bearerHeaders(u.sessionToken), body: form });
    expect(res.status).toBe(400);
  });

  it('400 MISSING_FIELD when photo is absent', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-e');
    const form = new FormData();
    form.append('id', uuid7());
    form.append('identification_source', 'none');
    form.append('collected_at', '2026-06-11T10:00:00Z');
    const res = await app.request('/v1/specimens', { method: 'POST', headers: bearerHeaders(u.sessionToken), body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_FIELD');
  });

  it('415 for an unsupported content-type', async () => {
    const app = buildTestApp();
    const u = await makeUser('off-f');
    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/xml' },
      body: '<x/>',
    });
    expect(res.status).toBe(415);
  });
});
```

- [ ] **Step 2: Add the retry describe block**

```ts
describe('POST /v1/specimens/:id/identify', () => {
  async function createOfflineNone(app: ReturnType<typeof buildTestApp>, u: Awaited<ReturnType<typeof makeUser>>) {
    const restore = installMockPlantnet({ fail: 'unavailable' });
    const sid = uuid7();
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${sid}.jpg` });
    const form = new FormData();
    form.append('id', sid);
    form.append('identification_source', 'none');
    form.append('collected_at', '2026-06-11T10:00:00Z');
    form.append('photo', tinyJpeg(), 'flower.jpg');
    const res = await app.request('/v1/specimens', { method: 'POST', headers: bearerHeaders(u.sessionToken), body: form });
    expect(res.status).toBe(201);
    restore(); // remove the failing mock
    return sid;
  }

  it('200 identifies a previously-unidentified specimen', async () => {
    const app = buildTestApp();
    const u = await makeUser('rty-a');
    const sid = await createOfflineNone(app, u);
    restores.push(installMockPlantnet());
    const res = await app.request(`/v1/specimens/${sid}/identify`, { method: 'POST', headers: bearerHeaders(u.sessionToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identification_source: string; scientific_name: string | null };
    expect(body.identification_source).toBe('plantnet_auto');
    expect(body.scientific_name).toBe('Lycoris radiata');
  });

  it('409 ALREADY_IDENTIFIED when re-identifying an identified specimen', async () => {
    const app = buildTestApp();
    const u = await makeUser('rty-b');
    const sid = await createOfflineNone(app, u);
    restores.push(installMockPlantnet());
    const first = await app.request(`/v1/specimens/${sid}/identify`, { method: 'POST', headers: bearerHeaders(u.sessionToken) });
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/specimens/${sid}/identify`, { method: 'POST', headers: bearerHeaders(u.sessionToken) });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ALREADY_IDENTIFIED');
  });

  it('429 when the daily quota is exhausted', async () => {
    const app = buildTestApp();
    const u = await makeUser('rty-c');
    const sid = await createOfflineNone(app, u);
    const today = new Date().toISOString().slice(0, 10);
    await testDb
      .insert(plantnetUsage)
      .values({ userId: u.userId, day: today, count: 30 })
      .onConflictDoUpdate({ target: [plantnetUsage.userId, plantnetUsage.day], set: { count: 30 } });
    restores.push(installMockPlantnet());
    const res = await app.request(`/v1/specimens/${sid}/identify`, { method: 'POST', headers: bearerHeaders(u.sessionToken) });
    expect(res.status).toBe(429);
  });

  it('502 and refunds quota when PlantNet is unavailable', async () => {
    const app = buildTestApp();
    const u = await makeUser('rty-d');
    const sid = await createOfflineNone(app, u);
    restores.push(installMockPlantnet({ fail: 'unavailable' }));
    const res = await app.request(`/v1/specimens/${sid}/identify`, { method: 'POST', headers: bearerHeaders(u.sessionToken) });
    expect(res.status).toBe(502);
    const [usage] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, u.userId));
    expect(usage?.count ?? 0).toBe(0);
  });
});
```

Add the `plantnetUsage` import to the file's schema import (`import { identifications, plantnetUsage, specimens } from '@/db/schema';`).

- [ ] **Step 3: Run the integration suite**

Run: `nix develop --command bun test tests/integration/specimens.test.ts`
Expected: PASS — Lot 6 tests plus the new offline + retry blocks. Note: the `createOfflineNone` helper installs a transient failing mock and restores it immediately so the offline POST leaves `source='none'` without polluting later `restores` teardown.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/specimens.test.ts
git commit -m "test(lot-7): integration coverage for offline sync and retry identify"
```

---

## Task 7: README + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the Lot 7 section to README**

Add a "Lot 7 — Offline sync + retry identify" section documenting the two flows with curl examples (mirror the §-Verification block in the spec), and flip Lot 7 to ✅ in the roadmap status table. Example block to include:

````markdown
## Lot 7 — Offline sync + retry identify

`POST /v1/specimens` accepts **multipart/form-data** for specimens captured offline
(no prior identification). The server stores the photo and attempts a synchronous
PlantNet identification (no 0.70 threshold). If PlantNet is down or the quota is
spent, the specimen is created with `identification_source: "none"` and a 201 is
still returned.

```bash
curl -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" \
  -F "id=<uuid7>" \
  -F "identification_source=none" \
  -F "collected_at=2026-06-11T12:00:00Z" \
  -F "photo=@./flower.jpg"
```

Retry identification for a `none` specimen:

```bash
curl -X POST http://localhost:3000/v1/specimens/<id>/identify \
  -H "Authorization: Bearer $TOKEN"
# 200 updated specimen | 409 ALREADY_IDENTIFIED | 429 quota | 502 PlantNet down
```
````

- [ ] **Step 2: Full verification suite**

Run:
```bash
nix develop --command bun run typecheck
nix develop --command bun run lint
nix develop --command bun test
```
Expected: typecheck clean, lint clean, all tests green (Lots 1–7).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(lot-7): README quickstart for offline sync and retry"
```

---

## Self-Review (run after all tasks)

1. **Final code review** — dispatch a code reviewer subagent (superpowers:requesting-code-review) over the whole diff `1743ee7..HEAD`. Fix Critical + Important.
2. **Spec coverage check** — every row in the spec §2 decisions table maps to a task: endpoint dispatch (T5), offline body (T2), no threshold (T3 tests), swallow KO + refund convention (T3/T4 tests), idempotence (T3), retry eligibility/quota/photo-missing (T4), error codes (T4/T5).
3. Then proceed to `superpowers:finishing-a-development-branch` (push + PR, after user confirmation).

---

## Self-Review notes (author)

- **Spec coverage:** every spec §2 row has a task (see above). §4.1/§4.2 algorithms map to Task 3 (`tryIdentifyOffline`) and Task 4 (`retryIdentify`) verbatim.
- **Type consistency:** `CreateOfflineInput.photo: Uint8Array`, `identification_source: 'none'` used identically in service (T3), route construction (T5), and unit tests (T3). `getObject({ bucket, key }): Promise<Uint8Array>` signature identical in T1 (definition), T4 (usage), and stubs.
- **Quota convention:** refund on timeout/5xx/quota and photo-missing; NOT on no_match — consistent across T3 (`tryIdentifyOffline`), T4 (`retryIdentify`), and asserted in both unit and integration tests, matching Lot 5 (`identifications.test.ts:162`).
- **No placeholders:** every code step shows complete code; every run step has an exact command + expected outcome.
