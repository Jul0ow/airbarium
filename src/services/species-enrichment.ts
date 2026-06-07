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

  const now = new Date();
  // 404 (summary === null) sets only the marker so the cron retry can stop trying.
  // Success path overwrites description/wikipediaUrl with the fresh values.
  // Importantly: a later 404 must NOT clobber a previously-populated description.
  const update = summary
    ? {
        description: summary.extract,
        wikipediaUrl: summary.contentUrl,
        wikipediaFetchedAt: now,
        updatedAt: now,
      }
    : { wikipediaFetchedAt: now, updatedAt: now };

  await db.update(species).set(update).where(eq(species.id, speciesId));
}

// Pending enrichment tasks, exposed so tests can deterministically await
// completion instead of relying on wall-clock sleeps.
const pending = new Set<Promise<void>>();

export function scheduleEnrichment(speciesId: string): void {
  const task = new Promise<void>((resolve) => {
    queueMicrotask(() => {
      enrichSpecies(speciesId)
        .catch((err) => {
          logger.warn({ err, speciesId }, 'wiki.enrich.failed');
        })
        .finally(() => {
          pending.delete(task);
          resolve();
        });
    });
  });
  pending.add(task);
}

export async function flushPendingEnrichments(): Promise<void> {
  while (pending.size) {
    await Promise.all(pending);
  }
}
