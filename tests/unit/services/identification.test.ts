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
