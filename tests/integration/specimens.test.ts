import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens } from '@/db/schema';
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
  // We also supply a `raw` payload shaped like a real PlantNet response so the
  // specimens service can re-derive the candidate pool via
  // `results[].species.scientificNameWithoutAuthor`.
  if (opts.highConfidence === false) {
    const lowResults = [
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
    ];
    restores.push(
      installMockPlantnet({
        results: lowResults,
        raw: {
          results: lowResults.map((r) => ({
            score: r.score,
            species: {
              scientificNameWithoutAuthor: r.scientificName,
              commonNames: r.commonName ? [r.commonName] : [],
              family: { scientificNameWithoutAuthor: r.family ?? '' },
            },
          })),
        },
      }),
    );
  } else {
    const defaultResults = [
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
    restores.push(
      installMockPlantnet({
        results: defaultResults,
        raw: {
          results: defaultResults.map((r) => ({
            score: r.score,
            species: {
              scientificNameWithoutAuthor: r.scientificName,
              commonNames: r.commonName ? [r.commonName] : [],
              family: { scientificNameWithoutAuthor: r.family ?? '' },
            },
          })),
        },
      }),
    );
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
    expect(page1Body.data.map((s) => s.id)).toEqual([ids[2] as string, ids[1] as string]);
    expect(page1Body.next_cursor).not.toBeNull();

    const page2 = await app.request(
      `/v1/specimens?limit=2&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
      { headers: bearerHeaders(u.sessionToken) },
    );
    const page2Body = (await page2.json()) as { data: Array<{ id: string }>; next_cursor: null };
    expect(page2Body.data.map((s) => s.id)).toEqual([ids[0] as string]);
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
