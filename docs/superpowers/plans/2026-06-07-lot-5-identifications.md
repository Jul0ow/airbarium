# Lot 5 — Identifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brancher PlantNet + Wikipedia sur le backend — endpoint `POST /v1/identifications`, endpoint `GET /v1/species/:id`, quota PlantNet atomic (30/jour/user), enrichissement Wikipedia best-effort, bootstrap bucket `specimens` au boot.

**Architecture:** Deux adapters mockables (`lib/plantnet.ts`, `lib/wikipedia.ts`) en singleton + swap pattern (cf. `lib/mailer.ts`, `lib/garage.ts` du Lot 4). Quatre services (`quota`, `species`, `species-enrichment`, `identification`) qui orchestrent DB + Garage + libs externes. Deux routes Hono fines. Fixtures réelles PlantNet committées dans `tests/fixtures/`.

**Tech Stack:** Bun + Hono + Drizzle + Postgres 17 + Garage S3 + PlantNet REST API v2 + Wikipedia REST API.

---

## Contexte

Lot 4 (Garage S3 + avatar) est mergé. Le worktree `feat/lot-5-identifications` existe déjà avec la spec design `docs/superpowers/specs/2026-06-04-lot-5-identifications-design.md` et 2 fixtures PlantNet réelles. Les schemas Drizzle pour `species`, `identifications`, `plantnet_usage`, `specimens` existent déjà (Lot 2) — aucune migration à générer.

## Pré-requis exécution (avant Task 1)

- Worktree `feat/lot-5-identifications` actif (cwd = `/home/juloow/Documents/airbarium/.claude/worktrees/lot-5-identifications`).
- `docker compose up -d` tourne (postgres + garage + mailhog).
- `PLANTNET_API_KEY` dispo dans le `.env` local (jamais committé).
- DB de test `airbarium_test` créée (Lot 2). Si absente : `docker exec $(docker compose ps -q postgres) psql -U airbarium -c 'CREATE DATABASE airbarium_test;'`.

## Types partagés (référence pour toutes les tasks)

Définis dans `src/lib/plantnet.ts` :

```ts
export type PlantnetResult = {
  scientificName: string;        // species.scientificNameWithoutAuthor
  commonName: string | null;     // species.commonNames[0] ?? null
  family: string;                // species.family.scientificNameWithoutAuthor
  referencePhotoUrl: string | null; // images[0].url.m ?? null
  score: number;                 // 0..1
};

export type PlantnetRawResponse = {
  results: Array<unknown>;       // shape opaque, persisted as jsonb
  bestMatch?: string;
  version?: string;
  remainingIdentificationRequests?: number;
  [key: string]: unknown;
};

export class PlantnetTimeoutError extends Error { name = 'PlantnetTimeoutError' }
export class PlantnetUnavailableError extends Error { name = 'PlantnetUnavailableError' }
export class PlantnetQuotaExhaustedError extends Error { name = 'PlantnetQuotaExhaustedError' }
```

Définis dans `src/lib/wikipedia.ts` :

```ts
export type WikiSummary = {
  extract: string | null;
  contentUrl: string | null;
};

export class WikipediaUnavailableError extends Error { name = 'WikipediaUnavailableError' }
```

Définis dans `src/services/species.ts` :

```ts
export type SpeciesUpsertInput = {
  scientificName: string;
  commonName: string | null;
  family: string;
  referencePhotoUrl: string | null;
};

export type SpeciesResponse = {
  id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  description: string | null;
  reference_photo_url: string | null;
  wikipedia_url: string | null;
};
```

Définis dans `src/services/identification.ts` :

```ts
export type IdentificationExif = {
  dateTaken?: Date;
  gpsLat?: number;
  gpsLng?: number;
};

export type IdentificationCandidate = {
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  confidence: number;
  reference_photo_url: string | null;
  description: string | null;
};

export type IdentificationResponse = {
  id: string;
  top_match: IdentificationCandidate;
  alternatives: IdentificationCandidate[];
  confidence_threshold: number;
  auto_pickable: boolean;
};

export const CONFIDENCE_THRESHOLD = 0.7;
```

## File Structure

### Nouveaux

| Path | Responsabilité |
|---|---|
| `src/lib/plantnet.ts` | Singleton client + `identify(buffer)` + types + erreurs typées + `__setPlantnetForTests` |
| `src/lib/wikipedia.ts` | Singleton + `fetchSummary(scientificName)` + types + erreurs typées + `__setWikipediaForTests` |
| `src/services/quota.ts` | `incrementOrThrow(userId)` (UPSERT atomic) + `refund(userId)` |
| `src/services/species.ts` | `getById(id)`, `upsertFromPlantnet(input)` |
| `src/services/species-enrichment.ts` | `enrichSpecies(id)` + `scheduleEnrichment(id)` (fire-and-forget) |
| `src/services/identification.ts` | `identifyAndStore(userId, buffer, exif)` |
| `src/routes/identifications.ts` | `POST /v1/identifications` (multipart) |
| `src/routes/species.ts` | `GET /v1/species/:id` |
| `src/schemas/identifications.ts` | Zod transforms pour les 3 form fields EXIF |
| `tests/helpers/plantnet.ts` | `installMockPlantnet({ ... })` |
| `tests/helpers/wikipedia.ts` | `installMockWikipedia({ ... })` |
| `tests/unit/lib/plantnet.test.ts` | mock global fetch, 6 cas (lycoris fixture, blurred fixture, no_match, 5xx, 429, timeout) |
| `tests/unit/lib/wikipedia.test.ts` | mock global fetch, 4 cas (success, 404, 5xx, User-Agent vérifié) |
| `tests/unit/services/quota.test.ts` | real DB |
| `tests/unit/services/species.test.ts` | real DB |
| `tests/unit/services/species-enrichment.test.ts` | real DB + stub lib/wikipedia |
| `tests/unit/services/identification.test.ts` | real DB + stub libs |
| `tests/integration/identifications.test.ts` | end-to-end real Postgres+Garage, libs mockées |
| `tests/integration/species.test.ts` | end-to-end |

### Modifiés

| Path | Change |
|---|---|
| `src/config/env.ts` | Ajouter `PLANTNET_API_KEY` (required) + `WIKIPEDIA_USER_AGENT` (default `Airbarium/0.1 (dev)`) |
| `src/routes/index.ts` | Monter `identifications.ts` et `species.ts` |
| `src/server.ts` | Ajouter `await ensureBucket('specimens')` (skip prod) |
| `tests/helpers/garage.ts` | Ajouter `setupTestSpecimens()` + export `TEST_SPECIMENS_BUCKET` |
| `.env.example` | Activer `PLANTNET_API_KEY` + `WIKIPEDIA_USER_AGENT` |
| `.github/workflows/ci.yaml` | Ajouter `PLANTNET_API_KEY: test-key` + `WIKIPEDIA_USER_AGENT: Airbarium/0.1 (ci)` |

---

## Task 1 : Env vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `.env` (local, non-committé)

- [ ] **Step 1 : Étendre `EnvSchema`**

Edit `src/config/env.ts`, ajouter au schema après `GARAGE_REGION` :

```ts
  PLANTNET_API_KEY: z.string().min(1),
  WIKIPEDIA_USER_AGENT: z.string().min(1).default('Airbarium/0.1 (dev)'),
```

- [ ] **Step 2 : Mettre à jour `.env.example`**

Remplacer le bloc Lot 5 commenté en bas par une section active :

```
# Lot 5 — identifications
PLANTNET_API_KEY=
WIKIPEDIA_USER_AGENT="Airbarium/0.1 (contact@airbarium.app)"
```

Supprimer ces 2 lignes du bloc « Added in later lots ».

- [ ] **Step 3 : Mettre à jour `.env` local**

Ajouter les 2 lignes dans `.env`. `PLANTNET_API_KEY` doit pointer sur ta vraie clé (déjà obtenue pour la capture des fixtures). `WIKIPEDIA_USER_AGENT` libre, peu importe la valeur.

- [ ] **Step 4 : Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/config/env.ts .env.example
git commit -m "feat(lot-5): PLANTNET_API_KEY + WIKIPEDIA_USER_AGENT env vars"
```

---

## Task 2 : `lib/plantnet.ts` (TDD)

**Files:**
- Create: `src/lib/plantnet.ts`
- Create: `tests/unit/lib/plantnet.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

Créer `tests/unit/lib/plantnet.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  identify,
  PlantnetQuotaExhaustedError,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';

const LYCORIS = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/plantnet_lycoris.json'), 'utf8'),
);
const BLURRED = JSON.parse(
  readFileSync(join(import.meta.dir, '../../fixtures/plantnet_blurred.json'), 'utf8'),
);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let originalFetch: typeof globalThis.fetch;
let lastInit: { url: string; init: RequestInit | undefined } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    lastInit = { url, init };
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

describe('identify', () => {
  it('parses lycoris fixture into PlantnetResult[]', async () => {
    mockFetch(() => new Response(JSON.stringify(LYCORIS), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      scientificName: 'Lycoris radiata',
      commonName: 'Amaryllis du Japon',
      family: 'Amaryllidaceae',
      referencePhotoUrl: null,
      score: 0.92331,
    });
    expect(results[1]?.scientificName).toBe('Lycoris × albiflora');
    expect(results[1]?.commonName).toBeNull();
  });

  it('parses blurred fixture (low confidence, empty commonNames on alts)', async () => {
    mockFetch(() => new Response(JSON.stringify(BLURRED), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toHaveLength(3);
    expect(results[0]?.score).toBeCloseTo(0.26087, 5);
    expect(results[0]?.commonName).toBe('Myriophylle à fleurs alternes');
    expect(results[1]?.scientificName).toBe('Acer rubrum');
  });

  it('returns [] when PlantNet returns 200 with results: []', async () => {
    mockFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const results = await identify(jpeg);

    expect(results).toEqual([]);
  });

  it('sends query params (lang, nb-results, include-related-images, api-key) and form fields (organs, images)', async () => {
    mockFetch(() => new Response(JSON.stringify(LYCORIS), { status: 200 }));

    await identify(jpeg);

    expect(lastInit?.url).toContain('lang=fr');
    expect(lastInit?.url).toContain('nb-results=3');
    expect(lastInit?.url).toContain('include-related-images=true');
    expect(lastInit?.url).toMatch(/api-key=/);
    expect(lastInit?.init?.method).toBe('POST');
    expect(lastInit?.init?.body).toBeInstanceOf(FormData);
    const form = lastInit?.init?.body as FormData;
    expect(form.get('organs')).toBe('flower');
    const image = form.get('images');
    expect(image).toBeInstanceOf(Blob);
  });

  it('maps images[0].url.m when present', async () => {
    const withImages = JSON.parse(JSON.stringify(LYCORIS));
    withImages.results[0].images = [
      { url: { o: 'https://x/orig.jpg', m: 'https://x/medium.jpg', s: 'https://x/small.jpg' } },
    ];
    mockFetch(() => new Response(JSON.stringify(withImages), { status: 200 }));

    const results = await identify(jpeg);

    expect(results[0]?.referencePhotoUrl).toBe('https://x/medium.jpg');
  });

  it('throws PlantnetUnavailableError on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));

    await expect(identify(jpeg)).rejects.toBeInstanceOf(PlantnetUnavailableError);
  });

  it('throws PlantnetQuotaExhaustedError on 429', async () => {
    mockFetch(() => new Response('quota', { status: 429 }));

    await expect(identify(jpeg)).rejects.toBeInstanceOf(PlantnetQuotaExhaustedError);
  });

  it('throws PlantnetTimeoutError when fetch aborts', async () => {
    mockFetch(async (_url, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    await expect(identify(jpeg, { timeoutMs: 5 })).rejects.toBeInstanceOf(PlantnetTimeoutError);
  });
});
```

- [ ] **Step 2 : Run tests (FAIL attendu)**

```bash
bun test tests/unit/lib/plantnet.test.ts
```

Expected: « Cannot find module '@/lib/plantnet' ».

- [ ] **Step 3 : Implémenter `src/lib/plantnet.ts`**

```ts
import { env } from '@/config/env';

const PLANTNET_URL = 'https://my-api.plantnet.org/v2/identify/all';
const DEFAULT_TIMEOUT_MS = 10_000;

export type PlantnetResult = {
  scientificName: string;
  commonName: string | null;
  family: string;
  referencePhotoUrl: string | null;
  score: number;
};

export type PlantnetRawResponse = {
  results: Array<unknown>;
  bestMatch?: string;
  version?: string;
  remainingIdentificationRequests?: number;
  [key: string]: unknown;
};

export class PlantnetTimeoutError extends Error {
  constructor() {
    super('PlantNet request timed out');
    this.name = 'PlantnetTimeoutError';
  }
}

export class PlantnetUnavailableError extends Error {
  constructor(status: number, body?: string) {
    super(`PlantNet upstream error (status=${status})`);
    this.name = 'PlantnetUnavailableError';
    Object.assign(this, { status, body });
  }
}

export class PlantnetQuotaExhaustedError extends Error {
  constructor() {
    super('PlantNet global quota exhausted (429)');
    this.name = 'PlantnetQuotaExhaustedError';
  }
}

type RawResult = {
  score: number;
  species: {
    scientificNameWithoutAuthor: string;
    commonNames: string[];
    family: { scientificNameWithoutAuthor: string };
  };
  images?: Array<{ url?: { m?: string } }>;
};

function mapResult(r: RawResult): PlantnetResult {
  return {
    scientificName: r.species.scientificNameWithoutAuthor,
    commonName: r.species.commonNames[0] ?? null,
    family: r.species.family.scientificNameWithoutAuthor,
    referencePhotoUrl: r.images?.[0]?.url?.m ?? null,
    score: r.score,
  };
}

type Impl = {
  identify: (
    buffer: Uint8Array,
    opts?: { timeoutMs?: number },
  ) => Promise<PlantnetResult[]>;
  identifyRaw: (
    buffer: Uint8Array,
    opts?: { timeoutMs?: number },
  ) => Promise<{ raw: PlantnetRawResponse; results: PlantnetResult[] }>;
};

const defaultImpl: Impl = {
  async identifyRaw(buffer, opts) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${PLANTNET_URL}?api-key=${encodeURIComponent(env.PLANTNET_API_KEY)}&lang=fr&nb-results=3&include-related-images=true`;

    const form = new FormData();
    form.append('organs', 'flower');
    form.append('images', new Blob([buffer], { type: 'image/jpeg' }), 'photo.jpg');

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new PlantnetTimeoutError();
      throw new PlantnetUnavailableError(0, (err as Error).message);
    } finally {
      clearTimeout(t);
    }

    if (res.status === 429) throw new PlantnetQuotaExhaustedError();
    if (res.status >= 500) throw new PlantnetUnavailableError(res.status, await res.text());
    if (!res.ok) throw new PlantnetUnavailableError(res.status, await res.text());

    const raw = (await res.json()) as PlantnetRawResponse;
    const results = (raw.results as RawResult[] | undefined)?.map(mapResult) ?? [];
    return { raw, results };
  },
  async identify(buffer, opts) {
    return (await defaultImpl.identifyRaw(buffer, opts)).results;
  },
};

let impl: Impl = defaultImpl;

export const identify: Impl['identify'] = (buffer, opts) => impl.identify(buffer, opts);
export const identifyRaw: Impl['identifyRaw'] = (buffer, opts) => impl.identifyRaw(buffer, opts);

export function __setPlantnetForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
```

Note : on expose `identifyRaw` en plus de `identify` parce que le service `identification.ts` aura besoin de stocker `raw` en `plantnet_raw_response` (jsonb). Les tests unitaires se concentrent sur `identify` (le mapping) — `identifyRaw` est testé indirectement via le service.

- [ ] **Step 4 : Run tests (PASS attendu)**

```bash
bun test tests/unit/lib/plantnet.test.ts
```

Expected: 8 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/lib/plantnet.ts tests/unit/lib/plantnet.test.ts
git commit -m "feat(lot-5): lib/plantnet HTTP adapter with golden-fixture unit tests"
```

---

## Task 3 : `lib/wikipedia.ts` (TDD)

**Files:**
- Create: `src/lib/wikipedia.ts`
- Create: `tests/unit/lib/wikipedia.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchSummary, WikipediaUnavailableError } from '@/lib/wikipedia';

let originalFetch: typeof globalThis.fetch;
let lastInit: { url: string; init: RequestInit | undefined } | null = null;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastInit = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    lastInit = { url, init };
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

describe('fetchSummary', () => {
  it('returns extract and content url on 200', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          extract: 'Le Lycoris est un genre…',
          content_urls: { desktop: { page: 'https://fr.wikipedia.org/wiki/Lycoris_radiata' } },
        }),
        { status: 200 },
      ),
    );

    const summary = await fetchSummary('Lycoris radiata');

    expect(summary).toEqual({
      extract: 'Le Lycoris est un genre…',
      contentUrl: 'https://fr.wikipedia.org/wiki/Lycoris_radiata',
    });
  });

  it('returns null on 404', async () => {
    mockFetch(() => new Response('not found', { status: 404 }));

    const summary = await fetchSummary('Unknown Species');

    expect(summary).toBeNull();
  });

  it('throws WikipediaUnavailableError on 500', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));

    await expect(fetchSummary('X')).rejects.toBeInstanceOf(WikipediaUnavailableError);
  });

  it('sends User-Agent header and URL-encodes scientific name', async () => {
    mockFetch(() => new Response(JSON.stringify({ extract: 'x', content_urls: { desktop: { page: 'x' } } }), { status: 200 }));

    await fetchSummary('Lycoris × albiflora');

    expect(lastInit?.url).toContain('fr.wikipedia.org/api/rest_v1/page/summary/');
    expect(lastInit?.url).toContain(encodeURIComponent('Lycoris × albiflora'));
    const headers = lastInit?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBeTruthy();
  });
});
```

- [ ] **Step 2 : Run tests (FAIL)**

```bash
bun test tests/unit/lib/wikipedia.test.ts
```

Expected: « Cannot find module '@/lib/wikipedia' ».

- [ ] **Step 3 : Implémenter `src/lib/wikipedia.ts`**

```ts
import { env } from '@/config/env';

const WIKI_URL = 'https://fr.wikipedia.org/api/rest_v1/page/summary/';
const DEFAULT_TIMEOUT_MS = 5_000;

export type WikiSummary = {
  extract: string | null;
  contentUrl: string | null;
};

export class WikipediaUnavailableError extends Error {
  constructor(status: number) {
    super(`Wikipedia upstream error (status=${status})`);
    this.name = 'WikipediaUnavailableError';
  }
}

type RawSummary = {
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
};

type Impl = {
  fetchSummary: (
    scientificName: string,
    opts?: { timeoutMs?: number },
  ) => Promise<WikiSummary | null>;
};

const defaultImpl: Impl = {
  async fetchSummary(scientificName, opts) {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${WIKI_URL}${encodeURIComponent(scientificName)}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': env.WIKIPEDIA_USER_AGENT },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new WikipediaUnavailableError(0);
      throw new WikipediaUnavailableError(0);
    } finally {
      clearTimeout(t);
    }

    if (res.status === 404) return null;
    if (!res.ok) throw new WikipediaUnavailableError(res.status);

    const raw = (await res.json()) as RawSummary;
    return {
      extract: raw.extract ?? null,
      contentUrl: raw.content_urls?.desktop?.page ?? null,
    };
  },
};

let impl: Impl = defaultImpl;

export const fetchSummary: Impl['fetchSummary'] = (name, opts) => impl.fetchSummary(name, opts);

export function __setWikipediaForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/lib/wikipedia.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/lib/wikipedia.ts tests/unit/lib/wikipedia.test.ts
git commit -m "feat(lot-5): lib/wikipedia summary fetch with 404→null + timeout"
```

---

## Task 4 : `services/quota.ts` (TDD)

**Files:**
- Create: `src/services/quota.ts`
- Create: `tests/unit/services/quota.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { plantnetUsage, users } from '@/db/schema';
import { incrementOrThrow, refund } from '@/services/quota';
import { uuid7 } from '@/utils/uuid';
import { AppError } from '@/utils/errors';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

const today = () => new Date().toISOString().slice(0, 10);

async function createUser() {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'Q' });
  return id;
}

async function readCount(userId: string): Promise<number> {
  const [row] = await testDb
    .select({ count: plantnetUsage.count })
    .from(plantnetUsage)
    .where(and(eq(plantnetUsage.userId, userId), eq(plantnetUsage.day, today())));
  return row?.count ?? 0;
}

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
});

describe('incrementOrThrow', () => {
  it('inserts row with count=1 on first call', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(1);
  });

  it('increments existing row', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(2);
  });

  it('allows up to 30 calls then throws QUOTA_EXCEEDED on the 31st', async () => {
    const uid = await createUser();
    for (let i = 0; i < 30; i++) await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(30);

    try {
      await incrementOrThrow(uid);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('QUOTA_EXCEEDED');
      expect((err as AppError).status).toBe(429);
    }
    // refunded back to 30
    expect(await readCount(uid)).toBe(30);
  });
});

describe('refund', () => {
  it('decrements when count > 0', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    await incrementOrThrow(uid);
    await refund(uid);
    expect(await readCount(uid)).toBe(1);
  });

  it('no-op when no row exists', async () => {
    const uid = await createUser();
    await refund(uid);
    expect(await readCount(uid)).toBe(0);
  });
});
```

- [ ] **Step 2 : Run tests (FAIL)**

```bash
bun test tests/unit/services/quota.test.ts
```

Expected: « Cannot find module '@/services/quota' ».

- [ ] **Step 3 : Implémenter `src/services/quota.ts`**

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { plantnetUsage } from '@/db/schema';
import { AppError } from '@/utils/errors';

const DAILY_LIMIT = 30;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function incrementOrThrow(userId: string): Promise<void> {
  const day = today();

  const [row] = await db
    .insert(plantnetUsage)
    .values({ userId, day, count: 1 })
    .onConflictDoUpdate({
      target: [plantnetUsage.userId, plantnetUsage.day],
      set: { count: sql`${plantnetUsage.count} + 1` },
    })
    .returning({ count: plantnetUsage.count });

  if (!row) throw new Error('quota: insert returned no row');

  if (row.count > DAILY_LIMIT) {
    await refund(userId);
    throw new AppError(
      'QUOTA_EXCEEDED',
      `Daily PlantNet quota of ${DAILY_LIMIT} identifications exceeded`,
      429,
      { limit: DAILY_LIMIT },
    );
  }
}

export async function refund(userId: string): Promise<void> {
  const day = today();
  await db
    .update(plantnetUsage)
    .set({ count: sql`${plantnetUsage.count} - 1` })
    .where(
      and(
        eq(plantnetUsage.userId, userId),
        eq(plantnetUsage.day, day),
        sql`${plantnetUsage.count} > 0`,
      ),
    );
}
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/services/quota.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/services/quota.ts tests/unit/services/quota.test.ts
git commit -m "feat(lot-5): services/quota atomic UPSERT with 30/day limit + refund"
```

---

## Task 5 : `services/species.ts` (TDD)

**Files:**
- Create: `src/services/species.ts`
- Create: `tests/unit/services/species.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

```ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { species } from '@/db/schema';
import { getById, upsertFromPlantnet } from '@/services/species';
import { AppError } from '@/utils/errors';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

const input = {
  scientificName: 'Lycoris radiata',
  commonName: 'Amaryllis du Japon',
  family: 'Amaryllidaceae',
  referencePhotoUrl: 'https://bs.plantnet.org/x.jpg',
};

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
});

describe('upsertFromPlantnet', () => {
  it('creates a new species and returns isNew=true', async () => {
    const { species: sp, isNew } = await upsertFromPlantnet(input);
    expect(isNew).toBe(true);
    expect(sp.scientificName).toBe('Lycoris radiata');
    expect(sp.commonName).toBe('Amaryllis du Japon');
    expect(sp.family).toBe('Amaryllidaceae');
    expect(sp.referencePhotoUrl).toBe('https://bs.plantnet.org/x.jpg');

    const [row] = await testDb.select().from(species).where(eq(species.id, sp.id));
    expect(row?.scientificName).toBe('Lycoris radiata');
  });

  it('updates existing species and returns isNew=false', async () => {
    const first = await upsertFromPlantnet(input);
    const second = await upsertFromPlantnet({
      ...input,
      commonName: 'Higanbana',
      referencePhotoUrl: 'https://bs.plantnet.org/y.jpg',
    });
    expect(second.isNew).toBe(false);
    expect(second.species.id).toBe(first.species.id);
    expect(second.species.commonName).toBe('Higanbana');
    expect(second.species.referencePhotoUrl).toBe('https://bs.plantnet.org/y.jpg');
  });

  it('accepts null commonName and null referencePhotoUrl', async () => {
    const { species: sp, isNew } = await upsertFromPlantnet({
      scientificName: 'Acer rubrum',
      commonName: null,
      family: 'Sapindaceae',
      referencePhotoUrl: null,
    });
    expect(isNew).toBe(true);
    expect(sp.commonName).toBeNull();
    expect(sp.referencePhotoUrl).toBeNull();
  });
});

describe('getById', () => {
  it('returns SpeciesResponse for known id', async () => {
    const { species: sp } = await upsertFromPlantnet(input);
    const r = await getById(sp.id);
    expect(r).toEqual({
      id: sp.id,
      common_name: 'Amaryllis du Japon',
      scientific_name: 'Lycoris radiata',
      family: 'Amaryllidaceae',
      description: null,
      reference_photo_url: 'https://bs.plantnet.org/x.jpg',
      wikipedia_url: null,
    });
  });

  it('throws NOT_FOUND for unknown id', async () => {
    try {
      await getById('00000000-0000-7000-8000-000000000000');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('NOT_FOUND');
      expect((err as AppError).status).toBe(404);
    }
  });
});
```

- [ ] **Step 2 : Run tests (FAIL)**

```bash
bun test tests/unit/services/species.test.ts
```

Expected: « Cannot find module '@/services/species' ».

- [ ] **Step 3 : Implémenter `src/services/species.ts`**

```ts
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { type Species, species } from '@/db/schema';
import { NotFoundError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';

export type SpeciesUpsertInput = {
  scientificName: string;
  commonName: string | null;
  family: string;
  referencePhotoUrl: string | null;
};

export type SpeciesResponse = {
  id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  description: string | null;
  reference_photo_url: string | null;
  wikipedia_url: string | null;
};

function toResponse(s: Species): SpeciesResponse {
  return {
    id: s.id,
    common_name: s.commonName,
    scientific_name: s.scientificName,
    family: s.family,
    description: s.description,
    reference_photo_url: s.referencePhotoUrl,
    wikipedia_url: s.wikipediaUrl,
  };
}

export async function upsertFromPlantnet(
  input: SpeciesUpsertInput,
): Promise<{ species: Species; isNew: boolean }> {
  // xmax = 0 ⇔ row was freshly inserted by this statement
  const rows = await db.execute<{
    id: string;
    scientific_name: string;
    common_name: string | null;
    family: string | null;
    description: string | null;
    reference_photo_url: string | null;
    wikipedia_url: string | null;
    wikipedia_fetched_at: Date | null;
    rarity_level: number | null;
    created_at: Date;
    updated_at: Date;
    is_new: boolean;
  }>(sql`
    INSERT INTO species (id, scientific_name, common_name, family, reference_photo_url)
    VALUES (${uuid7()}, ${input.scientificName}, ${input.commonName}, ${input.family}, ${input.referencePhotoUrl})
    ON CONFLICT (scientific_name) DO UPDATE
      SET common_name = EXCLUDED.common_name,
          family = EXCLUDED.family,
          reference_photo_url = EXCLUDED.reference_photo_url,
          updated_at = now()
    RETURNING *, (xmax = 0) AS is_new
  `);

  const row = rows[0];
  if (!row) throw new Error('species.upsertFromPlantnet: no row returned');
  const isNew = row.is_new;
  const speciesRow: Species = {
    id: row.id,
    scientificName: row.scientific_name,
    commonName: row.common_name,
    family: row.family,
    description: row.description,
    referencePhotoUrl: row.reference_photo_url,
    wikipediaUrl: row.wikipedia_url,
    wikipediaFetchedAt: row.wikipedia_fetched_at,
    rarityLevel: row.rarity_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { species: speciesRow, isNew };
}

export async function getById(id: string): Promise<SpeciesResponse> {
  const [row] = await db.select().from(species).where(eq(species.id, id));
  if (!row) throw new NotFoundError(`species ${id} not found`);
  return toResponse(row);
}
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/services/species.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/services/species.ts tests/unit/services/species.test.ts
git commit -m "feat(lot-5): services/species lazy upsert with is_new + getById"
```

---

## Task 6 : `services/species-enrichment.ts` (TDD)

**Files:**
- Create: `src/services/species-enrichment.ts`
- Create: `tests/unit/services/species-enrichment.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { species } from '@/db/schema';
import { __setWikipediaForTests, WikipediaUnavailableError } from '@/lib/wikipedia';
import { enrichSpecies, scheduleEnrichment } from '@/services/species-enrichment';
import { upsertFromPlantnet } from '@/services/species';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

let restore: () => void;

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
});
afterEach(() => restore?.());

async function makeSpecies() {
  const { species: s } = await upsertFromPlantnet({
    scientificName: 'Lycoris radiata',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
  });
  return s;
}

describe('enrichSpecies', () => {
  it('writes description + wiki_url + fetched_at on success', async () => {
    restore = __setWikipediaForTests({
      fetchSummary: async () => ({
        extract: 'Le lycoris est…',
        contentUrl: 'https://fr.wikipedia.org/wiki/Lycoris_radiata',
      }),
    });
    const s = await makeSpecies();

    await enrichSpecies(s.id);

    const [row] = await testDb.select().from(species).where(eq(species.id, s.id));
    expect(row?.description).toBe('Le lycoris est…');
    expect(row?.wikipediaUrl).toBe('https://fr.wikipedia.org/wiki/Lycoris_radiata');
    expect(row?.wikipediaFetchedAt).toBeInstanceOf(Date);
  });

  it('sets only fetched_at on 404 (null summary)', async () => {
    restore = __setWikipediaForTests({ fetchSummary: async () => null });
    const s = await makeSpecies();

    await enrichSpecies(s.id);

    const [row] = await testDb.select().from(species).where(eq(species.id, s.id));
    expect(row?.description).toBeNull();
    expect(row?.wikipediaUrl).toBeNull();
    expect(row?.wikipediaFetchedAt).toBeInstanceOf(Date);
  });

  it('does NOT update fetched_at on WikipediaUnavailableError', async () => {
    restore = __setWikipediaForTests({
      fetchSummary: async () => {
        throw new WikipediaUnavailableError(500);
      },
    });
    const s = await makeSpecies();

    await enrichSpecies(s.id);

    const [row] = await testDb.select().from(species).where(eq(species.id, s.id));
    expect(row?.wikipediaFetchedAt).toBeNull();
  });

  it('no-op when species id does not exist', async () => {
    restore = __setWikipediaForTests({ fetchSummary: async () => null });
    await enrichSpecies('00000000-0000-7000-8000-000000000000');
    // no throw
  });
});

describe('scheduleEnrichment', () => {
  it('catches errors thrown by enrichSpecies (does not crash the process)', async () => {
    restore = __setWikipediaForTests({
      fetchSummary: async () => {
        throw new Error('unexpected');
      },
    });
    const s = await makeSpecies();
    scheduleEnrichment(s.id);
    await new Promise((r) => setTimeout(r, 50));
    // assertion: process still alive
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2 : Run tests (FAIL)**

```bash
bun test tests/unit/services/species-enrichment.test.ts
```

Expected: « Cannot find module '@/services/species-enrichment' ».

- [ ] **Step 3 : Implémenter `src/services/species-enrichment.ts`**

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { species } from '@/db/schema';
import { fetchSummary, WikipediaUnavailableError } from '@/lib/wikipedia';
import { logger } from '@/middleware/logger';

export async function enrichSpecies(speciesId: string): Promise<void> {
  const [sp] = await db.select().from(species).where(eq(species.id, speciesId));
  if (!sp) return;

  let summary: Awaited<ReturnType<typeof fetchSummary>>;
  try {
    summary = await fetchSummary(sp.scientificName);
  } catch (err) {
    if (err instanceof WikipediaUnavailableError) {
      // skip wikipedia_fetched_at update so cron Lot 8 can retry
      logger.warn({ err, speciesId, scientificName: sp.scientificName }, 'wiki.enrich.skip');
      return;
    }
    throw err;
  }

  await db
    .update(species)
    .set({
      description: summary?.extract ?? null,
      wikipediaUrl: summary?.contentUrl ?? null,
      wikipediaFetchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(species.id, speciesId));
}

export function scheduleEnrichment(speciesId: string): void {
  queueMicrotask(() => {
    enrichSpecies(speciesId).catch((err) => {
      logger.warn({ err, speciesId }, 'wiki.enrich.failed');
    });
  });
}
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/services/species-enrichment.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/services/species-enrichment.ts tests/unit/services/species-enrichment.test.ts
git commit -m "feat(lot-5): services/species-enrichment Wikipedia best-effort + scheduleEnrichment"
```

---

## Task 7 : `services/identification.ts` (TDD)

**Files:**
- Create: `src/services/identification.ts`
- Create: `tests/unit/services/identification.test.ts`

- [ ] **Step 1 : Écrire les tests (FAIL)**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, plantnetUsage, species, users } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import {
  __setPlantnetForTests,
  PlantnetQuotaExhaustedError,
  PlantnetUnavailableError,
  type PlantnetResult,
} from '@/lib/plantnet';
import { __setWikipediaForTests } from '@/lib/wikipedia';
import { identifyAndStore } from '@/services/identification';
import { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

const restores: Array<() => void> = [];
const buffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

const sampleResults: PlantnetResult[] = [
  {
    scientificName: 'Lycoris radiata',
    commonName: 'Amaryllis du Japon',
    family: 'Amaryllidaceae',
    referencePhotoUrl: 'https://bs.plantnet.org/m1.jpg',
    score: 0.92331,
  },
  {
    scientificName: 'Lycoris × albiflora',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.00998,
  },
  {
    scientificName: 'Lycoris aurea',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.00619,
  },
];

async function createUser() {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'I' });
  return id;
}

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
  restores.length = 0;
  restores.push(__setWikipediaForTests({ fetchSummary: async () => null }));
});
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function stubGarage(opts: { fail?: boolean } = {}) {
  const calls: Array<{ bucket: string; key: string }> = [];
  restores.push(
    __setGarageForTests({
      putObject: async ({ bucket, key }) => {
        calls.push({ bucket, key });
        if (opts.fail) throw new Error('garage boom');
      },
      ensureBucket: async () => {},
    }),
  );
  return calls;
}

function stubPlantnet(results: PlantnetResult[], rawExtra: Record<string, unknown> = {}) {
  restores.push(
    __setPlantnetForTests({
      identify: async () => results,
      identifyRaw: async () => ({
        raw: { results, ...rawExtra } as never,
        results,
      }),
    }),
  );
}

describe('identifyAndStore', () => {
  it('returns top + 2 alts, auto_pickable=true, persists identification + species', async () => {
    const uid = await createUser();
    const garageCalls = stubGarage();
    stubPlantnet(sampleResults);

    const out = await identifyAndStore(uid, buffer, {});

    expect(out.top_match.scientific_name).toBe('Lycoris radiata');
    expect(out.top_match.confidence).toBeCloseTo(0.92331, 5);
    expect(out.alternatives).toHaveLength(2);
    expect(out.confidence_threshold).toBe(0.7);
    expect(out.auto_pickable).toBe(true);

    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, out.id));
    expect(ident?.userId).toBe(uid);
    expect(ident?.photoStatus).toBe('temp');
    expect(ident?.photoUrl).toBe(`${uid}/${out.id}.jpg`);
    expect(ident?.expiresAt).toBeInstanceOf(Date);
    expect(garageCalls[0]).toEqual({ bucket: 'specimens', key: `${uid}/${out.id}.jpg` });

    const speciesRows = await testDb.select().from(species);
    expect(speciesRows).toHaveLength(3);
  });

  it('returns auto_pickable=false when top score < 0.70', async () => {
    const uid = await createUser();
    stubGarage();
    stubPlantnet([{ ...sampleResults[0]!, score: 0.26 }, sampleResults[1]!, sampleResults[2]!]);

    const out = await identifyAndStore(uid, buffer, {});

    expect(out.auto_pickable).toBe(false);
  });

  it('stores exif metadata as jsonb', async () => {
    const uid = await createUser();
    stubGarage();
    stubPlantnet(sampleResults);

    const date = new Date('2026-05-15T10:00:00Z');
    const out = await identifyAndStore(uid, buffer, {
      dateTaken: date,
      gpsLat: 48.85,
      gpsLng: 2.34,
    });

    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, out.id));
    expect(ident?.exifMetadata).toEqual({
      date_taken: date.toISOString(),
      gps_lat: 48.85,
      gps_lng: 2.34,
    });
  });

  it('throws QUOTA_EXCEEDED when user already at 30/day', async () => {
    const uid = await createUser();
    stubGarage();
    stubPlantnet(sampleResults);
    const today = new Date().toISOString().slice(0, 10);
    await testDb.insert(plantnetUsage).values({ userId: uid, day: today, count: 30 });

    try {
      await identifyAndStore(uid, buffer, {});
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AppError).code).toBe('QUOTA_EXCEEDED');
    }
  });

  it('throws NO_MATCH (422) and does NOT refund quota when PlantNet returns []', async () => {
    const uid = await createUser();
    stubGarage();
    stubPlantnet([]);

    try {
      await identifyAndStore(uid, buffer, {});
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AppError).code).toBe('NO_MATCH');
      expect((err as AppError).status).toBe(422);
    }
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, uid));
    expect(row?.count).toBe(1);
  });

  it('throws PLANTNET_UNAVAILABLE (502) and refunds quota on upstream 5xx', async () => {
    const uid = await createUser();
    stubGarage();
    restores.push(
      __setPlantnetForTests({
        identify: async () => {
          throw new PlantnetUnavailableError(500);
        },
        identifyRaw: async () => {
          throw new PlantnetUnavailableError(500);
        },
      }),
    );

    try {
      await identifyAndStore(uid, buffer, {});
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AppError).code).toBe('PLANTNET_UNAVAILABLE');
      expect((err as AppError).status).toBe(502);
    }
    const [row] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, uid));
    expect(row?.count ?? 0).toBe(0);
  });

  it('throws PLANTNET_UNAVAILABLE on quota exhausted upstream (429)', async () => {
    const uid = await createUser();
    stubGarage();
    restores.push(
      __setPlantnetForTests({
        identify: async () => {
          throw new PlantnetQuotaExhaustedError();
        },
        identifyRaw: async () => {
          throw new PlantnetQuotaExhaustedError();
        },
      }),
    );

    try {
      await identifyAndStore(uid, buffer, {});
      throw new Error('expected throw');
    } catch (err) {
      expect((err as AppError).code).toBe('PLANTNET_UNAVAILABLE');
    }
  });

  it('bubbles up garage error (no refund — quota consumed)', async () => {
    const uid = await createUser();
    stubGarage({ fail: true });
    stubPlantnet(sampleResults);

    await expect(identifyAndStore(uid, buffer, {})).rejects.toBeInstanceOf(Error);

    const [row] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, uid));
    expect(row?.count).toBe(1);
  });
});
```

- [ ] **Step 2 : Run tests (FAIL)**

```bash
bun test tests/unit/services/identification.test.ts
```

Expected: « Cannot find module '@/services/identification' ».

- [ ] **Step 3 : Implémenter `src/services/identification.ts`**

```ts
import { db } from '@/db/client';
import { identifications } from '@/db/schema';
import { putObject } from '@/lib/garage';
import {
  identifyRaw,
  PlantnetQuotaExhaustedError,
  PlantnetTimeoutError,
  PlantnetUnavailableError,
} from '@/lib/plantnet';
import { incrementOrThrow, refund } from '@/services/quota';
import { upsertFromPlantnet } from '@/services/species';
import { scheduleEnrichment } from '@/services/species-enrichment';
import { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';

export const CONFIDENCE_THRESHOLD = 0.7;
const SPECIMENS_BUCKET = 'specimens';
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

export type IdentificationExif = {
  dateTaken?: Date;
  gpsLat?: number;
  gpsLng?: number;
};

export type IdentificationCandidate = {
  species_id: string;
  common_name: string | null;
  scientific_name: string;
  family: string | null;
  confidence: number;
  reference_photo_url: string | null;
  description: string | null;
};

export type IdentificationResponse = {
  id: string;
  top_match: IdentificationCandidate;
  alternatives: IdentificationCandidate[];
  confidence_threshold: number;
  auto_pickable: boolean;
};

function buildExifJson(exif: IdentificationExif): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (exif.dateTaken) out.date_taken = exif.dateTaken.toISOString();
  if (exif.gpsLat !== undefined) out.gps_lat = exif.gpsLat;
  if (exif.gpsLng !== undefined) out.gps_lng = exif.gpsLng;
  return Object.keys(out).length ? out : null;
}

export async function identifyAndStore(
  userId: string,
  buffer: Uint8Array,
  exif: IdentificationExif,
): Promise<IdentificationResponse> {
  await incrementOrThrow(userId);

  let raw: unknown;
  let results;
  try {
    const r = await identifyRaw(buffer);
    raw = r.raw;
    results = r.results;
  } catch (err) {
    if (
      err instanceof PlantnetTimeoutError ||
      err instanceof PlantnetUnavailableError ||
      err instanceof PlantnetQuotaExhaustedError
    ) {
      await refund(userId);
      throw new AppError('PLANTNET_UNAVAILABLE', 'PlantNet upstream unavailable', 502);
    }
    throw err;
  }

  if (results.length === 0) {
    // NO_MATCH: PlantNet a répondu — pas de refund (cf. spec §2 décision "Quota refund")
    throw new AppError('NO_MATCH', 'PlantNet returned no candidates', 422);
  }

  const identificationId = uuid7();
  const key = `${userId}/${identificationId}.jpg`;
  await putObject({
    bucket: SPECIMENS_BUCKET,
    key,
    body: buffer,
    contentType: 'image/jpeg',
  });

  // upsert species in order (top, alt1, alt2). Collect (species, isNew).
  const speciesPairs = [] as Array<{ species: { id: string }; isNew: boolean; result: typeof results[number] }>;
  for (const r of results) {
    const pair = await upsertFromPlantnet({
      scientificName: r.scientificName,
      commonName: r.commonName,
      family: r.family,
      referencePhotoUrl: r.referencePhotoUrl,
    });
    speciesPairs.push({ species: pair.species, isNew: pair.isNew, result: r });
    if (pair.isNew) scheduleEnrichment(pair.species.id);
  }

  await db.insert(identifications).values({
    id: identificationId,
    userId,
    photoUrl: key,
    photoStatus: 'temp',
    plantnetRawResponse: raw as never,
    topMatchSpeciesId: speciesPairs[0]!.species.id,
    topMatchConfidence: results[0]!.score.toFixed(4),
    exifMetadata: buildExifJson(exif) as never,
    expiresAt: new Date(Date.now() + TEMP_TTL_MS),
  });

  const toCandidate = (pair: typeof speciesPairs[number]): IdentificationCandidate => ({
    species_id: pair.species.id,
    common_name: pair.result.commonName,
    scientific_name: pair.result.scientificName,
    family: pair.result.family,
    confidence: pair.result.score,
    reference_photo_url: pair.result.referencePhotoUrl,
    description: null, // freshly upserted ⇒ enrichissement async pas encore terminé
  });

  return {
    id: identificationId,
    top_match: toCandidate(speciesPairs[0]!),
    alternatives: speciesPairs.slice(1).map(toCandidate),
    confidence_threshold: CONFIDENCE_THRESHOLD,
    auto_pickable: results[0]!.score >= CONFIDENCE_THRESHOLD,
  };
}
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/services/identification.test.ts
```

Expected: 8 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/services/identification.ts tests/unit/services/identification.test.ts
git commit -m "feat(lot-5): services/identification orchestration with quota refund + scheduleEnrichment"
```

---

## Task 8 : Bootstrap bucket `specimens` au boot

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1 : Ajouter `ensureBucket('specimens')`**

Edit `src/server.ts`, ajouter avant `Bun.serve(...)` :

```ts
if (env.NODE_ENV !== 'production') {
  try {
    await ensureBucket('avatars');
    await ensureBucket('specimens');
  } catch (err) {
    logger.warn({ err }, 'startup: ensureBucket failed — continuing anyway');
  }
}
```

(Remplace le bloc existant qui ne contenait que `await ensureBucket('avatars')`.)

- [ ] **Step 2 : Run typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3 : Smoke manuel**

```bash
bun run dev
```

Logs attendus dans l'ordre : `garage.bucket.created` (specimens — premier boot) puis `listening on :3000`. Kill avec Ctrl-C.

```bash
docker compose exec garage /garage --rpc-host garage:3901 bucket list | grep specimens
```

Expected: ligne contenant `specimens`.

- [ ] **Step 4 : Commit**

```bash
git add src/server.ts
git commit -m "feat(lot-5): ensureBucket(specimens) at server boot (skip prod)"
```

---

## Task 9 : `schemas/identifications.ts` (Zod EXIF)

**Files:**
- Create: `src/schemas/identifications.ts`
- Create: `tests/unit/schemas/identifications.test.ts`

- [ ] **Step 1 : Tests (FAIL)**

```ts
import { describe, expect, it } from 'bun:test';
import { ExifFormSchema } from '@/schemas/identifications';

describe('ExifFormSchema', () => {
  it('parses all 3 fields when present (strings → typed)', () => {
    const out = ExifFormSchema.parse({
      date_taken: '2026-05-15T10:00:00Z',
      gps_lat: '48.85',
      gps_lng: '2.34',
    });
    expect(out.dateTaken).toBeInstanceOf(Date);
    expect(out.gpsLat).toBe(48.85);
    expect(out.gpsLng).toBe(2.34);
  });

  it('returns empty object when all absent', () => {
    expect(ExifFormSchema.parse({})).toEqual({});
  });

  it('rejects out-of-range latitude', () => {
    expect(() => ExifFormSchema.parse({ gps_lat: '95' })).toThrow();
  });

  it('rejects out-of-range longitude', () => {
    expect(() => ExifFormSchema.parse({ gps_lng: '-200' })).toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => ExifFormSchema.parse({ date_taken: 'not-a-date' })).toThrow();
  });
});
```

- [ ] **Step 2 : Run (FAIL)**

```bash
bun test tests/unit/schemas/identifications.test.ts
```

Expected: « Cannot find module '@/schemas/identifications' ».

- [ ] **Step 3 : Implémenter `src/schemas/identifications.ts`**

```ts
import { z } from 'zod';

const latitude = z
  .string()
  .transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < -90 || n > 90) {
      ctx.addIssue({ code: 'custom', message: 'invalid latitude' });
      return z.NEVER;
    }
    return n;
  });

const longitude = z
  .string()
  .transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < -180 || n > 180) {
      ctx.addIssue({ code: 'custom', message: 'invalid longitude' });
      return z.NEVER;
    }
    return n;
  });

const isoDate = z
  .string()
  .transform((v, ctx) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'invalid date_taken' });
      return z.NEVER;
    }
    return d;
  });

export const ExifFormSchema = z
  .object({
    date_taken: isoDate.optional(),
    gps_lat: latitude.optional(),
    gps_lng: longitude.optional(),
  })
  .transform((v) => ({
    ...(v.date_taken !== undefined && { dateTaken: v.date_taken }),
    ...(v.gps_lat !== undefined && { gpsLat: v.gps_lat }),
    ...(v.gps_lng !== undefined && { gpsLng: v.gps_lng }),
  }));

export type ExifForm = z.infer<typeof ExifFormSchema>;
```

- [ ] **Step 4 : Run tests (PASS)**

```bash
bun test tests/unit/schemas/identifications.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5 : Commit**

```bash
git add src/schemas/identifications.ts tests/unit/schemas/identifications.test.ts
git commit -m "feat(lot-5): schemas/identifications EXIF form-fields Zod transform"
```

---

## Task 10 : `routes/species.ts`

**Files:**
- Create: `src/routes/species.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1 : Implémenter `src/routes/species.ts`**

```ts
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware } from '@/middleware/auth';
import { getById } from '@/services/species';

const route = new Hono<AppEnv>();

route.get('/species/:id', authMiddleware(), async (c) => {
  const id = c.req.param('id');
  return c.json(await getById(id));
});

export default route;
```

- [ ] **Step 2 : Monter dans `src/routes/index.ts`**

```ts
import { Hono } from 'hono';
import health from '@/routes/health';
import me from '@/routes/me';
import species from '@/routes/species';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
routes.route('/', species);
```

- [ ] **Step 3 : Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add src/routes/species.ts src/routes/index.ts
git commit -m "feat(lot-5): GET /v1/species/:id route"
```

---

## Task 11 : `routes/identifications.ts`

**Files:**
- Create: `src/routes/identifications.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1 : Implémenter `src/routes/identifications.ts`**

```ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import { ExifFormSchema } from '@/schemas/identifications';
import { identifyAndStore } from '@/services/identification';
import { AppError } from '@/utils/errors';
import { JPEG_BODY_LIMIT_BYTES, validateJpeg } from '@/utils/jpeg';

const route = new Hono<AppEnv>();

route.post(
  '/identifications',
  authMiddleware(),
  bodyLimit({
    maxSize: JPEG_BODY_LIMIT_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'File exceeds upload body limit', 413);
    },
  }),
  async (c) => {
    const user = requireUser(c);

    const ct = c.req.header('content-type') ?? '';
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data', 415);
    }

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

    const exifInput: Record<string, string | undefined> = {};
    if (typeof form.date_taken === 'string') exifInput.date_taken = form.date_taken;
    if (typeof form.gps_lat === 'string') exifInput.gps_lat = form.gps_lat;
    if (typeof form.gps_lng === 'string') exifInput.gps_lng = form.gps_lng;

    const parsed = ExifFormSchema.safeParse(exifInput);
    if (!parsed.success) {
      throw new AppError('INVALID_EXIF', 'Invalid EXIF form fields', 400, {
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    const out = await identifyAndStore(user.id, buffer, parsed.data);
    return c.json(out, 201);
  },
);

export default route;
```

- [ ] **Step 2 : Monter dans `src/routes/index.ts`**

```ts
import { Hono } from 'hono';
import health from '@/routes/health';
import identifications from '@/routes/identifications';
import me from '@/routes/me';
import species from '@/routes/species';

export const routes = new Hono();
routes.route('/', health);
routes.route('/', me);
routes.route('/', species);
routes.route('/', identifications);
```

- [ ] **Step 3 : Typecheck**

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4 : Commit**

```bash
git add src/routes/identifications.ts src/routes/index.ts
git commit -m "feat(lot-5): POST /v1/identifications route (multipart, EXIF form fields)"
```

---

## Task 12 : Tests helpers (plantnet, wikipedia, garage specimens)

**Files:**
- Create: `tests/helpers/plantnet.ts`
- Create: `tests/helpers/wikipedia.ts`
- Modify: `tests/helpers/garage.ts`

- [ ] **Step 1 : Créer `tests/helpers/plantnet.ts`**

```ts
import {
  __setPlantnetForTests,
  PlantnetUnavailableError,
  type PlantnetResult,
} from '@/lib/plantnet';

export type MockPlantnetOptions = {
  results?: PlantnetResult[];
  noMatch?: boolean;
  fail?: 'timeout' | 'unavailable' | 'quota';
  raw?: Record<string, unknown>;
};

const DEFAULT_RESULTS: PlantnetResult[] = [
  {
    scientificName: 'Lycoris radiata',
    commonName: 'Amaryllis du Japon',
    family: 'Amaryllidaceae',
    referencePhotoUrl: 'https://bs.plantnet.org/m/x.jpg',
    score: 0.9233,
  },
  {
    scientificName: 'Lycoris × albiflora',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.0099,
  },
  {
    scientificName: 'Lycoris aurea',
    commonName: null,
    family: 'Amaryllidaceae',
    referencePhotoUrl: null,
    score: 0.0061,
  },
];

export function installMockPlantnet(opts: MockPlantnetOptions = {}): () => void {
  if (opts.fail === 'timeout') {
    return __setPlantnetForTests({
      identify: async () => {
        const { PlantnetTimeoutError } = await import('@/lib/plantnet');
        throw new PlantnetTimeoutError();
      },
      identifyRaw: async () => {
        const { PlantnetTimeoutError } = await import('@/lib/plantnet');
        throw new PlantnetTimeoutError();
      },
    });
  }
  if (opts.fail === 'unavailable') {
    return __setPlantnetForTests({
      identify: async () => {
        throw new PlantnetUnavailableError(500);
      },
      identifyRaw: async () => {
        throw new PlantnetUnavailableError(500);
      },
    });
  }
  if (opts.fail === 'quota') {
    return __setPlantnetForTests({
      identify: async () => {
        const { PlantnetQuotaExhaustedError } = await import('@/lib/plantnet');
        throw new PlantnetQuotaExhaustedError();
      },
      identifyRaw: async () => {
        const { PlantnetQuotaExhaustedError } = await import('@/lib/plantnet');
        throw new PlantnetQuotaExhaustedError();
      },
    });
  }
  const results = opts.noMatch ? [] : opts.results ?? DEFAULT_RESULTS;
  return __setPlantnetForTests({
    identify: async () => results,
    identifyRaw: async () => ({ raw: { results, ...(opts.raw ?? {}) } as never, results }),
  });
}
```

- [ ] **Step 2 : Créer `tests/helpers/wikipedia.ts`**

```ts
import { __setWikipediaForTests, type WikiSummary } from '@/lib/wikipedia';

export type MockWikipediaOptions = {
  summary?: WikiSummary | null;
  fail?: boolean;
};

export function installMockWikipedia(opts: MockWikipediaOptions = {}): () => void {
  if (opts.fail) {
    return __setWikipediaForTests({
      fetchSummary: async () => {
        const { WikipediaUnavailableError } = await import('@/lib/wikipedia');
        throw new WikipediaUnavailableError(500);
      },
    });
  }
  const summary = opts.summary === undefined ? null : opts.summary;
  return __setWikipediaForTests({ fetchSummary: async () => summary });
}
```

- [ ] **Step 3 : Étendre `tests/helpers/garage.ts`**

```ts
import { deleteObject, ensureBucket } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const AVATARS_BUCKET = 'avatars';
const SPECIMENS_BUCKET = 'specimens';

let avatarsReady = false;
let specimensReady = false;

export async function setupTestGarage(): Promise<void> {
  if (avatarsReady) return;
  await ensureBucket(AVATARS_BUCKET);
  avatarsReady = true;
}

export async function setupTestSpecimens(): Promise<void> {
  if (specimensReady) return;
  await ensureBucket(SPECIMENS_BUCKET);
  specimensReady = true;
}

export async function cleanupGarageObjects(
  keys: Array<string | { bucket: string; key: string }>,
): Promise<void> {
  await Promise.all(
    keys.map(async (entry) => {
      const { bucket, key } =
        typeof entry === 'string' ? { bucket: AVATARS_BUCKET, key: entry } : entry;
      try {
        await deleteObject({ bucket, key });
      } catch (err) {
        logger.debug({ err, bucket, key }, 'cleanupGarageObjects: ignored');
      }
    }),
  );
}

export const TEST_AVATARS_BUCKET = AVATARS_BUCKET;
export const TEST_SPECIMENS_BUCKET = SPECIMENS_BUCKET;
```

- [ ] **Step 4 : Run tests existants pour vérifier non-régression**

```bash
bun test tests/integration/avatar.test.ts
```

Expected: 9 PASS (la signature `cleanupGarageObjects(keys: string[])` reste compatible).

- [ ] **Step 5 : Commit**

```bash
git add tests/helpers/plantnet.ts tests/helpers/wikipedia.ts tests/helpers/garage.ts
git commit -m "test(lot-5): helpers for plantnet/wikipedia mocking + specimens bucket setup"
```

---

## Task 13 : Integration suite `tests/integration/species.test.ts`

**Files:**
- Create: `tests/integration/species.test.ts`

- [ ] **Step 1 : Écrire la suite**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { species } from '@/db/schema';
import { upsertFromPlantnet } from '@/services/species';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';

let mailer: MockMailerHandle;

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
});
afterEach(() => mailer.restore());

describe('GET /v1/species/:id', () => {
  it('returns 401 without auth', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/species/00000000-0000-7000-8000-000000000000');
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown id', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 's1@example.com',
      password: 'correct-horse-battery-staple',
      name: 'S1',
    });
    const res = await app.request('/v1/species/00000000-0000-7000-8000-000000000000', {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns full species response when description set', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 's2@example.com',
      password: 'correct-horse-battery-staple',
      name: 'S2',
    });
    const { species: sp } = await upsertFromPlantnet({
      scientificName: 'Lycoris radiata',
      commonName: 'Amaryllis du Japon',
      family: 'Amaryllidaceae',
      referencePhotoUrl: 'https://bs.plantnet.org/m/x.jpg',
    });
    await testDb
      .update(species)
      .set({
        description: 'Le lycoris est…',
        wikipediaUrl: 'https://fr.wikipedia.org/wiki/Lycoris_radiata',
        wikipediaFetchedAt: new Date(),
      })
      .where(eq(species.id, sp.id));

    const res = await app.request(`/v1/species/${sp.id}`, {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: sp.id,
      common_name: 'Amaryllis du Japon',
      scientific_name: 'Lycoris radiata',
      family: 'Amaryllidaceae',
      description: 'Le lycoris est…',
      reference_photo_url: 'https://bs.plantnet.org/m/x.jpg',
      wikipedia_url: 'https://fr.wikipedia.org/wiki/Lycoris_radiata',
    });
  });

  it('returns null fields when not yet enriched', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 's3@example.com',
      password: 'correct-horse-battery-staple',
      name: 'S3',
    });
    const { species: sp } = await upsertFromPlantnet({
      scientificName: 'Acer rubrum',
      commonName: null,
      family: 'Sapindaceae',
      referencePhotoUrl: null,
    });

    const res = await app.request(`/v1/species/${sp.id}`, {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.description).toBeNull();
    expect(body.wikipedia_url).toBeNull();
    expect(body.reference_photo_url).toBeNull();
  });
});
```

- [ ] **Step 2 : Run tests (PASS)**

```bash
bun test tests/integration/species.test.ts
```

Expected: 4 PASS.

- [ ] **Step 3 : Commit**

```bash
git add tests/integration/species.test.ts
git commit -m "test(lot-5): integration suite for GET /v1/species/:id"
```

---

## Task 14 : Integration suite `tests/integration/identifications.test.ts`

**Files:**
- Create: `tests/integration/identifications.test.ts`

- [ ] **Step 1 : Écrire la suite**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, plantnetUsage, species } from '@/db/schema';
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

const tinyJpeg = (size = 64): Blob => {
  const buf = new Uint8Array(size);
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
  // Default wiki mock returns null (no enrichment), each test overrides if needed.
  restores.push(installMockWikipedia({ summary: null }));
});
afterEach(async () => {
  mailer.restore();
  while (restores.length) restores.pop()?.();
  await cleanupGarageObjects(createdKeys);
});

async function multipart(photo: Blob, extras: Record<string, string> = {}) {
  const form = new FormData();
  form.append('photo', photo, 'flower.jpg');
  for (const [k, v] of Object.entries(extras)) form.append(k, v);
  return form;
}

describe('POST /v1/identifications', () => {
  it('returns 401 without auth', async () => {
    const app = buildTestApp();
    restores.push(installMockPlantnet());
    const res = await app.request('/v1/identifications', {
      method: 'POST',
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(401);
  });

  it('returns 201 with top + 2 alternatives + auto_pickable=true (high confidence)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-a@example.com',
      password: 'correct-horse-battery-staple',
      name: 'A',
    });
    restores.push(installMockPlantnet());

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      top_match: { scientific_name: string; confidence: number };
      alternatives: unknown[];
      confidence_threshold: number;
      auto_pickable: boolean;
    };
    expect(body.top_match.scientific_name).toBe('Lycoris radiata');
    expect(body.top_match.confidence).toBeCloseTo(0.9233, 4);
    expect(body.alternatives).toHaveLength(2);
    expect(body.confidence_threshold).toBe(0.7);
    expect(body.auto_pickable).toBe(true);

    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${body.id}.jpg` });

    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, body.id));
    expect(ident?.photoStatus).toBe('temp');
    expect(ident?.photoUrl).toBe(`${u.userId}/${body.id}.jpg`);
    expect(ident?.expiresAt).toBeInstanceOf(Date);

    const [usage] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, u.userId));
    expect(usage?.count).toBe(1);

    const speciesRows = await testDb.select().from(species);
    expect(speciesRows.length).toBeGreaterThanOrEqual(3);
  });

  it('returns 201 with auto_pickable=false when top confidence < 0.70', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-b@example.com',
      password: 'correct-horse-battery-staple',
      name: 'B',
    });
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
          {
            scientificName: 'Taxodium distichum',
            commonName: 'Cyprès chauve',
            family: 'Cupressaceae',
            referencePhotoUrl: null,
            score: 0.03,
          },
        ],
      }),
    );

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; auto_pickable: boolean };
    expect(body.auto_pickable).toBe(false);
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${body.id}.jpg` });
  });

  it('returns 422 NO_MATCH when PlantNet returns empty results (no refund)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-c@example.com',
      password: 'correct-horse-battery-staple',
      name: 'C',
    });
    restores.push(installMockPlantnet({ noMatch: true }));

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NO_MATCH');

    const [usage] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, u.userId));
    expect(usage?.count).toBe(1);
  });

  it('returns 429 QUOTA_EXCEEDED when user already at 30/day', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-d@example.com',
      password: 'correct-horse-battery-staple',
      name: 'D',
    });
    restores.push(installMockPlantnet());

    const today = new Date().toISOString().slice(0, 10);
    await testDb.insert(plantnetUsage).values({ userId: u.userId, day: today, count: 30 });

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('returns 502 PLANTNET_UNAVAILABLE on upstream 5xx (refunds quota)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-e@example.com',
      password: 'correct-horse-battery-staple',
      name: 'E',
    });
    restores.push(installMockPlantnet({ fail: 'unavailable' }));

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PLANTNET_UNAVAILABLE');

    const [usage] = await testDb
      .select({ count: plantnetUsage.count })
      .from(plantnetUsage)
      .where(eq(plantnetUsage.userId, u.userId));
    expect(usage?.count ?? 0).toBe(0);
  });

  it('returns 400 INVALID_JPEG when bytes are not JPEG (PNG mislabelled)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-f@example.com',
      password: 'correct-horse-battery-staple',
      name: 'F',
    });
    restores.push(installMockPlantnet());

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append('photo', new Blob([png], { type: 'image/jpeg' }), 'x.jpg');

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JPEG');
  });

  it('returns 400 MISSING_FIELD when photo absent', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-g@example.com',
      password: 'correct-horse-battery-staple',
      name: 'G',
    });
    restores.push(installMockPlantnet());

    const form = new FormData();
    form.append('gps_lat', '48.85');

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_FIELD');
  });

  it('returns 400 INVALID_CONTENT_TYPE when photo type wrong', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-h@example.com',
      password: 'correct-horse-battery-staple',
      name: 'H',
    });
    restores.push(installMockPlantnet());

    const form = new FormData();
    form.append(
      'photo',
      new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/png' }),
      'x.png',
    );

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CONTENT_TYPE');
  });

  it('returns 400 INVALID_EXIF when gps_lat out of range', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-i@example.com',
      password: 'correct-horse-battery-staple',
      name: 'I',
    });
    restores.push(installMockPlantnet());

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg(), { gps_lat: '95' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_EXIF');
  });

  it('persists exif_metadata jsonb when provided', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-j@example.com',
      password: 'correct-horse-battery-staple',
      name: 'J',
    });
    restores.push(installMockPlantnet());

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg(), {
        date_taken: '2026-05-15T10:00:00Z',
        gps_lat: '48.85',
        gps_lng: '2.34',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${body.id}.jpg` });

    const [ident] = await testDb
      .select()
      .from(identifications)
      .where(eq(identifications.id, body.id));
    expect(ident?.exifMetadata).toEqual({
      date_taken: '2026-05-15T10:00:00.000Z',
      gps_lat: 48.85,
      gps_lng: 2.34,
    });
  });

  it('triggers Wikipedia enrichment for newly-created species (background)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'id-k@example.com',
      password: 'correct-horse-battery-staple',
      name: 'K',
    });
    restores.push(installMockPlantnet());
    // Replace default null-mock with a populated summary
    restores.push(
      installMockWikipedia({
        summary: { extract: 'desc', contentUrl: 'https://fr.wikipedia.org/wiki/X' },
      }),
    );

    const res = await app.request('/v1/identifications', {
      method: 'POST',
      headers: bearerHeaders(u.sessionToken),
      body: await multipart(tinyJpeg()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    createdKeys.push({ bucket: TEST_SPECIMENS_BUCKET, key: `${u.userId}/${body.id}.jpg` });

    await new Promise((r) => setTimeout(r, 50));

    const rows = await testDb.select().from(species);
    const enriched = rows.filter((r) => r.wikipediaFetchedAt !== null);
    expect(enriched.length).toBeGreaterThan(0);
    expect(enriched[0]?.description).toBe('desc');
  });
});
```

- [ ] **Step 2 : Run tests (PASS)**

```bash
bun test tests/integration/identifications.test.ts
```

Expected: 12 PASS.

- [ ] **Step 3 : Commit**

```bash
git add tests/integration/identifications.test.ts
git commit -m "test(lot-5): integration suite for POST /v1/identifications"
```

---

## Task 15 : CI update

**Files:**
- Modify: `.github/workflows/ci.yaml`

- [ ] **Step 1 : Ajouter les 2 vars dans la section `env:` du job**

Edit `.github/workflows/ci.yaml`, ajouter sous `GARAGE_REGION: garage` :

```yaml
      PLANTNET_API_KEY: test-key
      WIKIPEDIA_USER_AGENT: "Airbarium/0.1 (ci)"
```

- [ ] **Step 2 : Vérifier le lint**

```bash
bun run lint
```

Expected: PASS (le yaml n'est pas linté par Biome mais le check passe).

- [ ] **Step 3 : Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci(lot-5): PLANTNET_API_KEY + WIKIPEDIA_USER_AGENT in CI env"
```

---

## Task 16 : Verification end-to-end + smoke manuel

- [ ] **Step 1 : Stack propre + migrate**

```bash
docker compose down -v && docker compose up -d
docker compose logs garage-init   # vérifier exit 0
bun run db:migrate
```

- [ ] **Step 2 : Tests complets**

```bash
bun test
```

Expected: toutes les suites vertes (Lot 1-4 existantes + nouvelles Lot 5 : plantnet, wikipedia, quota, species, species-enrichment, identification, schemas/identifications, identifications integration, species integration).

- [ ] **Step 3 : Typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 4 : Smoke `/v1/identifications` réel (PlantNet live)**

Démarrer le serveur dans un terminal séparé :

```bash
bun run dev
```

Dans un autre terminal :

```bash
TOKEN=$(curl -sf -X POST http://localhost:3000/v1/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke-l5@example.com","password":"correct-horse-battery-staple","name":"Smoke"}' \
  | tee /dev/stderr | awk -F'"' '/"token"/ {print $4; exit}')

curl -sf -X POST http://localhost:3000/v1/identifications \
  -H "Authorization: Bearer $TOKEN" \
  -F "photo=@/home/juloow/Downloads/Lycoris_Radiata_red_3__1_4.jpg;type=image/jpeg" \
  -F "gps_lat=48.85" -F "gps_lng=2.34" | jq .
```

Expected: 201 avec `top_match.scientific_name = "Lycoris radiata"`, `auto_pickable: true`, `alternatives.length = 2`. Le champ `description` peut être `null` (Wikipedia s'enrichit en arrière-plan).

```bash
# Vérifier la fiche species (l'id vient de la réponse précédente)
SPECIES_ID=<top_match.species_id>
sleep 1   # laisse le temps à queueMicrotask
curl -sf "http://localhost:3000/v1/species/$SPECIES_ID" -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: 200 avec `description` non-null si Wikipedia a un article pour `Lycoris radiata`.

Tuer le serveur (Ctrl-C).

- [ ] **Step 5 : Skill verify**

```bash
cat .claude/skills/verify/SKILL.md
```

Exécuter sa checklist (typecheck + lint + tests + intégration).

---

## Task 17 : Open PR

- [ ] **Step 1 : Push branch**

```bash
git push -u origin feat/lot-5-identifications
```

- [ ] **Step 2 : `gh pr create`**

```bash
gh pr create --title "feat(lot-5): identifications — PlantNet + species + Wikipedia + quota" --body "$(cat <<'EOF'
## Summary
- `lib/plantnet.ts` + `lib/wikipedia.ts` adapters mockables (singleton + swap pattern)
- `services/quota.ts` atomic UPSERT 30/day/user + refund sur erreurs upstream PlantNet
- `services/species.ts` lazy upsert avec flag `is_new` (xmax = 0)
- `services/species-enrichment.ts` Wikipedia best-effort via `queueMicrotask`
- `services/identification.ts` orchestration end-to-end
- `POST /v1/identifications` (multipart photo + EXIF form fields séparés)
- `GET /v1/species/:id` (fiche enrichie)
- `ensureBucket('specimens')` au boot serveur
- Fixtures réelles PlantNet committées (lycoris haute confidence + blurred basse confidence)
- Spec : `docs/superpowers/specs/2026-06-04-lot-5-identifications-design.md`
- Plan : `docs/superpowers/plans/2026-06-07-lot-5-identifications.md`

## Test plan
- [ ] `bun test` vert (unit + intégration)
- [ ] `bun run typecheck` propre
- [ ] `bun run lint` propre
- [ ] Smoke réel : POST /v1/identifications avec une fleur réelle → top_match correct, auto_pickable selon confidence
- [ ] GET /v1/species/:id retourne description Wikipedia après ~1s
- [ ] Quota 31e appel → 429 QUOTA_EXCEEDED
- [ ] PlantNet down (env `PLANTNET_API_KEY` bidon → 401 PlantNet → 502 côté API) → quota refundé
- [ ] CI verte

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3 : Surveiller CI**

```bash
gh pr checks --watch
```

---

## Critical files reference

Réutilisables sans modification (Lot 1-4) :
- `src/middleware/auth.ts` — `authMiddleware()` + `requireUser(c)`
- `src/middleware/json-body.ts` — pattern Zod (référence, pas utilisé pour multipart)
- `src/middleware/error-handler.ts` — mappe `AppError` → enveloppe `{ error: { code, message, details? } }`
- `src/utils/jpeg.ts` — `validateJpeg` + `JPEG_BODY_LIMIT_BYTES`
- `src/utils/errors.ts` — `AppError`, `NotFoundError`, `UnauthorizedError`, `UnsupportedMediaTypeError`, `ValidationError`
- `src/utils/uuid.ts` — `uuid7()`
- `src/lib/garage.ts` — `ensureBucket`, `putObject`, `getPresignedUrl`, `__setGarageForTests`
- `src/db/client.ts` — `db`, `rawClient`
- `src/db/schema/*.ts` — `species`, `identifications`, `plantnet_usage`, `users` (déjà créés Lot 2)
- `tests/helpers/db.ts` — `setupTestDb`, `truncateAll`, `testDb` (ne PAS appeler `teardownTestDb` depuis un fichier de test)
- `tests/helpers/app.ts` — `buildTestApp`
- `tests/helpers/auth.ts` — `signUpTestUser`, `bearerHeaders`
- `tests/helpers/mailer.ts` — `installMockMailer` (utilisé partout pour empêcher tentatives SMTP réelles)

Nouveaux fichiers à créer (cf. tasks) :
- `src/lib/plantnet.ts`
- `src/lib/wikipedia.ts`
- `src/services/quota.ts`
- `src/services/species.ts`
- `src/services/species-enrichment.ts`
- `src/services/identification.ts`
- `src/routes/identifications.ts`
- `src/routes/species.ts`
- `src/schemas/identifications.ts`

Existants à modifier :
- `src/config/env.ts` — ajout `PLANTNET_API_KEY` + `WIKIPEDIA_USER_AGENT`
- `src/routes/index.ts` — mount des 2 routes
- `src/server.ts` — `ensureBucket('specimens')`
- `tests/helpers/garage.ts` — `setupTestSpecimens` + signature `cleanupGarageObjects` étendue (rétro-compatible)
- `.env.example` — activation des 2 vars
- `.github/workflows/ci.yaml` — vars CI

Fixtures (déjà committées en `34c3ac0`) :
- `tests/fixtures/plantnet_lycoris.json`
- `tests/fixtures/plantnet_blurred.json`

---

## Hors scope explicite (Lot 5)

- Création de `specimens` à partir d'une identification → Lot 6
- Retry `POST /v1/specimens/:id/identify` → Lot 6
- Cleanup cron des `identifications` expirées (`photo_status='temp'` + `expires_at < now()`) → Lot 8
- Cleanup des photos Garage orphelines → Lot 8
- Rate limit global API (600/10min/user) → Lot 8
- Métriques Prometheus PlantNet (avec `remainingIdentificationRequests`) → Lot 8
- Retry Wikipedia via cron pour species avec `wikipedia_fetched_at IS NULL` → Lot 8
- Stockage de `gbif.id` / `powo.id` dans des colonnes species dédiées → V2
