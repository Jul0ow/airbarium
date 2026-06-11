import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { identifications, specimens, users } from '@/db/schema';
import { __setGarageForTests, getObject, putObject } from '@/lib/garage';
import { uuid7 } from '@/utils/uuid';
import { buildTestApp } from '../helpers/app';
import { bearerHeaders, signUpTestUser } from '../helpers/auth';
import { setupTestDb, testDb, truncateAll } from '../helpers/db';
import { cleanupGarageObjects, setupTestGarage, setupTestSpecimens } from '../helpers/garage';
import { installMockMailer, type MockMailerHandle } from '../helpers/mailer';

let mailer: MockMailerHandle;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

beforeAll(async () => {
  await setupTestDb();
  await setupTestGarage();
  // Ensures the `specimens` bucket exists so we can put/delete real objects.
  await setupTestSpecimens();
});

beforeEach(async () => {
  await truncateAll();
  mailer = installMockMailer();
});

afterEach(() => mailer.restore());

type ErrorBody = { error: { code: string; message: string } };

async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getObject({ bucket, key });
    return true;
  } catch {
    return false;
  }
}

describe('DELETE /v1/me', () => {
  it('returns 401 without authentication', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/me', { method: 'DELETE' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('hard-deletes the user, cascade rows, and Garage objects', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'doomed@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Doomed',
    });

    // avatar
    const avatarKey = `${u.userId}.jpg`;
    await putObject({ bucket: 'avatars', key: avatarKey, body: JPEG, contentType: 'image/jpeg' });
    await testDb.update(users).set({ avatarUrl: avatarKey }).where(eq(users.id, u.userId));

    // active + soft-deleted specimen, each with a real Garage object
    const activeKey = `${u.userId}/spec-active.jpg`;
    const deletedKey = `${u.userId}/spec-deleted.jpg`;
    const identKey = `${u.userId}/ident.jpg`;
    for (const key of [activeKey, deletedKey, identKey]) {
      await putObject({ bucket: 'specimens', key, body: JPEG, contentType: 'image/jpeg' });
    }
    await testDb.insert(specimens).values([
      { id: uuid7(), userId: u.userId, photoUrl: activeKey, collectedAt: new Date() },
      {
        id: uuid7(),
        userId: u.userId,
        photoUrl: deletedKey,
        collectedAt: new Date(),
        deletedAt: new Date(),
      },
    ]);
    await testDb.insert(identifications).values({
      id: uuid7(),
      userId: u.userId,
      photoUrl: identKey,
      plantnetRawResponse: { results: [] },
    });

    const res = await app.request('/v1/me', {
      method: 'DELETE',
      headers: bearerHeaders(u.sessionToken),
    });
    expect(res.status).toBe(204);

    // DB purged (cascade)
    expect(await testDb.select().from(users).where(eq(users.id, u.userId))).toHaveLength(0);
    expect(
      await testDb.select().from(specimens).where(eq(specimens.userId, u.userId)),
    ).toHaveLength(0);
    expect(
      await testDb.select().from(identifications).where(eq(identifications.userId, u.userId)),
    ).toHaveLength(0);

    // Garage purged
    expect(await objectExists('avatars', avatarKey)).toBe(false);
    expect(await objectExists('specimens', activeKey)).toBe(false);
    expect(await objectExists('specimens', deletedKey)).toBe(false);
    expect(await objectExists('specimens', identKey)).toBe(false);

    // session invalid afterwards
    const after = await app.request('/v1/me', { headers: bearerHeaders(u.sessionToken) });
    expect(after.status).toBe(401);
  });

  it('still returns 204 and purges the DB when Garage delete fails', async () => {
    const app = buildTestApp();
    const u = await signUpTestUser(app, {
      email: 'garagedown@example.com',
      password: 'correct-horse-battery-staple',
      name: 'GarageDown',
    });
    const key = `${u.userId}/spec.jpg`;
    await putObject({ bucket: 'specimens', key, body: JPEG, contentType: 'image/jpeg' });
    await testDb
      .insert(specimens)
      .values({ id: uuid7(), userId: u.userId, photoUrl: key, collectedAt: new Date() });

    const restore = __setGarageForTests({
      deleteObject: async () => {
        throw new Error('garage down');
      },
    });
    try {
      const res = await app.request('/v1/me', {
        method: 'DELETE',
        headers: bearerHeaders(u.sessionToken),
      });
      expect(res.status).toBe(204);
      expect(await testDb.select().from(users).where(eq(users.id, u.userId))).toHaveLength(0);
    } finally {
      restore();
      await cleanupGarageObjects([{ bucket: 'specimens', key }]);
    }
  });

  it('does not touch another user’s data', async () => {
    const app = buildTestApp();
    const victim = await signUpTestUser(app, {
      email: 'victim@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Victim',
    });
    const bystander = await signUpTestUser(app, {
      email: 'bystander@example.com',
      password: 'correct-horse-battery-staple',
      name: 'Bystander',
    });

    const res = await app.request('/v1/me', {
      method: 'DELETE',
      headers: bearerHeaders(victim.sessionToken),
    });
    expect(res.status).toBe(204);

    expect(await testDb.select().from(users).where(eq(users.id, bystander.userId))).toHaveLength(1);
    const ok = await app.request('/v1/me', { headers: bearerHeaders(bystander.sessionToken) });
    expect(ok.status).toBe(200);
  });
});
