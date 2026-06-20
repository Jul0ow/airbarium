import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DAILY_PLANTNET_QUOTA } from '@/config/constants';
import { plantnetUsage, specimens, users } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import { register } from '@/lib/metrics';
import { flushPendingEnrichments } from '@/services/species-enrichment';
import * as service from '@/services/specimens';
import type { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';
import { installMockPlantnet } from '../../helpers/plantnet';
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
          {
            scientificName: 'Acer rubrum',
            commonName: 'Érable',
            family: 'Sapindaceae',
            referencePhotoUrl: null,
            score: 0.21,
          },
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
    await testDb
      .insert(plantnetUsage)
      .values({ userId: uid, day: today, count: DAILY_PLANTNET_QUOTA });
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

  it('concurrent creates with the same id: PK violation recovers to an idempotent replay', async () => {
    // Exercises recoverFromPkViolation: the loser of the insert race hits the
    // specimens_pkey 23505, re-runs the idempotent SELECT and replays instead of
    // surfacing a 500. Exactly one row must exist and exactly one call reports
    // wasCreated.
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    const id = uuid7();

    const [a, b] = await Promise.all([
      service.create(uid, offlineInput(id)),
      service.create(uid, offlineInput(id)),
    ]);

    const created = [a, b].filter((r) => r.wasCreated);
    const replayed = [a, b].filter((r) => !r.wasCreated);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.specimen.id).toBe(id);

    const rows = await testDb.select().from(specimens).where(eq(specimens.id, id));
    expect(rows).toHaveLength(1);
  });
});

describe('service.create offline — sync ingest metric', () => {
  it('records result=identified when PlantNet matches', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet());
    register.resetMetrics();
    await service.create(uid, offlineInput(uuid7()));
    expect(await register.metrics()).toContain(
      'airbarium_sync_ingest_total{result="identified"} 1',
    );
  });

  it('records result=unidentified when identification fails', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ fail: 'timeout' }));
    register.resetMetrics();
    await service.create(uid, offlineInput(uuid7()));
    expect(await register.metrics()).toContain(
      'airbarium_sync_ingest_total{result="unidentified"} 1',
    );
  });
});

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
    await testDb
      .insert(plantnetUsage)
      .values({ userId: uid, day: today, count: DAILY_PLANTNET_QUOTA });
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

  it('502 on PlantNet timeout, quota refunded', async () => {
    const uid = await makeUser();
    restores.push(installMockPlantnet({ fail: 'timeout' }));
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
