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

  // Sum counts across all in-window buckets (sliding window). This is a
  // SEPARATE statement from the upsert above — unlike quota.ts, we cannot use
  // .returning() to decide here, because the decision spans multiple bucket
  // rows, not one. The tiny gap between increment and SELECT is a deliberate,
  // bounded TOCTOU: under concurrency a request may observe siblings' counts
  // and over-reject slightly, which is the safe direction for a guardrail and
  // negligible at MVP volume. Do not "fix" this by cargo-culting .returning().
  const windowCutoff = new Date(Date.now() - GLOBAL_RATE_LIMIT_WINDOW_MS);
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${rateLimit.count}), 0)` })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, key), gt(rateLimit.windowStart, windowCutoff)));

  const total = Number(row?.total ?? 0);

  // `total` is POST-increment (it includes this request). `<=` is therefore
  // correct: when total == MAX this request is the MAX-th and is allowed; the
  // MAX+1-th request is the first to be rejected.
  return { allowed: total <= GLOBAL_RATE_LIMIT_MAX, retryAfterSeconds: 60 };
}
