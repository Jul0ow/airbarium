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
