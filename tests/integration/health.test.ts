import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { __setGarageForTests } from '@/lib/garage';
import { buildTestApp } from '../helpers/app';
import { setupTestDb } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
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

describe('GET /v1/health/ready', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it('returns 200 with db + garage ok when both are reachable', async () => {
    restores.push(__setGarageForTests({ pingGarage: async () => {} }));
    const app = buildTestApp();
    const res = await app.request('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', garage: 'ok' });
  });

  it('returns 503 with garage: "down" when the Garage probe fails', async () => {
    restores.push(
      __setGarageForTests({
        pingGarage: async () => {
          throw new Error('garage unreachable');
        },
      }),
    );
    const app = buildTestApp();
    const res = await app.request('/v1/health/ready');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'degraded', db: 'ok', garage: 'down' });
  });
});
