import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { users } from '@/db/schema';
import { __setGarageForTests } from '@/lib/garage';
import { deleteAvatar, uploadAvatar } from '@/services/photo-storage';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

let restoreGarage: () => void = () => {};
const putCalls: Array<{ bucket: string; key: string; contentType: string }> = [];
const deleteCalls: Array<{ bucket: string; key: string }> = [];

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
  putCalls.length = 0;
  deleteCalls.length = 0;
  restoreGarage = __setGarageForTests({
    putObject: async ({ bucket, key, contentType }) => {
      putCalls.push({ bucket, key, contentType });
    },
    deleteObject: async ({ bucket, key }) => {
      deleteCalls.push({ bucket, key });
    },
    getPresignedUrl: async ({ key }) => `https://stub/${key}?X-Amz-Signature=xxx`,
  });
});

afterEach(() => restoreGarage());

describe('uploadAvatar', () => {
  it('uploads to avatars/<uid>.jpg with image/jpeg and updates db', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'A' });

    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const result = await uploadAvatar(id, buf);

    expect(putCalls).toEqual([{ bucket: 'avatars', key: `${id}.jpg`, contentType: 'image/jpeg' }]);
    expect(result.avatarUrl).toMatch(/X-Amz-Signature=/);
    const [row] = await testDb.select().from(users).where(eq(users.id, id));
    expect(row?.avatarUrl).toBe(`${id}.jpg`);
  });
});

describe('deleteAvatar', () => {
  it('no-op when avatarUrl is already null', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'A' });
    await deleteAvatar(id);
    expect(deleteCalls).toEqual([]);
  });

  it('removes both garage object and db column', async () => {
    const id = uuid7();
    await testDb
      .insert(users)
      .values({ id, email: `${id}@example.com`, name: 'A', avatarUrl: `${id}.jpg` });
    await deleteAvatar(id);
    expect(deleteCalls).toEqual([{ bucket: 'avatars', key: `${id}.jpg` }]);
    const [row] = await testDb.select().from(users).where(eq(users.id, id));
    expect(row?.avatarUrl).toBeNull();
  });

  it('swallows garage error and still clears db column', async () => {
    restoreGarage();
    restoreGarage = __setGarageForTests({
      deleteObject: async () => {
        throw new Error('boom');
      },
    });
    const id = uuid7();
    await testDb
      .insert(users)
      .values({ id, email: `${id}@example.com`, name: 'A', avatarUrl: `${id}.jpg` });
    await deleteAvatar(id);
    const [row] = await testDb.select().from(users).where(eq(users.id, id));
    expect(row?.avatarUrl).toBeNull();
  });
});
