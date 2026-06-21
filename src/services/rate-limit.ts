import { sql } from 'drizzle-orm';
import {
  GLOBAL_RATE_LIMIT_BUCKET_MS,
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
} from '@/config/constants';
import { db } from '@/db/client';

type CheckFn = (userId: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

type Impl = {
  checkGlobalRateLimit: CheckFn;
};

const defaultImpl: Impl = {
  async checkGlobalRateLimit(userId) {
    const key = `global:${userId}`;

    // Floor to the current 1-minute bucket.
    const bucketMs =
      Math.floor(Date.now() / GLOBAL_RATE_LIMIT_BUCKET_MS) * GLOBAL_RATE_LIMIT_BUCKET_MS;
    const bucket = new Date(bucketMs);

    const expiresAt = new Date(bucketMs + GLOBAL_RATE_LIMIT_WINDOW_MS);
    const windowCutoff = new Date(Date.now() - GLOBAL_RATE_LIMIT_WINDOW_MS);

    // Single round-trip: increment-then-check across the sliding window.
    //
    // A data-modifying CTE's write is NOT visible to the same statement's reads
    // (the SELECT sees the pre-statement snapshot). So we take the current
    // bucket's POST-increment value from the upsert's RETURNING, and add only
    // the OTHER in-window buckets read from the table. Sum == post-increment
    // total — identical semantics to the previous two-statement version (the
    // request is counted before the comparison; rejected requests still consume
    // quota), but one DB round-trip instead of two. Do NOT collapse this into a
    // plain `SELECT sum(...)` over the table inside the CTE: it would miss this
    // request's own increment and flip the guardrail to over-allow.
    // Dates are passed as ISO strings with explicit ::timestamptz casts: raw
    // db.execute has no column-type context, so drizzle/postgres-js can't bind a
    // Date directly here (unlike the typed query builder).
    const bucketIso = bucket.toISOString();
    const rows = await db.execute<{ total: string }>(sql`
      WITH up AS (
        INSERT INTO rate_limit (key, window_start, count, expires_at)
        VALUES (${key}, ${bucketIso}::timestamptz, 1, ${expiresAt.toISOString()}::timestamptz)
        ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit.count + 1
        RETURNING count
      )
      SELECT (
        (SELECT count FROM up)
        + coalesce((
            SELECT sum(count) FROM rate_limit
            WHERE key = ${key}
              AND window_start > ${windowCutoff.toISOString()}::timestamptz
              AND window_start <> ${bucketIso}::timestamptz
          ), 0)
      )::text AS total
    `);

    const total = Number(rows[0]?.total ?? 0);

    // `total` is POST-increment (it includes this request). `<=` is therefore
    // correct: when total == MAX this request is the MAX-th and is allowed; the
    // MAX+1-th request is the first to be rejected.
    return { allowed: total <= GLOBAL_RATE_LIMIT_MAX, retryAfterSeconds: 60 };
  },
};

let impl: Impl = defaultImpl;

export const checkGlobalRateLimit: CheckFn = (userId) => impl.checkGlobalRateLimit(userId);

export function __setRateLimitForTests(stub: Partial<Impl>): () => void {
  const prev = impl;
  impl = { ...impl, ...stub };
  return () => {
    impl = prev;
  };
}
