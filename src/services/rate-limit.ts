import { and, eq, gt, sql } from 'drizzle-orm';
import {
  GLOBAL_RATE_LIMIT_BUCKET_MS,
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
} from '@/config/constants';
import { db } from '@/db/client';
import { rateLimit } from '@/db/schema';

export async function checkGlobalRateLimit(
  userId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const key = `global:${userId}`;

  // Floor to the current 1-minute bucket.
  const bucketMs =
    Math.floor(Date.now() / GLOBAL_RATE_LIMIT_BUCKET_MS) * GLOBAL_RATE_LIMIT_BUCKET_MS;
  const bucket = new Date(bucketMs);

  // Atomically upsert and increment the current bucket. The request is
  // counted BEFORE the comparison (increment-then-check), so rejected
  // requests still consume quota.
  await db
    .insert(rateLimit)
    .values({
      key,
      windowStart: bucket,
      count: 1,
      expiresAt: new Date(bucketMs + GLOBAL_RATE_LIMIT_WINDOW_MS),
    })
    .onConflictDoUpdate({
      target: [rateLimit.key, rateLimit.windowStart],
      set: { count: sql`${rateLimit.count} + 1` },
    });

  // Sum counts across all in-window buckets (sliding window).
  const windowCutoff = new Date(Date.now() - GLOBAL_RATE_LIMIT_WINDOW_MS);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${rateLimit.count}), 0)` })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, key), gt(rateLimit.windowStart, windowCutoff)));

  const total = Number(row?.total ?? 0);

  return { allowed: total <= GLOBAL_RATE_LIMIT_MAX, retryAfterSeconds: 60 };
}
