import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import {
  GLOBAL_RATE_LIMIT_BUCKET_MS,
  GLOBAL_RATE_LIMIT_MAX,
  GLOBAL_RATE_LIMIT_WINDOW_MS,
} from '@/config/constants';
import { rateLimit } from '@/db/schema';
import { authMiddleware } from '@/middleware/auth';
import { errorHandler } from '@/middleware/error-handler';
import { httpLogger } from '@/middleware/logger';
import { globalRateLimit } from '@/middleware/rate-limit';
import { requestId } from '@/middleware/request-id';
import { __setRateLimitForTests } from '@/services/rate-limit';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';

let mailer: MockMailerHandle;

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
});

afterEach(() => {
  mailer.restore();
});

// We deliberately build a minimal app here instead of reusing buildTestApp().
// The goal is to exercise exactly the requestId → httpLogger → authMiddleware →
// globalRateLimit → onError(errorHandler) composition in isolation, on a dedicated
// probe route. buildTestApp() mounts the real routers and has no such route, and
// wrapping a real authenticated route would couple these tests to unrelated handler
// behavior. Do NOT "simplify" this to buildTestApp — it would change what is tested.
function buildRateLimitTestApp() {
  const app = new Hono<AppEnv>();
  app.use('*', requestId());
  app.use('*', httpLogger());
  // Probe route: auth guard → global rate limit → 200
  app.get('/probe', authMiddleware(), globalRateLimit(), (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

// Seed a rate_limit row for a specific key and windowStart bucket with a given count.
// Uses the same floor math as the service so the bucket aligns with real keys.
async function seedBucket(key: string, minutesAgo: number, count: number) {
  const nowMs = Date.now();
  const pastMs =
    Math.floor((nowMs - minutesAgo * GLOBAL_RATE_LIMIT_BUCKET_MS) / GLOBAL_RATE_LIMIT_BUCKET_MS) *
    GLOBAL_RATE_LIMIT_BUCKET_MS;
  const windowStart = new Date(pastMs);
  const expiresAt = new Date(pastMs + GLOBAL_RATE_LIMIT_WINDOW_MS);
  await testDb.insert(rateLimit).values({ key, windowStart, count, expiresAt });
}

describe('globalRateLimit middleware', () => {
  it('allows the request (200) when the user is under the limit', async () => {
    const fullApp = buildTestApp();
    const u = await signUpTestUser(fullApp, {
      email: 'rl-allowed@example.com',
      password: 'correct-horse-battery-staple',
      name: 'RLAllowed',
    });

    // No seeded rows: the service's own current-minute bucket starts at count=1,
    // well under GLOBAL_RATE_LIMIT_MAX → allowed → probe route returns 200.
    const app = buildRateLimitTestApp();
    const res = await app.request('/probe', {
      headers: bearerHeaders(u.sessionToken),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('returns 429 RATE_LIMITED with Retry-After header when limit is exceeded', async () => {
    // Use the real app for sign-up (needs the full middleware stack), then use the
    // minimal test app to fire the probe request.
    const fullApp = buildTestApp();
    const u = await signUpTestUser(fullApp, {
      email: 'rl-blocked@example.com',
      password: 'correct-horse-battery-staple',
      name: 'RLBlocked',
    });

    // Seed GLOBAL_RATE_LIMIT_MAX - 1 hits 2 minutes ago (inside the 10-min window).
    // The service will create a new current-minute bucket with count=1.
    // After the upsert, the window sum will be MAX, so this request is still allowed.
    // We need the sum to EXCEED MAX before the next call, so we seed MAX (not MAX-1)
    // so that the service's own increment pushes the total to MAX+1 → blocked.
    const key = `global:${u.userId}`;
    await seedBucket(key, 2, GLOBAL_RATE_LIMIT_MAX);

    const app = buildRateLimitTestApp();
    const res = await app.request('/probe', {
      headers: bearerHeaders(u.sessionToken),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    // Retry-After header must survive the error handler and appear on the response.
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('allows the request (fail-open) when checkGlobalRateLimit throws', async () => {
    const fullApp = buildTestApp();
    const u = await signUpTestUser(fullApp, {
      email: 'rl-failopen@example.com',
      password: 'correct-horse-battery-staple',
      name: 'RLFailOpen',
    });

    // Replace the impl with one that always throws (simulates DB outage).
    const restore = __setRateLimitForTests({
      checkGlobalRateLimit: async () => {
        throw new Error('simulated DB outage');
      },
    });

    try {
      const app = buildRateLimitTestApp();
      const res = await app.request('/probe', {
        headers: bearerHeaders(u.sessionToken),
      });

      // Fail-open: despite the service throwing, the request must succeed.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      restore();
    }
  });
});
