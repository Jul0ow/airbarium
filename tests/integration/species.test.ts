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

  it('returns 404 SPECIES_NOT_FOUND for a malformed (non-UUID) id', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 's-bad@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Sbad',
    });
    // A non-UUID id must be rejected at the route (404), never reach the uuid
    // column (which would raise Postgres 22P02 -> 500).
    const res = await app.request('/v1/species/not-a-uuid', {
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SPECIES_NOT_FOUND');
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
