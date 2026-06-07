import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { species, specimens, users } from '@/db/schema';
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
