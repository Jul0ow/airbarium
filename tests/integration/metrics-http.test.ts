import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { register } from '@/lib/metrics';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, truncateAll } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
  register.resetMetrics();
});

describe('HTTP metrics middleware', () => {
  it('labels by matched route pattern, not the raw path (bounded cardinality)', async () => {
    const app = buildTestApp();
    const { sessionToken } = await signUpTestUser(app, {
      email: 'metrics-http@example.test',
      password: 'password1234',
      name: 'Metrics HTTP',
    });
    const headers = bearerHeaders(sessionToken);

    // Two distinct ids on the same parameterized route — both 404 (not found),
    // but the route label must collapse them onto one :id series.
    await app.request('/v1/specimens/0192f000-0000-7000-8000-000000000001', { headers });
    await app.request('/v1/specimens/0192f000-0000-7000-8000-000000000002', { headers });

    const text = await register.metrics();
    const countLine = text
      .split('\n')
      .find(
        (l) =>
          l.startsWith('airbarium_http_request_duration_seconds_count') &&
          l.includes('route="/v1/specimens/:id"'),
      );

    expect(countLine).toBeDefined();
    expect(countLine).toContain('method="GET"');
    expect(countLine).toContain('status_code="404"');
    expect(countLine?.trim().endsWith(' 2')).toBe(true);

    // The raw uuid must never leak into a label (that would explode cardinality).
    expect(text).not.toContain('0192f000-0000-7000-8000-000000000001');
  });
});
