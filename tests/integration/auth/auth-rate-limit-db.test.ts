import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { buildTestApp } from '../../helpers/app';
import { signUpTestUser } from '../../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';
import { installMockMailer, type MockMailerHandle } from '../../helpers/mailer';

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

describe('Better Auth rate-limit DB persistence', () => {
  it('persists a rate-limit row in auth_rate_limit after a sign-in request', async () => {
    const app = buildTestApp();

    // Create a user first so sign-in has something to check against
    await signUpTestUser(app, {
      email: 'alice@example.com',
      password: 'hunter2-battery-staple',
      name: 'Alice',
    });

    // Perform a sign-in (credentials correct — avoids 401 noise, still triggers rate-limit tracking)
    await app.request('/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'hunter2-battery-staple',
      }),
    });

    // BA should have written at least one row to auth_rate_limit
    const rows = await testDb.execute(sql`SELECT id, key, count FROM auth_rate_limit`);
    expect(rows.length).toBeGreaterThan(0);
  });
});
