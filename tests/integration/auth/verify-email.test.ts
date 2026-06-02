import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { users } from '@/db/schema';
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

function extractTokenFromHtml(html: string): string {
  const m = html.match(/token=([A-Za-z0-9._\-+/=%]+)/);
  if (!m?.[1]) throw new Error(`no token in: ${html}`);
  return decodeURIComponent(m[1]);
}

describe('GET /v1/auth/verify-email', () => {
  it('flips users.email_verified when the token is valid', async () => {
    const app = buildTestApp();

    await signUpTestUser(app, {
      email: 'carol@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Carol',
    });

    expect(mailer.sent).toHaveLength(1);
    const captured = mailer.sent[0];
    if (!captured) throw new Error('expected a captured mail');
    const token = extractTokenFromHtml(captured.html);

    const res = await app.request(`/v1/auth/verify-email?token=${encodeURIComponent(token)}`, {
      method: 'GET',
    });

    expect(res.status).toBeLessThan(400);

    const [u] = await testDb.select().from(users).where(eq(users.email, 'carol@example.com'));
    expect(u?.emailVerified).toBe(true);
  });

  it('rejects an obviously bad token', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/auth/verify-email?token=not-a-real-token', {
      method: 'GET',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
