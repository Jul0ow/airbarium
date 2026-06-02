import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { env } from '@/config/env';
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

function extractTokenFromHtml(html: string): string {
  const m = html.match(/reset-password\/([A-Za-z0-9._\-+/=%]+?)(?:\?|"|')/);
  if (!m?.[1]) throw new Error(`no token in: ${html}`);
  return decodeURIComponent(m[1]);
}

describe('forget + reset password round-trip', () => {
  it('lets the user log in with the new password and rejects the old one', async () => {
    const app = buildTestApp();

    await app.request('/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dave@example.com',
        password: 'old-password-1234',
        name: 'Dave',
      }),
    });
    mailer.sent.length = 0;

    const forgetRes = await app.request('/v1/auth/request-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dave@example.com',
        redirectTo: `${env.APP_URL}/reset-password`,
      }),
    });
    expect(forgetRes.status).toBeLessThan(300);

    expect(mailer.sent).toHaveLength(1);
    const captured = mailer.sent[0];
    if (!captured) throw new Error('expected a captured mail');
    const token = extractTokenFromHtml(captured.html);

    const resetRes = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: 'new-password-5678' }),
    });
    expect(resetRes.status).toBe(200);

    const old = await app.request('/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dave@example.com', password: 'old-password-1234' }),
    });
    expect(old.status).toBe(401);

    const fresh = await app.request('/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dave@example.com', password: 'new-password-5678' }),
    });
    expect(fresh.status).toBe(200);
  });
});
