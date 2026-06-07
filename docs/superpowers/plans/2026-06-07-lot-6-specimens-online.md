# Lot 6 — Specimens online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher la transformation `identifications` → `specimens` côté API online — `POST /v1/specimens` idempotent avec validations de seuil + pool, `GET /v1/specimens` paginé/filtré, `GET /v1/specimens/:id`, `GET /v1/specimens/stats`, `PATCH /v1/specimens/:id`, `DELETE /v1/specimens/:id` soft.

**Architecture:** Un service `specimens.ts` qui porte toute la business logic (create, getById, list, patch, softDelete, stats) et reste réutilisable par Lot 7 (la branche offline-sync ajoutera juste une seconde voie dans `create`). Une route Hono fine. Un utilitaire `cursor.ts` pour la pagination composite (`{k, v, id}` base64). Pas de copy/delete S3 — `specimens.photo_url = identifications.photo_url` (même clé Garage), on flip uniquement `photo_status='promoted'` + `promoted_at`. Validation du pool de candidats par recompute depuis `identifications.plantnet_raw_response.results[].species.scientificNameWithoutAuthor`.

**Tech Stack:** Bun + Hono + Drizzle + Postgres 17 + Garage S3 + Zod.

---

## Contexte

Lot 5 (Identifications) est mergé via PR #7 (`b0e13b0`). Le worktree `feat/lot-6-specimens` existe déjà avec la spec design `docs/superpowers/specs/2026-06-07-lot-6-specimens-online-design.md`. Tous les schémas Drizzle nécessaires existent depuis Lot 2 (`specimens`, `identifications`, `species`, `users`) — **aucune migration à générer**.

## Pré-requis exécution (avant Task 1)

- Worktree `feat/lot-6-specimens` actif (cwd = `/home/juloow/Documents/airbarium/.claude/worktrees/lot-6-specimens`).
- `docker compose up -d` tourne (postgres + garage + mailhog).
- `.env` symlinké depuis le repo principal (déjà fait — `ls -la .env` montre le lien).
- DB de test `airbarium_test` migrée. Si absente : `docker exec $(docker compose ps -q postgres) psql -U airbarium -c 'CREATE DATABASE airbarium_test;'` puis `DATABASE_URL=postgres://airbarium:dev@localhost:5432/airbarium_test nix develop --command bun run db:migrate`.

## Conventions

- **Tests Bun** : `nix develop --command bun test <path>` (les env vars sont lues depuis `.env`).
- **Typecheck/lint** : `nix develop --command bun run typecheck` / `nix develop --command bun run lint`.
- **Format** : `nix develop --command biome check --write .` pour auto-fix imports + lint.
- **Commits** : Conventional Commits préfixés `(lot-6)` (ex. `feat(lot-6): ...`, `test(lot-6): ...`).
- **TDD strict** : test → run (fail) → impl minimale → run (pass) → commit. Pas d'impl avant test.
- **Pattern singleton+swap** déjà éprouvé pour les adapters externes : utilisé ici uniquement via `__setGarageForTests` pour stub `getPresignedUrl` dans les unit tests.
- **Erreurs** : `throw new AppError(code, message, status, details?)` partout. Le middleware `error-handler` mappe au format `{ error: { code, message, details? } }`.
- **404 cross-user** : pas de leak. Specimen non trouvé OU appartenant à un autre user → 404, sauf POST où la collision d'id distingue 409 `ID_CONFLICT`.

## Types partagés (référence pour toutes les tasks)

Définis dans `src/utils/cursor.ts` :

```ts
export type CursorKey = 'collected_at' | 'created_at' | 'identified_name';

export type Cursor = {
  k: CursorKey;
  v: string;       // ISO timestamp for date keys, string for identified_name
  id: string;      // tie-breaker
};
```

Définis dans `src/schemas/specimens.ts` :

```ts
export type CreateSpecimenInput = z.infer<typeof CreateSpecimenSchema>;
export type PatchSpecimenInput = z.infer<typeof PatchSpecimenSchema>;
export type ListSpecimensQuery = z.infer<typeof ListSpecimensQuerySchema>;
```

Définis dans `src/services/specimens.ts` :

```ts
export type SpecimenResponse = {
  id: string;
  identification_id: string | null;
  species_id: string | null;
  photo_url: string;                 // pré-signé 1h, toujours régénéré
  identified_name: string | null;
  scientific_name: string | null;
  family: string | null;
  confidence_score: number | null;
  identification_source: 'plantnet_auto' | 'plantnet_picked' | 'none';
  lat: number | null;
  lng: number | null;
  location_label: string | null;
  user_notes: string | null;
  collected_at: string;              // ISO
  created_at: string;                // ISO
  updated_at: string;                // ISO
};

export type CreateResult = {
  specimen: SpecimenResponse;
  wasCreated: boolean;               // false si idempotence (200 vs 201)
};

export type ListResult = {
  data: SpecimenResponse[];
  next_cursor: string | null;
};

export type StatsResult = {
  total: number;
  distinct_species: number;
};
```

Codes d'erreur ajoutés (utilisés directement via `AppError`, pas de nouvelle classe) :

| Code | Status | Cas |
|---|---|---|
| `ID_CONFLICT` | 409 | POST `id` existant pour un autre user |
| `OFFLINE_SOURCE_NOT_ALLOWED` | 400 | POST avec `identification_source = 'none'` |
| `IDENTIFICATION_NOT_FOUND` | 404 | POST `identification_id` inconnu ou cross-user |
| `ALREADY_PROMOTED` | 409 | POST sur identification déjà consommée |
| `IDENTIFICATION_EXPIRED` | 410 | POST sur identification `expires_at <= now()` |
| `INVALID_CHOICE` | 400 | POST `chosen_species_id` hors pool |
| `THRESHOLD_VIOLATED` | 400 | POST seuil 0.70 incohérent |
| `SPECIMEN_NOT_FOUND` | 404 | GET/PATCH/DELETE id inexistant ou cross-user |
| `INVALID_CURSOR` | 400 | GET list cursor malformé |
| `INVALID_PATCH` | 400 | PATCH body vide ou empty string |

---

## File Structure

### Nouveaux

| Path | Responsabilité |
|---|---|
| `src/utils/cursor.ts` | `encodeCursor(c: Cursor) → string` / `decodeCursor(s: string \| null \| undefined): Cursor \| null` |
| `src/schemas/specimens.ts` | Zod schemas : `CreateSpecimenSchema`, `PatchSpecimenSchema`, `ListSpecimensQuerySchema` |
| `src/services/specimens.ts` | `create`, `getById`, `list`, `patch`, `softDelete`, `stats`, `toSpecimenResponse` (privé) |
| `src/routes/specimens.ts` | 6 routes Hono avec `authMiddleware()` |
| `tests/unit/utils/cursor.test.ts` | Round-trip + malformed |
| `tests/unit/services/specimens.test.ts` | Real DB, stub `getPresignedUrl`, couvre tous les chemins du service |
| `tests/integration/specimens.test.ts` | End-to-end via `buildTestApp` + PlantNet mocké |

### Modifiés

| Path | Change |
|---|---|
| `src/routes/index.ts` | `routes.route('/', specimens)` après `species` |
| `README.md` | Section `## Lot 6 — Specimens quickstart` |

---

## Tasks

### Task 1: Cursor utility (encode/decode opaque base64)

**Files:**
- Create: `src/utils/cursor.ts`
- Test: `tests/unit/utils/cursor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/utils/cursor.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { type Cursor, decodeCursor, encodeCursor } from '@/utils/cursor';

describe('cursor', () => {
  it('round-trips collected_at cursor', () => {
    const cur: Cursor = {
      k: 'collected_at',
      v: '2026-06-07T10:00:00.000Z',
      id: '0190d8a4-1234-7890-abcd-ef0123456789',
    };
    const back = decodeCursor(encodeCursor(cur));
    expect(back).toEqual(cur);
  });

  it('round-trips created_at cursor', () => {
    const cur: Cursor = {
      k: 'created_at',
      v: '2026-01-01T00:00:00.000Z',
      id: '0190d8a4-aaaa-7890-abcd-ef0123456789',
    };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('round-trips identified_name cursor', () => {
    const cur: Cursor = {
      k: 'identified_name',
      v: 'Coquelicot',
      id: '0190d8a4-bbbb-7890-abcd-ef0123456789',
    };
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it('encodes to a url-safe base64 string', () => {
    const out = encodeCursor({
      k: 'collected_at',
      v: '2026-06-07T10:00:00.000Z',
      id: '0190d8a4-1234-7890-abcd-ef0123456789',
    });
    expect(out).toMatch(/^[A-Za-z0-9_-]+=*$/);
  });

  it('decodeCursor returns null for null / undefined / empty', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('decodeCursor returns null for non-base64 garbage', () => {
    expect(decodeCursor('not base64 !!!')).toBeNull();
  });

  it('decodeCursor returns null for base64-but-not-JSON', () => {
    expect(decodeCursor(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('decodeCursor returns null when shape is invalid', () => {
    const broken = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    expect(decodeCursor(broken)).toBeNull();
  });

  it('decodeCursor returns null when k is unknown', () => {
    const bad = Buffer.from(
      JSON.stringify({ k: 'unknown_column', v: 'x', id: 'y' }),
    ).toString('base64');
    expect(decodeCursor(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/utils/cursor.test.ts`
Expected: FAIL with "Cannot find module '@/utils/cursor'"

- [ ] **Step 3: Implement cursor.ts**

Create `src/utils/cursor.ts`:

```ts
export type CursorKey = 'collected_at' | 'created_at' | 'identified_name';

export type Cursor = {
  k: CursorKey;
  v: string;
  id: string;
};

const KEYS: CursorKey[] = ['collected_at', 'created_at', 'identified_name'];

export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  let json: string;
  try {
    json = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.k !== 'string' || typeof obj.v !== 'string' || typeof obj.id !== 'string') {
    return null;
  }
  if (!KEYS.includes(obj.k as CursorKey)) return null;
  return { k: obj.k as CursorKey, v: obj.v, id: obj.id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/utils/cursor.test.ts`
Expected: PASS (9/9)

- [ ] **Step 5: Format + commit**

```bash
nix develop --command biome check --write .
git add src/utils/cursor.ts tests/unit/utils/cursor.test.ts
git commit -m "feat(lot-6): cursor utility for composite pagination"
```

---

### Task 2: Zod schemas for create/patch/list

**Files:**
- Create: `src/schemas/specimens.ts`
- Test: `tests/unit/schemas/specimens.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/schemas/specimens.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  CreateSpecimenSchema,
  ListSpecimensQuerySchema,
  PatchSpecimenSchema,
} from '@/schemas/specimens';

const validId = '0190d8a4-1234-7890-abcd-ef0123456789';

describe('CreateSpecimenSchema', () => {
  it('accepts minimal valid body (plantnet_auto)', () => {
    const out = CreateSpecimenSchema.safeParse({
      id: validId,
      identification_id: validId,
      chosen_species_id: validId,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
    });
    expect(out.success).toBe(true);
  });

  it('accepts plantnet_picked source', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_picked',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('rejects identification_source = none (Lot 6 online only)', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'none',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const out = CreateSpecimenSchema.safeParse({
      id: validId,
      identification_id: validId,
      chosen_species_id: validId,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
      species_id: validId,
    });
    expect(out.success).toBe(false);
  });

  it('accepts optional lat/lng/location_label/user_notes', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        lat: 48.8566,
        lng: 2.3522,
        location_label: 'Jardin du Luxembourg',
        user_notes: 'au pied du chêne',
      }).success,
    ).toBe(true);
  });

  it('rejects lat out of range', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        lat: 95,
      }).success,
    ).toBe(false);
  });

  it('rejects user_notes > 2000 chars', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        user_notes: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('rejects invalid uuid for id', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: 'not-a-uuid',
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid collected_at', () => {
    expect(
      CreateSpecimenSchema.safeParse({
        id: validId,
        identification_id: validId,
        chosen_species_id: validId,
        identification_source: 'plantnet_auto',
        collected_at: 'not a date',
      }).success,
    ).toBe(false);
  });
});

describe('PatchSpecimenSchema', () => {
  it('accepts user_notes string', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: 'hi' }).success).toBe(true);
  });

  it('accepts user_notes null (clear)', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: null }).success).toBe(true);
  });

  it('accepts location_label string', () => {
    expect(PatchSpecimenSchema.safeParse({ location_label: 'Paris' }).success).toBe(true);
  });

  it('accepts both fields together', () => {
    expect(
      PatchSpecimenSchema.safeParse({ user_notes: 'x', location_label: null }).success,
    ).toBe(true);
  });

  it('rejects empty body', () => {
    expect(PatchSpecimenSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty string user_notes', () => {
    expect(PatchSpecimenSchema.safeParse({ user_notes: '' }).success).toBe(false);
  });

  it('rejects empty string location_label', () => {
    expect(PatchSpecimenSchema.safeParse({ location_label: '' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      PatchSpecimenSchema.safeParse({ user_notes: 'x', identified_name: 'X' }).success,
    ).toBe(false);
  });
});

describe('ListSpecimensQuerySchema', () => {
  it('uses defaults when empty', () => {
    const out = ListSpecimensQuerySchema.parse({});
    expect(out.limit).toBe(20);
    expect(out.sort).toBe('collected_at_desc');
    expect(out.cursor).toBeUndefined();
  });

  it('coerces limit from string', () => {
    expect(ListSpecimensQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('clamps limit to [1, 100]', () => {
    expect(ListSpecimensQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListSpecimensQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('accepts all sort values', () => {
    for (const s of ['collected_at_desc', 'created_at_desc', 'name_asc']) {
      expect(ListSpecimensQuerySchema.safeParse({ sort: s }).success).toBe(true);
    }
  });

  it('rejects unknown sort', () => {
    expect(ListSpecimensQuerySchema.safeParse({ sort: 'random' }).success).toBe(false);
  });

  it('accepts ISO date_from / date_to and parses them', () => {
    const out = ListSpecimensQuerySchema.parse({
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    });
    expect(out.date_from).toBeInstanceOf(Date);
    expect(out.date_to).toBeInstanceOf(Date);
  });

  it('rejects invalid dates', () => {
    expect(ListSpecimensQuerySchema.safeParse({ date_from: 'tomorrow' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/schemas/specimens.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement schemas**

Create `src/schemas/specimens.ts`:

```ts
import { z } from 'zod';

const uuid = z.string().uuid();

const isoTimestamp = z.string().transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'must be a valid ISO-8601 timestamp' });
    return z.NEVER;
  }
  return d;
});

const isoDate = z.string().transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'must be a valid ISO date' });
    return z.NEVER;
  }
  return d;
});

export const CreateSpecimenSchema = z
  .object({
    id: uuid,
    identification_id: uuid,
    chosen_species_id: uuid,
    identification_source: z.enum(['plantnet_auto', 'plantnet_picked']),
    collected_at: isoTimestamp,
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    location_label: z.string().min(1).max(256).optional(),
    user_notes: z.string().min(1).max(2000).optional(),
  })
  .strict();

export type CreateSpecimenInput = z.infer<typeof CreateSpecimenSchema>;

export const PatchSpecimenSchema = z
  .object({
    user_notes: z.union([z.string().min(1).max(2000), z.null()]).optional(),
    location_label: z.union([z.string().min(1).max(256), z.null()]).optional(),
  })
  .strict()
  .refine((v) => v.user_notes !== undefined || v.location_label !== undefined, {
    message: 'at least one of user_notes / location_label is required',
  });

export type PatchSpecimenInput = z.infer<typeof PatchSpecimenSchema>;

const limitFromQuery = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return 20;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      ctx.addIssue({ code: 'custom', message: 'limit must be an integer in [1, 100]' });
      return z.NEVER;
    }
    return n;
  });

export const ListSpecimensQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: limitFromQuery,
  sort: z.enum(['collected_at_desc', 'created_at_desc', 'name_asc']).default('collected_at_desc'),
  q: z.string().min(1).max(100).optional(),
  family: z.string().min(1).max(100).optional(),
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
});

export type ListSpecimensQuery = z.infer<typeof ListSpecimensQuerySchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/schemas/specimens.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Format + commit**

```bash
nix develop --command biome check --write .
git add src/schemas/specimens.ts tests/unit/schemas/specimens.test.ts
git commit -m "feat(lot-6): Zod schemas for specimens create/patch/list"
```

---

### Task 3: Service skeleton + `toSpecimenResponse` + `getById` + `softDelete` + `stats`

**Files:**
- Create: `src/services/specimens.ts`
- Test: `tests/unit/services/specimens.test.ts`

These three read paths share zero state. Implementing them together keeps the test setup helper DRY.

- [ ] **Step 1: Write the failing tests (read paths only)**

Create `tests/unit/services/specimens.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens, species, users } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import * as service from '@/services/specimens';
import type { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

const restores: Array<() => void> = [];

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
  restores.length = 0;
  restores.push(
    __setGarageForTests({
      getPresignedUrl: async ({ key }) => `https://garage.test/${key}?sig=stub`,
    }),
  );
});
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

async function makeUser(): Promise<string> {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'U' });
  return id;
}

async function makeSpecies(scientific = 'Papaver rhoeas'): Promise<string> {
  const id = uuid7();
  await testDb
    .insert(species)
    .values({ id, scientificName: scientific, commonName: 'Coquelicot', family: 'Papaveraceae' });
  return id;
}

async function makeIdentification(userId: string, opts: { speciesId: string; confidence: number }) {
  const id = uuid7();
  const raw = {
    results: [
      { species: { scientificNameWithoutAuthor: 'Papaver rhoeas' }, score: opts.confidence },
    ],
  };
  await testDb.insert(identifications).values({
    id,
    userId,
    photoUrl: `${userId}/${id}.jpg`,
    photoStatus: 'temp',
    plantnetRawResponse: raw,
    topMatchSpeciesId: opts.speciesId,
    topMatchConfidence: opts.confidence.toFixed(4),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return id;
}

async function makeSpecimen(userId: string, opts: { speciesId?: string; deleted?: boolean } = {}) {
  const id = uuid7();
  await testDb.insert(specimens).values({
    id,
    userId,
    photoUrl: `${userId}/${id}.jpg`,
    speciesId: opts.speciesId ?? null,
    identifiedName: 'Coquelicot',
    scientificName: 'Papaver rhoeas',
    family: 'Papaveraceae',
    confidenceScore: '0.9000',
    identificationSource: 'plantnet_auto',
    collectedAt: new Date(),
    deletedAt: opts.deleted ? new Date() : null,
  });
  return id;
}

describe('service.getById', () => {
  it('returns 404 when specimen does not exist', async () => {
    const uid = await makeUser();
    try {
      await service.getById(uid, uuid7());
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as AppError).status).toBe(404);
      expect((e as AppError).code).toBe('SPECIMEN_NOT_FOUND');
    }
  });

  it('returns 404 when specimen belongs to another user', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sid = await makeSpecimen(u1);
    try {
      await service.getById(u2, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns 404 when specimen is soft-deleted', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid, { deleted: true });
    try {
      await service.getById(uid, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns specimen with presigned photo_url and snake_case fields', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    const out = await service.getById(uid, sid);
    expect(out.id).toBe(sid);
    expect(out.photo_url).toContain('?sig=stub');
    expect(out.scientific_name).toBe('Papaver rhoeas');
    expect(out.identification_source).toBe('plantnet_auto');
    expect(out.confidence_score).toBe(0.9);
  });
});

describe('service.softDelete', () => {
  it('returns 404 when specimen does not exist', async () => {
    const uid = await makeUser();
    try {
      await service.softDelete(uid, uuid7());
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns 404 when specimen belongs to another user', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sid = await makeSpecimen(u1);
    try {
      await service.softDelete(u2, sid);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('marks specimen as deleted', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    await service.softDelete(uid, sid);
    const [row] = await testDb.select().from(specimens).where(eq(specimens.id, sid));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('is idempotent on already-soft-deleted specimens', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid, { deleted: true });
    await service.softDelete(uid, sid); // must not throw
    const [row] = await testDb.select().from(specimens).where(eq(specimens.id, sid));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('service.stats', () => {
  it('returns zeros when user has no specimens', async () => {
    const uid = await makeUser();
    const out = await service.stats(uid);
    expect(out).toEqual({ total: 0, distinct_species: 0 });
  });

  it('counts active specimens and distinct species, ignores soft-deleted', async () => {
    const uid = await makeUser();
    const sp1 = await makeSpecies('Papaver rhoeas');
    const sp2 = await makeSpecies('Bellis perennis');
    await makeSpecimen(uid, { speciesId: sp1 });
    await makeSpecimen(uid, { speciesId: sp1 });
    await makeSpecimen(uid, { speciesId: sp2 });
    await makeSpecimen(uid, { speciesId: sp2, deleted: true });

    const out = await service.stats(uid);
    expect(out.total).toBe(3);
    expect(out.distinct_species).toBe(2);
  });

  it('scopes counts to the user', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sp = await makeSpecies();
    await makeSpecimen(u1, { speciesId: sp });
    await makeSpecimen(u1, { speciesId: sp });
    await makeSpecimen(u2, { speciesId: sp });

    expect((await service.stats(u1)).total).toBe(2);
    expect((await service.stats(u2)).total).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts`
Expected: FAIL with "Cannot find module '@/services/specimens'"

- [ ] **Step 3: Implement service skeleton + 3 functions**

Create `src/services/specimens.ts`:

```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import { SPECIMENS_BUCKET } from '@/config/constants';
import { db } from '@/db/client';
import { type Specimen, specimens } from '@/db/schema';
import { getPresignedUrl } from '@/lib/garage';
import { AppError } from '@/utils/errors';

const PHOTO_URL_TTL_SECONDS = 3600;

export type SpecimenResponse = {
  id: string;
  identification_id: string | null;
  species_id: string | null;
  photo_url: string;
  identified_name: string | null;
  scientific_name: string | null;
  family: string | null;
  confidence_score: number | null;
  identification_source: 'plantnet_auto' | 'plantnet_picked' | 'none';
  lat: number | null;
  lng: number | null;
  location_label: string | null;
  user_notes: string | null;
  collected_at: string;
  created_at: string;
  updated_at: string;
};

export type StatsResult = {
  total: number;
  distinct_species: number;
};

async function toSpecimenResponse(s: Specimen): Promise<SpecimenResponse> {
  const photo_url = await getPresignedUrl({
    bucket: SPECIMENS_BUCKET,
    key: s.photoUrl,
    expiresInSeconds: PHOTO_URL_TTL_SECONDS,
  });
  return {
    id: s.id,
    identification_id: s.identificationId,
    species_id: s.speciesId,
    photo_url,
    identified_name: s.identifiedName,
    scientific_name: s.scientificName,
    family: s.family,
    confidence_score: s.confidenceScore === null ? null : Number(s.confidenceScore),
    identification_source: s.identificationSource,
    lat: s.lat === null ? null : Number(s.lat),
    lng: s.lng === null ? null : Number(s.lng),
    location_label: s.locationLabel,
    user_notes: s.userNotes,
    collected_at: s.collectedAt.toISOString(),
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

export async function getById(userId: string, id: string): Promise<SpecimenResponse> {
  const [row] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!row) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return toSpecimenResponse(row);
}

export async function softDelete(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select({ id: specimens.id, deletedAt: specimens.deletedAt })
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId)));
  if (!row) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  if (row.deletedAt !== null) return; // idempotent
  await db
    .update(specimens)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(specimens.id, id));
}

export async function stats(userId: string): Promise<StatsResult> {
  const rows = await db.execute<{ total: string; distinct_species: string }>(sql`
    SELECT
      COUNT(*)::text AS total,
      COUNT(DISTINCT species_id) FILTER (WHERE species_id IS NOT NULL)::text AS distinct_species
    FROM specimens
    WHERE user_id = ${userId} AND deleted_at IS NULL
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    distinct_species: Number(row?.distinct_species ?? 0),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts`
Expected: PASS for `getById`, `softDelete`, `stats` blocks (other blocks still missing — that's fine, they fail because the functions don't exist yet, not because tests are wrong)

- [ ] **Step 5: Format + commit**

```bash
nix develop --command biome check --write .
git add src/services/specimens.ts tests/unit/services/specimens.test.ts
git commit -m "feat(lot-6): specimens service skeleton + getById/softDelete/stats"
```

---

### Task 4: Service — `patch`

**Files:**
- Modify: `src/services/specimens.ts`
- Modify: `tests/unit/services/specimens.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append to existing file)**

Append to `tests/unit/services/specimens.test.ts` (before the last closing brace):

```ts
describe('service.patch', () => {
  it('returns 404 when specimen does not exist', async () => {
    const uid = await makeUser();
    try {
      await service.patch(uid, uuid7(), { user_notes: 'x' });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns 404 when specimen belongs to another user', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    const sid = await makeSpecimen(u1);
    try {
      await service.patch(u2, sid, { user_notes: 'x' });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(404);
    }
  });

  it('updates user_notes when provided', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    const out = await service.patch(uid, sid, { user_notes: 'hello world' });
    expect(out.user_notes).toBe('hello world');
  });

  it('clears user_notes when null', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    await service.patch(uid, sid, { user_notes: 'first' });
    const out = await service.patch(uid, sid, { user_notes: null });
    expect(out.user_notes).toBeNull();
  });

  it('does not touch fields that are not provided', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    await service.patch(uid, sid, { user_notes: 'kept' });
    const out = await service.patch(uid, sid, { location_label: 'Paris' });
    expect(out.user_notes).toBe('kept');
    expect(out.location_label).toBe('Paris');
  });

  it('bumps updated_at', async () => {
    const uid = await makeUser();
    const sid = await makeSpecimen(uid);
    const before = await service.getById(uid, sid);
    await new Promise((r) => setTimeout(r, 5));
    const after = await service.patch(uid, sid, { user_notes: 'x' });
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t patch`
Expected: FAIL with "service.patch is not a function" (or similar)

- [ ] **Step 3: Implement `patch`**

Append to `src/services/specimens.ts` (after `softDelete`):

```ts
export type PatchInput = {
  user_notes?: string | null;
  location_label?: string | null;
};

export async function patch(
  userId: string,
  id: string,
  input: PatchInput,
): Promise<SpecimenResponse> {
  const [existing] = await db
    .select()
    .from(specimens)
    .where(and(eq(specimens.id, id), eq(specimens.userId, userId), isNull(specimens.deletedAt)));
  if (!existing) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }

  const patchFields: { userNotes?: string | null; locationLabel?: string | null } = {};
  if (input.user_notes !== undefined) patchFields.userNotes = input.user_notes;
  if (input.location_label !== undefined) patchFields.locationLabel = input.location_label;

  const [updated] = await db
    .update(specimens)
    .set({ ...patchFields, updatedAt: new Date() })
    .where(eq(specimens.id, id))
    .returning();
  if (!updated) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return toSpecimenResponse(updated);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t patch`
Expected: PASS (6/6)

- [ ] **Step 5: Format + commit**

```bash
nix develop --command biome check --write .
git add src/services/specimens.ts tests/unit/services/specimens.test.ts
git commit -m "feat(lot-6): service.patch for user_notes/location_label"
```

---

### Task 5: Service — `list` with cursor + filters + sort

**Files:**
- Modify: `src/services/specimens.ts`
- Modify: `tests/unit/services/specimens.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append)**

Append to `tests/unit/services/specimens.test.ts`:

```ts
async function makeSpecimenAt(
  userId: string,
  opts: {
    collectedAt: Date;
    identifiedName?: string | null;
    family?: string | null;
    speciesId?: string;
  },
): Promise<string> {
  const id = uuid7();
  await testDb.insert(specimens).values({
    id,
    userId,
    photoUrl: `${userId}/${id}.jpg`,
    speciesId: opts.speciesId ?? null,
    identifiedName: opts.identifiedName ?? 'Coquelicot',
    scientificName: 'Papaver rhoeas',
    family: opts.family ?? 'Papaveraceae',
    confidenceScore: '0.9000',
    identificationSource: 'plantnet_auto',
    collectedAt: opts.collectedAt,
  });
  return id;
}

describe('service.list', () => {
  it('returns empty list when user has no specimens', async () => {
    const uid = await makeUser();
    const out = await service.list(uid, {
      limit: 20,
      sort: 'collected_at_desc',
    });
    expect(out.data).toEqual([]);
    expect(out.next_cursor).toBeNull();
  });

  it('scopes to the user', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeSpecimen(u1);
    await makeSpecimen(u2);
    const out = await service.list(u1, { limit: 20, sort: 'collected_at_desc' });
    expect(out.data).toHaveLength(1);
  });

  it('excludes soft-deleted specimens', async () => {
    const uid = await makeUser();
    await makeSpecimen(uid);
    await makeSpecimen(uid, { deleted: true });
    const out = await service.list(uid, { limit: 20, sort: 'collected_at_desc' });
    expect(out.data).toHaveLength(1);
  });

  it('sorts by collected_at DESC and paginates with composite cursor', async () => {
    const uid = await makeUser();
    const a = await makeSpecimenAt(uid, { collectedAt: new Date('2026-01-01') });
    const b = await makeSpecimenAt(uid, { collectedAt: new Date('2026-02-01') });
    const c = await makeSpecimenAt(uid, { collectedAt: new Date('2026-03-01') });

    const page1 = await service.list(uid, { limit: 2, sort: 'collected_at_desc' });
    expect(page1.data.map((s) => s.id)).toEqual([c, b]);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await service.list(uid, {
      limit: 2,
      sort: 'collected_at_desc',
      cursor: page1.next_cursor ?? undefined,
    });
    expect(page2.data.map((s) => s.id)).toEqual([a]);
    expect(page2.next_cursor).toBeNull();
  });

  it('uses id as tiebreaker when collected_at is identical', async () => {
    const uid = await makeUser();
    const sameDate = new Date('2026-06-01');
    const a = await makeSpecimenAt(uid, { collectedAt: sameDate });
    const b = await makeSpecimenAt(uid, { collectedAt: sameDate });

    const page1 = await service.list(uid, { limit: 1, sort: 'collected_at_desc' });
    expect(page1.data).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await service.list(uid, {
      limit: 1,
      sort: 'collected_at_desc',
      cursor: page1.next_cursor ?? undefined,
    });
    expect(page2.data).toHaveLength(1);
    expect(new Set([page1.data[0]?.id, page2.data[0]?.id])).toEqual(new Set([a, b]));
  });

  it('sorts by created_at_desc', async () => {
    const uid = await makeUser();
    const a = await makeSpecimen(uid);
    await new Promise((r) => setTimeout(r, 5));
    const b = await makeSpecimen(uid);
    const out = await service.list(uid, { limit: 20, sort: 'created_at_desc' });
    expect(out.data.map((s) => s.id)).toEqual([b, a]);
  });

  it('sorts by name_asc', async () => {
    const uid = await makeUser();
    await makeSpecimenAt(uid, { collectedAt: new Date(), identifiedName: 'Zinnia' });
    await makeSpecimenAt(uid, { collectedAt: new Date(), identifiedName: 'Anémone' });
    const out = await service.list(uid, { limit: 20, sort: 'name_asc' });
    expect(out.data.map((s) => s.identified_name)).toEqual(['Anémone', 'Zinnia']);
  });

  it('filters by q (ILIKE on identified_name)', async () => {
    const uid = await makeUser();
    await makeSpecimenAt(uid, { collectedAt: new Date(), identifiedName: 'Coquelicot' });
    await makeSpecimenAt(uid, { collectedAt: new Date(), identifiedName: 'Pâquerette' });
    const out = await service.list(uid, {
      limit: 20,
      sort: 'collected_at_desc',
      q: 'queli',
    });
    expect(out.data.map((s) => s.identified_name)).toEqual(['Coquelicot']);
  });

  it('filters by family (exact)', async () => {
    const uid = await makeUser();
    await makeSpecimenAt(uid, { collectedAt: new Date(), family: 'Papaveraceae' });
    await makeSpecimenAt(uid, { collectedAt: new Date(), family: 'Asteraceae' });
    const out = await service.list(uid, {
      limit: 20,
      sort: 'collected_at_desc',
      family: 'Asteraceae',
    });
    expect(out.data.map((s) => s.family)).toEqual(['Asteraceae']);
  });

  it('filters by date_from / date_to (inclusive)', async () => {
    const uid = await makeUser();
    await makeSpecimenAt(uid, { collectedAt: new Date('2026-01-15') });
    await makeSpecimenAt(uid, { collectedAt: new Date('2026-06-15') });
    await makeSpecimenAt(uid, { collectedAt: new Date('2026-12-15') });
    const out = await service.list(uid, {
      limit: 20,
      sort: 'collected_at_desc',
      date_from: new Date('2026-03-01'),
      date_to: new Date('2026-09-01'),
    });
    expect(out.data.map((s) => new Date(s.collected_at).getMonth())).toEqual([5]);
  });

  it('combines filters in AND', async () => {
    const uid = await makeUser();
    await makeSpecimenAt(uid, {
      collectedAt: new Date('2026-06-15'),
      family: 'Asteraceae',
      identifiedName: 'Pâquerette',
    });
    await makeSpecimenAt(uid, {
      collectedAt: new Date('2026-06-15'),
      family: 'Papaveraceae',
      identifiedName: 'Coquelicot',
    });
    const out = await service.list(uid, {
      limit: 20,
      sort: 'collected_at_desc',
      family: 'Asteraceae',
      q: 'querette',
    });
    expect(out.data).toHaveLength(1);
    expect(out.data[0]?.identified_name).toBe('Pâquerette');
  });

  it('throws AppError(INVALID_CURSOR, 400) for malformed cursor', async () => {
    const uid = await makeUser();
    try {
      await service.list(uid, { limit: 20, sort: 'collected_at_desc', cursor: 'not-base64-!' });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).code).toBe('INVALID_CURSOR');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t list`
Expected: FAIL with "service.list is not a function"

- [ ] **Step 3: Implement `list`**

Append to `src/services/specimens.ts`:

```ts
import { asc, desc, gt, gte, ilike, lt, lte, or } from 'drizzle-orm';
// merge with existing drizzle-orm import line

import { type Cursor, decodeCursor, encodeCursor } from '@/utils/cursor';
// add to imports

export type ListParams = {
  cursor?: string;
  limit: number;
  sort: 'collected_at_desc' | 'created_at_desc' | 'name_asc';
  q?: string;
  family?: string;
  date_from?: Date;
  date_to?: Date;
};

export type ListResult = {
  data: SpecimenResponse[];
  next_cursor: string | null;
};

export async function list(userId: string, params: ListParams): Promise<ListResult> {
  let parsedCursor: Cursor | null = null;
  if (params.cursor) {
    parsedCursor = decodeCursor(params.cursor);
    if (!parsedCursor) {
      throw new AppError('INVALID_CURSOR', 'Cursor is malformed', 400);
    }
  }

  const baseFilters = [eq(specimens.userId, userId), isNull(specimens.deletedAt)];
  if (params.q) baseFilters.push(ilike(specimens.identifiedName, `%${params.q}%`));
  if (params.family) baseFilters.push(eq(specimens.family, params.family));
  if (params.date_from) baseFilters.push(gte(specimens.collectedAt, params.date_from));
  if (params.date_to) baseFilters.push(lte(specimens.collectedAt, params.date_to));

  const cursorPredicate = (cur: Cursor) => {
    switch (cur.k) {
      case 'collected_at':
        return or(
          lt(specimens.collectedAt, new Date(cur.v)),
          and(eq(specimens.collectedAt, new Date(cur.v)), lt(specimens.id, cur.id)),
        );
      case 'created_at':
        return or(
          lt(specimens.createdAt, new Date(cur.v)),
          and(eq(specimens.createdAt, new Date(cur.v)), lt(specimens.id, cur.id)),
        );
      case 'identified_name':
        return or(
          gt(specimens.identifiedName, cur.v),
          and(eq(specimens.identifiedName, cur.v), gt(specimens.id, cur.id)),
        );
    }
  };

  const orderBy = (() => {
    switch (params.sort) {
      case 'collected_at_desc':
        return [desc(specimens.collectedAt), desc(specimens.id)];
      case 'created_at_desc':
        return [desc(specimens.createdAt), desc(specimens.id)];
      case 'name_asc':
        return [sql`${specimens.identifiedName} ASC NULLS LAST`, asc(specimens.id)];
    }
  })();

  const conditions = parsedCursor
    ? [...baseFilters, cursorPredicate(parsedCursor)]
    : baseFilters;

  const rows = await db
    .select()
    .from(specimens)
    .where(and(...conditions))
    .orderBy(...orderBy)
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const trimmed = hasMore ? rows.slice(0, params.limit) : rows;
  const data = await Promise.all(trimmed.map(toSpecimenResponse));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = trimmed[trimmed.length - 1];
    if (last) {
      switch (params.sort) {
        case 'collected_at_desc':
          nextCursor = encodeCursor({
            k: 'collected_at',
            v: last.collectedAt.toISOString(),
            id: last.id,
          });
          break;
        case 'created_at_desc':
          nextCursor = encodeCursor({
            k: 'created_at',
            v: last.createdAt.toISOString(),
            id: last.id,
          });
          break;
        case 'name_asc':
          if (last.identifiedName === null) {
            // NULL rows are not cursor-paginable in MVP — clamp.
            nextCursor = null;
          } else {
            nextCursor = encodeCursor({
              k: 'identified_name',
              v: last.identifiedName,
              id: last.id,
            });
          }
          break;
      }
    }
  }

  return { data, next_cursor: nextCursor };
}
```

Note: the new imports from `drizzle-orm` (`asc`, `desc`, `gt`, `ilike`, `lt`, `or`) must be merged with the existing top-of-file import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t list`
Expected: PASS (12/12)

- [ ] **Step 5: Format + commit**

```bash
nix develop --command biome check --write .
git add src/services/specimens.ts tests/unit/services/specimens.test.ts
git commit -m "feat(lot-6): service.list with composite cursor + filters + sort"
```

---

### Task 6: Service — `create` (idempotence, validations, transaction)

**Files:**
- Modify: `src/services/specimens.ts`
- Modify: `tests/unit/services/specimens.test.ts` (append)

This is the most complex task. Tests cover all 7 error paths + 2 happy paths.

- [ ] **Step 1: Write the failing tests (append)**

Append to `tests/unit/services/specimens.test.ts`:

```ts
describe('service.create', () => {
  async function setup() {
    const uid = await makeUser();
    const sp = await makeSpecies('Papaver rhoeas');
    const sp2 = await makeSpecies('Bellis perennis');
    const idn = await makeIdentification(uid, { speciesId: sp, confidence: 0.95 });
    return { uid, sp, sp2, idn };
  }

  it('returns 201-like wasCreated=true on happy path (plantnet_auto, high confidence)', async () => {
    const { uid, sp, idn } = await setup();
    const sid = uuid7();
    const out = await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: sp,
      identification_source: 'plantnet_auto',
      collected_at: new Date('2026-06-07T10:00:00Z'),
    });
    expect(out.wasCreated).toBe(true);
    expect(out.specimen.id).toBe(sid);
    expect(out.specimen.identification_id).toBe(idn);
    expect(out.specimen.species_id).toBe(sp);
    expect(out.specimen.identification_source).toBe('plantnet_auto');
    expect(out.specimen.scientific_name).toBe('Papaver rhoeas');
    expect(out.specimen.identified_name).toBe('Coquelicot');
    expect(out.specimen.family).toBe('Papaveraceae');
    expect(out.specimen.confidence_score).toBe(0.95);
    expect(out.specimen.photo_url).toContain('?sig=stub');

    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, idn));
    expect(ident?.photoStatus).toBe('promoted');
    expect(ident?.promotedAt).toBeInstanceOf(Date);
  });

  it('reuses the identification photo key (no S3 copy)', async () => {
    const { uid, sp, idn } = await setup();
    const sid = uuid7();
    await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: sp,
      identification_source: 'plantnet_auto',
      collected_at: new Date(),
    });
    const [spec] = await testDb.select().from(specimens).where(eq(specimens.id, sid));
    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, idn));
    expect(spec?.photoUrl).toBe(ident?.photoUrl);
  });

  it('happy path plantnet_picked (low confidence, alternative chosen)', async () => {
    const uid = await makeUser();
    const sp = await makeSpecies('Papaver rhoeas');
    const spAlt = await makeSpecies('Bellis perennis');
    const idn = uuid7();
    await testDb.insert(identifications).values({
      id: idn,
      userId: uid,
      photoUrl: `${uid}/${idn}.jpg`,
      photoStatus: 'temp',
      plantnetRawResponse: {
        results: [
          { species: { scientificNameWithoutAuthor: 'Papaver rhoeas' }, score: 0.4 },
          { species: { scientificNameWithoutAuthor: 'Bellis perennis' }, score: 0.3 },
        ],
      },
      topMatchSpeciesId: sp,
      topMatchConfidence: '0.4000',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const sid = uuid7();
    const out = await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: spAlt,
      identification_source: 'plantnet_picked',
      collected_at: new Date(),
    });
    expect(out.wasCreated).toBe(true);
    expect(out.specimen.species_id).toBe(spAlt);
    expect(out.specimen.scientific_name).toBe('Bellis perennis');
    expect(out.specimen.confidence_score).toBe(0.3);
    expect(out.specimen.identification_source).toBe('plantnet_picked');
  });

  it('idempotent: replay with same id returns wasCreated=false + existing specimen', async () => {
    const { uid, sp, idn } = await setup();
    const sid = uuid7();
    const first = await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: sp,
      identification_source: 'plantnet_auto',
      collected_at: new Date(),
    });
    const second = await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: sp,
      identification_source: 'plantnet_auto',
      collected_at: new Date('2099-01-01'),
    });
    expect(second.wasCreated).toBe(false);
    expect(second.specimen.id).toBe(sid);
    expect(second.specimen.collected_at).toBe(first.specimen.collected_at);
  });

  it('returns 409 ID_CONFLICT when id exists for another user', async () => {
    const { uid, sp, idn } = await setup();
    const sid = uuid7();
    await service.create(uid, {
      id: sid,
      identification_id: idn,
      chosen_species_id: sp,
      identification_source: 'plantnet_auto',
      collected_at: new Date(),
    });

    const u2 = await makeUser();
    const sp2 = await makeSpecies('Bellis perennis');
    const idn2 = await makeIdentification(u2, { speciesId: sp2, confidence: 0.95 });
    try {
      await service.create(u2, {
        id: sid,
        identification_id: idn2,
        chosen_species_id: sp2,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe('ID_CONFLICT');
    }
  });

  it('returns 404 IDENTIFICATION_NOT_FOUND when identification belongs to other user', async () => {
    const { sp, idn } = await setup();
    const u2 = await makeUser();
    try {
      await service.create(u2, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: sp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('IDENTIFICATION_NOT_FOUND');
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns 404 IDENTIFICATION_NOT_FOUND when identification missing', async () => {
    const uid = await makeUser();
    const sp = await makeSpecies();
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: uuid7(),
        chosen_species_id: sp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('IDENTIFICATION_NOT_FOUND');
    }
  });

  it('returns 409 ALREADY_PROMOTED when identification already promoted', async () => {
    const { uid, sp, idn } = await setup();
    await testDb
      .update(identifications)
      .set({ photoStatus: 'promoted', promotedAt: new Date() })
      .where(eq(identifications.id, idn));
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: sp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('ALREADY_PROMOTED');
      expect((e as AppError).status).toBe(409);
    }
  });

  it('returns 410 IDENTIFICATION_EXPIRED when expires_at <= now()', async () => {
    const { uid, sp, idn } = await setup();
    await testDb
      .update(identifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(identifications.id, idn));
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: sp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('IDENTIFICATION_EXPIRED');
      expect((e as AppError).status).toBe(410);
    }
  });

  it('returns 400 INVALID_CHOICE when chosen_species_id not in pool', async () => {
    const { uid, idn } = await setup();
    const foreignSp = await makeSpecies('Random species');
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: foreignSp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_CHOICE');
      expect((e as AppError).status).toBe(400);
    }
  });

  it('returns 400 THRESHOLD_VIOLATED when high confidence + plantnet_picked', async () => {
    const { uid, sp, idn } = await setup();
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: sp,
        identification_source: 'plantnet_picked',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('THRESHOLD_VIOLATED');
    }
  });

  it('returns 400 THRESHOLD_VIOLATED when high confidence + chosen != top', async () => {
    const uid = await makeUser();
    const sp = await makeSpecies('Papaver rhoeas');
    const spAlt = await makeSpecies('Bellis perennis');
    const idn = uuid7();
    await testDb.insert(identifications).values({
      id: idn,
      userId: uid,
      photoUrl: `${uid}/${idn}.jpg`,
      photoStatus: 'temp',
      plantnetRawResponse: {
        results: [
          { species: { scientificNameWithoutAuthor: 'Papaver rhoeas' }, score: 0.9 },
          { species: { scientificNameWithoutAuthor: 'Bellis perennis' }, score: 0.05 },
        ],
      },
      topMatchSpeciesId: sp,
      topMatchConfidence: '0.9000',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: spAlt,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('THRESHOLD_VIOLATED');
    }
  });

  it('returns 400 THRESHOLD_VIOLATED when low confidence + plantnet_auto', async () => {
    const uid = await makeUser();
    const sp = await makeSpecies('Papaver rhoeas');
    const idn = uuid7();
    await testDb.insert(identifications).values({
      id: idn,
      userId: uid,
      photoUrl: `${uid}/${idn}.jpg`,
      photoStatus: 'temp',
      plantnetRawResponse: {
        results: [{ species: { scientificNameWithoutAuthor: 'Papaver rhoeas' }, score: 0.3 }],
      },
      topMatchSpeciesId: sp,
      topMatchConfidence: '0.3000',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    try {
      await service.create(uid, {
        id: uuid7(),
        identification_id: idn,
        chosen_species_id: sp,
        identification_source: 'plantnet_auto',
        collected_at: new Date(),
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('THRESHOLD_VIOLATED');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t create`
Expected: FAIL with "service.create is not a function"

- [ ] **Step 3: Implement `create`**

Add to imports in `src/services/specimens.ts`:

```ts
import { inArray } from 'drizzle-orm';
// merge with existing drizzle-orm import

import { CONFIDENCE_THRESHOLD } from '@/config/constants';
import { identifications, species as speciesTable } from '@/db/schema';
import type { PlantnetRawResponse } from '@/lib/plantnet';
```

Append to `src/services/specimens.ts`:

```ts
export type CreateInput = {
  id: string;
  identification_id: string;
  chosen_species_id: string;
  identification_source: 'plantnet_auto' | 'plantnet_picked';
  collected_at: Date;
  lat?: number;
  lng?: number;
  location_label?: string;
  user_notes?: string;
};

export type CreateResult = {
  specimen: SpecimenResponse;
  wasCreated: boolean;
};

type RawResult = {
  species?: { scientificNameWithoutAuthor?: string };
  score?: number;
};

function pickRawResults(raw: PlantnetRawResponse): RawResult[] {
  const arr = (raw as { results?: unknown }).results;
  return Array.isArray(arr) ? (arr as RawResult[]) : [];
}

export async function create(userId: string, input: CreateInput): Promise<CreateResult> {
  // 1. Idempotence check
  const [existing] = await db.select().from(specimens).where(eq(specimens.id, input.id));
  if (existing) {
    if (existing.userId !== userId) {
      throw new AppError('ID_CONFLICT', `specimen id ${input.id} belongs to another user`, 409);
    }
    return { specimen: await toSpecimenResponse(existing), wasCreated: false };
  }

  // 2. Load identification
  const [ident] = await db
    .select()
    .from(identifications)
    .where(eq(identifications.id, input.identification_id));
  if (!ident || ident.userId !== userId) {
    throw new AppError(
      'IDENTIFICATION_NOT_FOUND',
      `identification ${input.identification_id} not found`,
      404,
    );
  }
  if (ident.photoStatus !== 'temp') {
    throw new AppError(
      'ALREADY_PROMOTED',
      `identification ${ident.id} has already been consumed`,
      409,
    );
  }
  if (ident.expiresAt && ident.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      'IDENTIFICATION_EXPIRED',
      `identification ${ident.id} has expired`,
      410,
    );
  }

  // 3. Build pool of candidates
  const rawResults = pickRawResults(ident.plantnetRawResponse);
  const scientificNames = rawResults
    .map((r) => r.species?.scientificNameWithoutAuthor)
    .filter((s): s is string => typeof s === 'string');
  if (scientificNames.length === 0) {
    throw new AppError('INVALID_CHOICE', 'identification has no candidate species', 400);
  }
  const pool = await db
    .select({ id: speciesTable.id, scientificName: speciesTable.scientificName })
    .from(speciesTable)
    .where(inArray(speciesTable.scientificName, scientificNames));
  const poolIds = new Set(pool.map((p) => p.id));
  if (!poolIds.has(input.chosen_species_id)) {
    throw new AppError(
      'INVALID_CHOICE',
      'chosen_species_id is not part of this identification candidates',
      400,
    );
  }

  // 4. Threshold rule
  const topConfidence = ident.topMatchConfidence === null ? 0 : Number(ident.topMatchConfidence);
  const isHigh = topConfidence >= CONFIDENCE_THRESHOLD;
  if (isHigh) {
    if (
      input.chosen_species_id !== ident.topMatchSpeciesId ||
      input.identification_source !== 'plantnet_auto'
    ) {
      throw new AppError(
        'THRESHOLD_VIOLATED',
        `confidence >= ${CONFIDENCE_THRESHOLD} requires auto-pick of the top match`,
        400,
      );
    }
  } else {
    if (input.identification_source !== 'plantnet_picked') {
      throw new AppError(
        'THRESHOLD_VIOLATED',
        `confidence < ${CONFIDENCE_THRESHOLD} requires plantnet_picked`,
        400,
      );
    }
  }

  // 5. Snapshot resolution
  const chosenPool = pool.find((p) => p.id === input.chosen_species_id);
  if (!chosenPool) throw new Error('unreachable: chosen verified above');
  const chosenIdx = rawResults.findIndex(
    (r) => r.species?.scientificNameWithoutAuthor === chosenPool.scientificName,
  );
  const chosenScore = chosenIdx >= 0 ? (rawResults[chosenIdx]?.score ?? null) : null;
  const [chosenSpeciesRow] = await db
    .select()
    .from(speciesTable)
    .where(eq(speciesTable.id, input.chosen_species_id));
  if (!chosenSpeciesRow) throw new Error('unreachable: species existed during pool select');

  // 6. Transactional insert + promote
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(specimens)
      .values({
        id: input.id,
        userId,
        identificationId: ident.id,
        speciesId: chosenSpeciesRow.id,
        photoUrl: ident.photoUrl,
        identifiedName: chosenSpeciesRow.commonName,
        scientificName: chosenSpeciesRow.scientificName,
        family: chosenSpeciesRow.family,
        confidenceScore: chosenScore === null ? null : chosenScore.toFixed(4),
        identificationSource: input.identification_source,
        lat: input.lat === undefined ? null : input.lat.toFixed(6),
        lng: input.lng === undefined ? null : input.lng.toFixed(6),
        locationLabel: input.location_label ?? null,
        userNotes: input.user_notes ?? null,
        collectedAt: input.collected_at,
      })
      .returning();
    if (!row) throw new Error('insert returned no row');

    await tx
      .update(identifications)
      .set({ photoStatus: 'promoted', promotedAt: new Date() })
      .where(eq(identifications.id, ident.id));

    return row;
  });

  return { specimen: await toSpecimenResponse(inserted), wasCreated: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts -t create`
Expected: PASS (all create cases)

- [ ] **Step 5: Run full service test suite**

Run: `nix develop --command bun test tests/unit/services/specimens.test.ts`
Expected: PASS (all blocks: getById, softDelete, stats, patch, list, create)

- [ ] **Step 6: Format + commit**

```bash
nix develop --command biome check --write .
git add src/services/specimens.ts tests/unit/services/specimens.test.ts
git commit -m "feat(lot-6): service.create with idempotence, validations, transactional promote"
```

---

### Task 7: Routes — mount 6 endpoints

**Files:**
- Create: `src/routes/specimens.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: Implement `routes/specimens.ts`**

Create `src/routes/specimens.ts`:

```ts
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import {
  CreateSpecimenSchema,
  ListSpecimensQuerySchema,
  PatchSpecimenSchema,
} from '@/schemas/specimens';
import * as service from '@/services/specimens';
import { AppError } from '@/utils/errors';

const route = new Hono<AppEnv>();

route.use('*', authMiddleware());

route.post('/specimens', zValidator('json', CreateSpecimenSchema), async (c) => {
  const user = requireUser(c);
  const body = c.req.valid('json');
  const out = await service.create(user.id, body);
  return c.json(out.specimen, out.wasCreated ? 201 : 200);
});

route.get('/specimens', zValidator('query', ListSpecimensQuerySchema), async (c) => {
  const user = requireUser(c);
  const params = c.req.valid('query');
  const out = await service.list(user.id, params);
  return c.json(out, 200);
});

// IMPORTANT: declare /stats BEFORE /:id so Hono does not match :id == 'stats'.
route.get('/specimens/stats', async (c) => {
  const user = requireUser(c);
  return c.json(await service.stats(user.id), 200);
});

route.get('/specimens/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return c.json(await service.getById(user.id, id), 200);
});

route.patch('/specimens/:id', zValidator('json', PatchSpecimenSchema), async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const body = c.req.valid('json');
  return c.json(await service.patch(user.id, id, body), 200);
});

route.delete('/specimens/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  await service.softDelete(user.id, id);
  return c.body(null, 204);
});

export default route;
```

- [ ] **Step 2: Mount in `src/routes/index.ts`**

Edit `src/routes/index.ts` to add the new route:

```ts
import { Hono } from 'hono';
import health from '@/routes/health';
import identifications from '@/routes/identifications';
import me from '@/routes/me';
import specimens from '@/routes/specimens';
import species from '@/routes/species';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
routes.route('/', species);
routes.route('/', specimens);
routes.route('/', identifications);
```

- [ ] **Step 3: Verify typecheck + lint pass**

Run: `nix develop --command bun run typecheck && nix develop --command bun run lint`
Expected: clean. If `noNonNullAssertion` complains, fix via destructuring (`const [row] = ...` then explicit null check).

- [ ] **Step 4: Commit**

```bash
nix develop --command biome check --write .
git add src/routes/specimens.ts src/routes/index.ts
git commit -m "feat(lot-6): mount specimens routes (POST/GET/PATCH/DELETE)"
```

---

### Task 8: Integration tests — end-to-end via `buildTestApp`

**Files:**
- Create: `tests/integration/specimens.test.ts`

- [ ] **Step 1: Write the integration test file**

Create `tests/integration/specimens.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens } from '@/db/schema';
import { flushPendingEnrichments } from '@/services/species-enrichment';
import { uuid7 } from '@/utils/uuid';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import {
  cleanupGarageObjects,
  setupTestGarage,
  setupTestSpecimens,
  TEST_SPECIMENS_BUCKET,
} from '../helpers/garage';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';
import { installMockPlantnet } from '../helpers/plantnet';
import { installMockWikipedia } from '../helpers/wikipedia';

const tinyJpeg = (): Blob => {
  const buf = new Uint8Array(64);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  return new Blob([buf], { type: 'image/jpeg' });
};

let mailer: MockMailerHandle;
let restores: Array<() => void> = [];
const createdKeys: Array<{ bucket: string; key: string }> = [];

beforeAll(async () => {
  await setupTestDb();
  await setupTestGarage();
  await setupTestSpecimens();
});
beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
  restores = [];
  createdKeys.length = 0;
  restores.push(installMockWikipedia({ summary: null }));
});
afterEach(async () => {
  mailer.restore();
  while (restores.length) restores.pop()?.();
  await cleanupGarageObjects(createdKeys);
});

async function makeUser(emailPrefix: string) {
  const app = buildTestApp();
  return signUpTestUser(app, {
    email: `${emailPrefix}@example.com`,
    password: 'correct-horse-battery-staple',
    name: emailPrefix,
  });
}

async function createIdentification(
  app: ReturnType<typeof buildTestApp>,
  token: string,
  opts: { highConfidence?: boolean } = {},
) {
  // Default mock returns Lycoris @ 0.9233 (auto-pickable). Override for low.
  if (opts.highConfidence === false) {
    restores.push(
      installMockPlantnet({
        results: [
          {
            scientificName: 'Myriophyllum alterniflorum',
            commonName: 'Myriophylle',
            family: 'Haloragaceae',
            referencePhotoUrl: null,
            score: 0.26,
          },
          {
            scientificName: 'Acer rubrum',
            commonName: 'Érable rouge',
            family: 'Sapindaceae',
            referencePhotoUrl: null,
            score: 0.07,
          },
        ],
      }),
    );
  } else {
    restores.push(installMockPlantnet());
  }

  const form = new FormData();
  form.append('photo', tinyJpeg(), 'flower.jpg');
  const res = await app.request('/v1/identifications', {
    method: 'POST',
    headers: bearerHeaders(token),
    body: form,
  });
  if (res.status !== 201) throw new Error(`identification failed: ${res.status}`);
  return (await res.json()) as {
    id: string;
    top_match: { species_id: string; scientific_name: string };
    alternatives: Array<{ species_id: string; scientific_name: string }>;
    auto_pickable: boolean;
  };
}

describe('POST /v1/specimens', () => {
  it('returns 401 without auth', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: uuid7(),
        chosen_species_id: uuid7(),
        identification_source: 'plantnet_auto',
        collected_at: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 201 happy plantnet_auto and promotes the identification', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-a');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
        lat: 48.8566,
        lng: 2.3522,
        location_label: 'Jardin du Luxembourg',
        user_notes: 'au pied du chêne',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      species_id: string;
      photo_url: string;
      identification_source: string;
      lat: number;
      lng: number;
      location_label: string;
      user_notes: string;
    };
    expect(body.id).toBe(sid);
    expect(body.species_id).toBe(ident.top_match.species_id);
    expect(body.photo_url).toContain('X-Amz-Signature=');
    expect(body.identification_source).toBe('plantnet_auto');
    expect(body.lat).toBe(48.8566);
    expect(body.location_label).toBe('Jardin du Luxembourg');

    const [identRow] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, ident.id));
    expect(identRow?.photoStatus).toBe('promoted');
    expect(identRow?.promotedAt).toBeInstanceOf(Date);

    const [specRow] = await testDb.select().from(specimens).where(eq(specimens.id, sid));
    expect(specRow?.photoUrl).toBe(identRow?.photoUrl);
    expect(specRow?.scientificName).toBe('Lycoris radiata');
  });

  it('returns 200 (no-op) when replaying same id same user', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-b');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    const body = {
      id: sid,
      identification_id: ident.id,
      chosen_species_id: ident.top_match.species_id,
      identification_source: 'plantnet_auto',
      collected_at: '2026-06-07T10:00:00Z',
    };
    const first = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, user_notes: 'ignored on replay' }),
    });
    expect(second.status).toBe(200);
    const out = (await second.json()) as { user_notes: string | null };
    expect(out.user_notes).toBeNull();
  });

  it('returns 409 ID_CONFLICT when id exists for another user', async () => {
    const app = buildTestApp();
    const u1 = await makeUser('sp-c1');
    const ident1 = await createIdentification(app, u1.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u1.userId}/${ident1.id}.jpg` });

    const sid = uuid7();
    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u1.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident1.id,
        chosen_species_id: ident1.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const u2 = await makeUser('sp-c2');
    const ident2 = await createIdentification(app, u2.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u2.userId}/${ident2.id}.jpg` });

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u2.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident2.id,
        chosen_species_id: ident2.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ID_CONFLICT');
  });

  it('returns 400 OFFLINE_SOURCE_NOT_ALLOWED for source=none (rejected at schema)', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-d');
    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: uuid7(),
        chosen_species_id: uuid7(),
        identification_source: 'none',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 THRESHOLD_VIOLATED when high confidence + plantnet_picked', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-e');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_picked',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('THRESHOLD_VIOLATED');
  });

  it('returns 400 INVALID_CHOICE when chosen_species_id not in pool', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-f');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: ident.id,
        chosen_species_id: uuid7(), // random uuid, not in pool
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CHOICE');
  });

  it('returns 410 IDENTIFICATION_EXPIRED', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-g');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    // Force expiry in DB
    await testDb
      .update(identifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(identifications.id, ident.id));

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDENTIFICATION_EXPIRED');
  });

  it('returns 409 ALREADY_PROMOTED when identification already consumed', async () => {
    const app = buildTestApp();
    const u = await makeUser('sp-h');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const res = await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(), // new specimen id
        identification_id: ident.id, // same already-promoted ident
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ALREADY_PROMOTED');
  });
});

describe('GET /v1/specimens/:id', () => {
  it('returns 401 without auth', async () => {
    const app = buildTestApp();
    const res = await app.request(`/v1/specimens/${uuid7()}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for cross-user access', async () => {
    const app = buildTestApp();
    const u1 = await makeUser('g-a');
    const ident = await createIdentification(app, u1.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u1.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u1.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const u2 = await makeUser('g-b');
    const res = await app.request(`/v1/specimens/${sid}`, {
      headers: bearerHeaders(u2.sessionToken),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/specimens (list)', () => {
  it('returns paginated specimens, sorted by collected_at desc by default', async () => {
    const app = buildTestApp();
    const u = await makeUser('list-a');

    // Create 3 specimens via the route
    const ids: string[] = [];
    for (const day of ['2026-01-15', '2026-06-15', '2026-12-15']) {
      const ident = await createIdentification(app, u.sessionToken);
      createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });
      const sid = uuid7();
      await app.request('/v1/specimens', {
        method: 'POST',
        headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: sid,
          identification_id: ident.id,
          chosen_species_id: ident.top_match.species_id,
          identification_source: 'plantnet_auto',
          collected_at: `${day}T10:00:00Z`,
        }),
      });
      ids.push(sid);
    }

    const page1 = await app.request('/v1/specimens?limit=2', {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(page1.status).toBe(200);
    const page1Body = (await page1.json()) as { data: Array<{ id: string }>; next_cursor: string };
    expect(page1Body.data.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    expect(page1Body.next_cursor).not.toBeNull();

    const page2 = await app.request(
      `/v1/specimens?limit=2&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
      { headers: bearerHeaders(u.sessionToken) },
    );
    const page2Body = (await page2.json()) as { data: Array<{ id: string }>; next_cursor: null };
    expect(page2Body.data.map((s) => s.id)).toEqual([ids[0]]);
    expect(page2Body.next_cursor).toBeNull();
  });

  it('rejects malformed cursor with 400 INVALID_CURSOR', async () => {
    const app = buildTestApp();
    const u = await makeUser('list-b');
    const res = await app.request('/v1/specimens?cursor=not-base64-!', {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /v1/specimens/stats', () => {
  it('returns total + distinct_species', async () => {
    const app = buildTestApp();
    const u = await makeUser('stats-a');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid7(),
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const res = await app.request('/v1/specimens/stats', {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; distinct_species: number };
    expect(body.total).toBe(1);
    expect(body.distinct_species).toBe(1);
  });
});

describe('PATCH /v1/specimens/:id', () => {
  it('updates user_notes', async () => {
    const app = buildTestApp();
    const u = await makeUser('patch-a');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const res = await app.request(`/v1/specimens/${sid}`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_notes: 'updated' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_notes: string };
    expect(body.user_notes).toBe('updated');
  });

  it('rejects empty body with 400', async () => {
    const app = buildTestApp();
    const u = await makeUser('patch-b');
    const res = await app.request(`/v1/specimens/${uuid7()}`, {
      method: 'PATCH',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/specimens/:id', () => {
  it('soft-deletes and subsequent GET returns 404', async () => {
    const app = buildTestApp();
    const u = await makeUser('del-a');
    const ident = await createIdentification(app, u.sessionToken);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${ident.id}.jpg` });

    const sid = uuid7();
    await app.request('/v1/specimens', {
      method: 'POST',
      headers: { ...bearerHeaders(u.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: sid,
        identification_id: ident.id,
        chosen_species_id: ident.top_match.species_id,
        identification_source: 'plantnet_auto',
        collected_at: '2026-06-07T10:00:00Z',
      }),
    });

    const del = await app.request(`/v1/specimens/${sid}`, {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    expect(del.status).toBe(204);

    const get = await app.request(`/v1/specimens/${sid}`, {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(get.status).toBe(404);

    // Idempotent
    const del2 = await app.request(`/v1/specimens/${sid}`, {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    // already soft-deleted — service returns void without error, but the row is
    // still scoped to the user, so we expect 204 again.
    expect(del2.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `nix develop --command bun test tests/integration/specimens.test.ts`
Expected: PASS (all)

- [ ] **Step 3: Run full suite**

Run: `nix develop --command bun test`
Expected: PASS for everything Lot 1-6.

- [ ] **Step 4: Typecheck + lint**

Run: `nix develop --command bun run typecheck && nix develop --command bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
nix develop --command biome check --write .
git add tests/integration/specimens.test.ts
git commit -m "test(lot-6): integration suite for specimens routes"
```

---

### Task 9: README Lot 6 quickstart

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read existing README quickstart sections**

Run: `grep -n "^## Lot" README.md`
Expected: existing Lot 3/4/5 sections at known offsets.

- [ ] **Step 2: Append Lot 6 section**

Add after the Lot 5 section:

```markdown
## Lot 6 — Specimens quickstart

The specimens API turns a temporary identification into a permanent entry in the user's bibliothèque.

**Workflow** :

1. `POST /v1/identifications` (multipart photo) → `{ id, top_match, alternatives, auto_pickable }`
2. `POST /v1/specimens` (JSON) with the `id` UUIDv7 client-generated, the `identification_id`, the `chosen_species_id`, the `identification_source` (`plantnet_auto` if confidence ≥ 0.70 + chosen = top, `plantnet_picked` otherwise), and `collected_at`.

**Endpoints** :

| Méthode | Path | Notes |
|---|---|---|
| POST | `/v1/specimens` | Idempotent sur `id`. 201 = créé, 200 = no-op (déjà existant pour ce user), 409 = id pour autre user. |
| GET | `/v1/specimens` | Cursor-based : `?cursor&limit=20&sort=collected_at_desc&q&family&date_from&date_to` |
| GET | `/v1/specimens/stats` | `{ total, distinct_species }` |
| GET | `/v1/specimens/:id` | Specimen complet, `photo_url` pré-signé 1h |
| PATCH | `/v1/specimens/:id` | Body `{ user_notes?, location_label? }`. `null` = clear. |
| DELETE | `/v1/specimens/:id` | Soft delete. La photo Garage reste jusqu'au cron Lot 8 (purge 30j). |

**Exemple** :

```bash
TOKEN=...

# 1) Identification
curl -X POST http://localhost:3000/v1/identifications \
  -H "Authorization: Bearer $TOKEN" \
  -F "photo=@flower.jpg;type=image/jpeg"

# Réponse : { id: "...", top_match: { species_id: "...", ... }, auto_pickable: true }

# 2) Specimen
curl -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "id": "0190d8a4-1234-7890-abcd-ef0123456789",
    "identification_id": "<from step 1>",
    "chosen_species_id": "<from step 1 top_match>",
    "identification_source": "plantnet_auto",
    "collected_at": "2026-06-07T10:00:00Z"
  }'
```

**Roadmap status** : Lots 1–6 done. Lot 7 (offline sync + retry identify) à venir.
```

- [ ] **Step 3: Update the roadmap status table elsewhere in README (if applicable)**

Open `README.md`, find any roadmap table or section listing Lot 1-6 status, and update it to mark Lot 6 done.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(lot-6): readme quickstart for specimens routes"
```

---

### Task 10: Verification end-to-end

- [ ] **Step 1: Full test suite**

Run: `nix develop --command bun test`
Expected: ALL pass (Lot 1–6).

- [ ] **Step 2: Typecheck + lint**

Run: `nix develop --command bun run typecheck && nix develop --command bun run lint`
Expected: clean.

- [ ] **Step 3: Smoke test local**

Run:
```bash
nix develop --command bun run dev
```

In another terminal (`nix develop` shell):
```bash
# Sign up
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@test.local","password":"correct-horse-battery-staple","name":"Smoke"}' \
  | jq -r .token)

# Identify (need a real JPEG file)
IDENT=$(curl -s -X POST http://localhost:3000/v1/identifications \
  -H "Authorization: Bearer $TOKEN" \
  -F "photo=@/path/to/flower.jpg;type=image/jpeg")
IDENT_ID=$(echo "$IDENT" | jq -r .id)
SPECIES_ID=$(echo "$IDENT" | jq -r .top_match.species_id)

# Create specimen
SID=$(bun -e 'import { uuid7 } from "./src/utils/uuid.ts"; console.log(uuid7())')
curl -s -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"id\":\"$SID\",\"identification_id\":\"$IDENT_ID\",\"chosen_species_id\":\"$SPECIES_ID\",\"identification_source\":\"plantnet_auto\",\"collected_at\":\"2026-06-07T10:00:00Z\"}"

# Replay → expect 200 (no-op)
curl -i -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"id\":\"$SID\",\"identification_id\":\"$IDENT_ID\",\"chosen_species_id\":\"$SPECIES_ID\",\"identification_source\":\"plantnet_auto\",\"collected_at\":\"2026-06-07T10:00:00Z\"}" \
  | head -1

# List + stats + delete
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/specimens | jq .
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/specimens/stats
curl -i -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/specimens/$SID | head -1
```

Expected:
- POST → 201
- Replay POST → 200
- DELETE → 204
- Final GET on the id → 404

---

## Self-Review Checklist (for plan executor)

After all tasks complete, before requesting code review:

- [ ] All unit + integration tests in `tests/unit/{utils,schemas,services}` and `tests/integration/specimens.test.ts` are green
- [ ] `nix develop --command bun run typecheck` clean
- [ ] `nix develop --command bun run lint` clean
- [ ] No `console.log` left in production code
- [ ] No `// TODO` or `// FIXME` markers in production code (debt is fine in tests)
- [ ] README updated and roadmap status reflects Lot 6 done
- [ ] No `copyObject` was added to `lib/garage.ts` (the decision is to reuse the temp key)
- [ ] `identifications.photo_status` flips correctly to `'promoted'` in the integration tests' DB assertions
- [ ] `photo_url` in API responses contains `X-Amz-Signature=` (pre-signed)
- [ ] `/v1/specimens/stats` route is declared BEFORE `/v1/specimens/:id` in `routes/specimens.ts`
- [ ] Cursor decoding tolerates malformed input and returns 400 `INVALID_CURSOR`

## Final review handoff

After self-review passes, dispatch `superpowers:requesting-code-review` on the full diff `git log main..HEAD`. Apply Critical + Important findings. Then proceed to `superpowers:finishing-a-development-branch`.
