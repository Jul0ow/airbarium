import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  GLOBAL_RATE_LIMIT_BUCKET_MS,
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
} from '@/config/constants';
import { rateLimit } from '@/db/schema';
import { checkGlobalRateLimit } from '@/services/rate-limit';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

// Helper: seed a rate_limit row for a specific key, a given number of
// minutes in the past (must be > 0 to avoid collision with the function's
// own current-minute bucket), with a given count.
async function seedBucket(key: string, minutesAgo: number, count: number) {
  // Place the windowStart a fixed number of whole minutes in the past,
  // floored to GLOBAL_RATE_LIMIT_BUCKET_MS so it matches the real bucketing math.
  const nowMs = Date.now();
  const pastMs =
    Math.floor((nowMs - minutesAgo * GLOBAL_RATE_LIMIT_BUCKET_MS) / GLOBAL_RATE_LIMIT_BUCKET_MS) *
    GLOBAL_RATE_LIMIT_BUCKET_MS;
  const windowStart = new Date(pastMs);
  const expiresAt = new Date(pastMs + GLOBAL_RATE_LIMIT_WINDOW_MS);
  await testDb.insert(rateLimit).values({ key, windowStart, count, expiresAt });
}

describe('checkGlobalRateLimit', () => {
  it('allows a request when total is at the limit (GLOBAL_RATE_LIMIT_MAX)', async () => {
    const userA = 'user-a';
    const key = `global:${userA}`;

    // Seed 599 requests in a past in-window bucket (2 minutes ago, well within 10-min window).
    // The function will create/increment its own current-minute bucket (+1 → total 600).
    await seedBucket(key, 2, GLOBAL_RATE_LIMIT_MAX - 1);

    const result = await checkGlobalRateLimit(userA);

    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it('blocks a request when total exceeds GLOBAL_RATE_LIMIT_MAX', async () => {
    const userA = 'user-a';
    const key = `global:${userA}`;

    // Seed 599 in past bucket; first call → 600 (allowed). Second call → 601 (blocked).
    await seedBucket(key, 2, GLOBAL_RATE_LIMIT_MAX - 1);

    const first = await checkGlobalRateLimit(userA);
    expect(first.allowed).toBe(true);

    const second = await checkGlobalRateLimit(userA);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBe(60);
  });

  it('excludes buckets older than GLOBAL_RATE_LIMIT_WINDOW_MS from the sum', async () => {
    const userId = 'user-stale';
    const key = `global:${userId}`;

    // Seed a stale bucket (15 minutes ago → outside 10-min window) with a huge count.
    await seedBucket(key, 15, 5000);

    // The function's current-minute bucket will be created with count=1 → total 1 → allowed.
    const result = await checkGlobalRateLimit(userId);

    expect(result.allowed).toBe(true);
  });

  it('does not let a saturated userA affect userB', async () => {
    const userA = 'user-iso-a';
    const userB = 'user-iso-b';
    const keyA = `global:${userA}`;

    // Saturate userA well above the limit.
    await seedBucket(keyA, 2, GLOBAL_RATE_LIMIT_MAX + 1000);

    // userB has no rows at all → first call creates bucket with count 1 → allowed.
    const result = await checkGlobalRateLimit(userB);

    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(60);
  });
});
