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
