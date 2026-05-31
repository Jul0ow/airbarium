import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildTestApp } from '../helpers/app';
import { setupTestDb, teardownTestDb } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

describe('GET /v1/health', () => {
  it('returns 200 with { status: "ok", db: "ok" } and a generated X-Request-Id', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });

    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('propagates a caller-supplied X-Request-Id', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/health', {
      headers: { 'X-Request-Id': 'deadbeef-1234' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('deadbeef-1234');
  });

  it('returns the envelope-shaped 404 for unknown routes', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
