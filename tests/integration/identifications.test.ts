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
