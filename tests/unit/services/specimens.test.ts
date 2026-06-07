import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, species, specimens, users } from '@/db/schema';
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

async function makeIdentification(
  userId: string,
  opts: { speciesId: string; confidence: number },
): Promise<string> {
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

    const [ident] = await testDb.select().from(identifications).where(eq(identifications.id, idn));
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
    const [ident] = await testDb.select().from(identifications).where(eq(identifications.id, idn));
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
    const sp2 = await makeSpecies('Rosa canina');
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
