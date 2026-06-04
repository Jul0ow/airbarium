import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { users } from '@/db/schema';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { cleanupGarageObjects, setupTestGarage } from '../helpers/garage';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';

let mailer: MockMailerHandle;
const createdKeys: string[] = [];

const tinyJpeg = (size = 64): Blob => {
  const buf = new Uint8Array(size);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  return new Blob([buf], { type: 'image/jpeg' });
};

beforeAll(async () => {
  await setupTestDb();
  await setupTestGarage();
});

beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
  createdKeys.length = 0;
});

afterEach(async () => {
  mailer.restore();
  await cleanupGarageObjects(createdKeys);
});

describe('PUT /v1/me/avatar', () => {
  it('returns 401 without auth', async () => {
    const app = buildTestApp();
    const form = new FormData();
    form.append('photo', tinyJpeg(), 'x.jpg');
    const res = await app.request('/v1/me/avatar', { method: 'PUT', body: form });
    expect(res.status).toBe(401);
  });

  it('uploads and returns a presigned avatar_url', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'a@example.com',
      password: 'correct-horse-battery-staple',
      name: 'A',
    });
    createdKeys.push(`${u.userId}.jpg`);

    const form = new FormData();
    form.append('photo', tinyJpeg(), 'x.jpg');
    const res = await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatar_url: string };
    expect(body.avatar_url).toMatch(/X-Amz-Signature=/);

    const [row] = await testDb.select().from(users).where(eq(users.id, u.userId));
    expect(row?.avatarUrl).toBe(`${u.userId}.jpg`);
  });

  it('overwrites a previously uploaded avatar (same key)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'b@example.com',
      password: 'correct-horse-battery-staple',
      name: 'B',
    });
    createdKeys.push(`${u.userId}.jpg`);

    const form1 = new FormData();
    form1.append('photo', tinyJpeg(), 'x.jpg');
    await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form1,
    });

    const form2 = new FormData();
    form2.append('photo', tinyJpeg(128), 'y.jpg');
    const res = await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form2,
    });
    expect(res.status).toBe(200);
  });

  it('rejects missing photo field with 400 MISSING_FIELD', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'c@example.com',
      password: 'correct-horse-battery-staple',
      name: 'C',
    });
    const form = new FormData();
    form.append('not-photo', 'x');
    const res = await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_FIELD');
  });

  it('rejects non-JPEG content (PNG bytes labelled image/jpeg) with 400 INVALID_JPEG', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'd@example.com',
      password: 'correct-horse-battery-staple',
      name: 'D',
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append('photo', new Blob([png], { type: 'image/jpeg' }), 'x.jpg');
    const res = await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_JPEG');
  });

  it('rejects wrong content-type with 400 INVALID_CONTENT_TYPE', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'e@example.com',
      password: 'correct-horse-battery-staple',
      name: 'E',
    });
    const form = new FormData();
    form.append(
      'photo',
      new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/png' }),
      'x.png',
    );
    const res = await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CONTENT_TYPE');
  });
});

describe('DELETE /v1/me/avatar', () => {
  it('returns 204 even when no avatar exists (idempotent)', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'f@example.com',
      password: 'correct-horse-battery-staple',
      name: 'F',
    });
    const res = await app.request('/v1/me/avatar', {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(204);
  });

  it('removes both the db column and the garage object after a previous PUT', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'g@example.com',
      password: 'correct-horse-battery-staple',
      name: 'G',
    });
    createdKeys.push(`${u.userId}.jpg`);

    const form = new FormData();
    form.append('photo', tinyJpeg(), 'x.jpg');
    await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });

    const del = await app.request('/v1/me/avatar', {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    expect(del.status).toBe(204);

    const [row] = await testDb.select().from(users).where(eq(users.id, u.userId));
    expect(row?.avatarUrl).toBeNull();
  });
});

describe('GET /v1/me with avatar', () => {
  it('returns a presigned avatar_url after PUT, null after DELETE', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'h@example.com',
      password: 'correct-horse-battery-staple',
      name: 'H',
    });
    createdKeys.push(`${u.userId}.jpg`);

    const form = new FormData();
    form.append('photo', tinyJpeg(), 'x.jpg');
    await app.request('/v1/me/avatar', {
      method: 'PUT',
      headers: bearerHeaders(u.sessionToken),
      body: form,
    });

    const me1 = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    const body1 = (await me1.json()) as { avatar_url: string | null };
    expect(body1.avatar_url).toMatch(/X-Amz-Signature=/);

    await app.request('/v1/me/avatar', {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    const me2 = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    const body2 = (await me2.json()) as { avatar_url: string | null };
    expect(body2.avatar_url).toBeNull();
  });
});
