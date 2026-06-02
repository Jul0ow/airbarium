import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp } from '../../helpers/app';
import { setupTestDb, truncateAll } from '../../helpers/db';
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

async function signUp(app: ReturnType<typeof buildTestApp>) {
  await app.request('/v1/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'bob@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Bob',
    }),
  });
}

describe('POST /v1/auth/sign-in/email', () => {
  it('returns 200 with Set-Cookie and body.token on correct credentials', async () => {
    const app = buildTestApp();
    await signUp(app);

    const res = await app.request('/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@example.com',
        password: 'correct-horse-battery-staple',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);

    const body = (await res.json()) as {
      token?: string;
      session?: { token?: string };
    };
    const bearer = res.headers.get('set-auth-token') ?? body.token ?? body.session?.token;
    expect(bearer).toBeTruthy();
  });

  it('returns 401 on wrong password', async () => {
    const app = buildTestApp();
    await signUp(app);

    const res = await app.request('/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'wrong-password' }),
    });

    expect(res.status).toBe(401);
  });

  it('rate-limits after 10 failures in the window', async () => {
    const app = buildTestApp();
    await signUp(app);

    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.request('/v1/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.42' },
        body: JSON.stringify({ email: 'bob@example.com', password: `wrong-${i}` }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
