import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { env } from '@/config/env';
import { account, users } from '@/db/schema';
import { buildTestApp } from '../../helpers/app';
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

describe('POST /v1/auth/sign-up/email', () => {
  it('creates a user + credential account and sends a verification email', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'correct-horse-battery-staple',
        name: 'Alice',
      }),
    });

    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { user: { email: string; name: string } };
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.name).toBe('Alice');

    const [userRow] = await testDb.select().from(users).where(eq(users.email, 'alice@example.com'));
    expect(userRow).toBeDefined();
    expect(userRow?.emailVerified).toBe(false);

    const [acctRow] = await testDb
      .select()
      .from(account)
      .where(eq(account.userId, userRow?.id ?? ''));
    expect(acctRow?.providerId).toBe('credential');
    expect(acctRow?.password).toBeTruthy();

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('alice@example.com');
    expect(mailer.sent[0]?.html).toContain(env.BETTER_AUTH_URL.replace(/\/$/, ''));
    expect(mailer.sent[0]?.html).toMatch(/verify-email/);
  });

  it('rejects a duplicate email', async () => {
    const app = buildTestApp();
    const payload = {
      email: 'dup@example.com',
      password: 'correct-horse-battery-staple',
      name: 'A',
    };
    await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a short password (BA default policy)', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'short@example.com', password: 'short', name: 'X' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a password shorter than the explicit 10-char minimum', async () => {
    // 9 chars: would pass Better Auth's default min-8, must fail our min-10 policy.
    const app = buildTestApp();
    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nine@example.com', password: 'ninechars', name: 'X' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      await testDb.select().from(users).where(eq(users.email, 'nine@example.com')),
    ).toHaveLength(0);
  });

  it('returns 413 when the auth request body exceeds the 64 KiB limit', async () => {
    const app = buildTestApp();
    const huge = 'a'.repeat(70 * 1024);
    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'big@example.com', password: 'correct-horse', name: huge }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 400 with BA error shape for malformed JSON', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email: "x", "password": "y", "name": "z"}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string; code: string };
    expect(body.code).toBe('INVALID_JSON');
    expect(body.message).toBeTruthy();
  });
});
