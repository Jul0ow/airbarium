import { and, eq, sql } from 'drizzle-orm';
import { DAILY_PLANTNET_QUOTA } from '@/config/constants';
import { db } from '@/db/client';
import { plantnetUsage } from '@/db/schema';
import { AppError } from '@/utils/errors';

// Quota window is per-UTC-day. Users in non-UTC timezones see the reset at
// midnight UTC, not local midnight — PlantNet's free tier itself has no
// documented timezone, so UTC is the defensible default.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function incrementOrThrow(userId: string): Promise<void> {
  const day = today();

  const [row] = await db
    .insert(plantnetUsage)
    .values({ userId, day, count: 1 })
    .onConflictDoUpdate({
      target: [plantnetUsage.userId, plantnetUsage.day],
      set: { count: sql`${plantnetUsage.count} + 1` },
    })
    .returning({ count: plantnetUsage.count });

  if (!row) throw new Error('quota: insert returned no row');

  if (row.count > DAILY_PLANTNET_QUOTA) {
    await refund(userId);
    throw new AppError(
      'QUOTA_EXCEEDED',
      `Daily PlantNet quota of ${DAILY_PLANTNET_QUOTA} identifications exceeded`,
      429,
      { limit: DAILY_PLANTNET_QUOTA },
    );
  }
}

export async function refund(userId: string): Promise<void> {
  const day = today();
  await db
    .update(plantnetUsage)
    .set({ count: sql`${plantnetUsage.count} - 1` })
    .where(
      and(
        eq(plantnetUsage.userId, userId),
        eq(plantnetUsage.day, day),
        sql`${plantnetUsage.count} > 0`,
      ),
    );
}
