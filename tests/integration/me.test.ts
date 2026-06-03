import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, truncateAll } from '../helpers/db';
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

type ProfileBody = {
  id: string;
  email: string;
  email_verified: boolean;
  name: string;
  avatar_url: string | null;
  created_at: string;
};

type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

describe('GET /v1/me', () => {
  it('returns 401 without authentication', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the profile when authenticated via Bearer', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'eve@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Eve',
    });

    const res = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;
    expect(body).toEqual({
      id: u.userId,
      email: 'eve@example.com',
      email_verified: false,
      name: 'Eve',
      avatar_url: null,
      created_at: expect.any(String),
    });
  });

  it('returns the profile when authenticated via cookie', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'frank@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Frank',
    });

    const res = await app.request('/v1/me', { headers: { Cookie: u.cookieHeader } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;
    expect(body.email).toBe('frank@example.com');
  });
});

describe('PATCH /v1/me', () => {
  it('updates name and returns the new profile', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'grace@example.com',
      password: 'correct-horse-battery-staple',
      name: 'GraceOld',
    });

    const res = await app.request('/v1/me', {
      method: 'PATCH',
      headers: {
        ...bearerHeaders(u.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '  GraceNew  ' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;
    expect(body.name).toBe('GraceNew');

    const reread = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    const rebody = (await reread.json()) as ProfileBody;
    expect(rebody.name).toBe('GraceNew');
  });

  it('rejects an empty name with 400 in our error envelope', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'henry@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Henry',
    });

    const res = await app.request('/v1/me', {
      method: 'PATCH',
      headers: {
        ...bearerHeaders(u.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: '   ' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBeTruthy();
    expect(body.error.details).toBeDefined();
  });

  it('rejects a non-JSON content-type with 415', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'kate@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Kate',
    });

    const res = await app.request('/v1/me', {
      method: 'PATCH',
      headers: {
        ...bearerHeaders(u.sessionToken),
        'Content-Type': 'text/plain',
      },
      body: 'name=Kate2',
    });

    expect(res.status).toBe(415);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects a missing content-type with 415', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'leo@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Leo',
    });

    const res = await app.request('/v1/me', {
      method: 'PATCH',
      headers: bearerHeaders(u.sessionToken),
      body: JSON.stringify({ name: 'Leo2' }),
    });

    expect(res.status).toBe(415);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('ignores unknown fields silently', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'ivy@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Ivy',
    });

    const res = await app.request('/v1/me', {
      method: 'PATCH',
      headers: {
        ...bearerHeaders(u.sessionToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Ivy2',
        email: 'new@example.com',
        avatar_url: 'http://x/x.jpg',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileBody;
    expect(body.name).toBe('Ivy2');
    expect(body.email).toBe('ivy@example.com');
    expect(body.avatar_url).toBeNull();
  });
});
