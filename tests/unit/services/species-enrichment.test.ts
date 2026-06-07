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
    expect(true).toBe(true);
  });
});
