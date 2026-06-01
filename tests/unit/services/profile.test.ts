import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { users } from '@/db/schema';
import { getMe, updateMe } from '@/services/profile';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('profile service', () => {
  it('getMe returns the profile shape', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: 'g@x', name: 'G' });
    const out = await getMe(id);
    expect(out).toEqual({
      id,
      email: 'g@x',
      email_verified: false,
      name: 'G',
      avatar_url: null,
      created_at: expect.any(String),
    });
  });

  it('updateMe applies name and preserves created_at', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: 'h@x', name: 'OldName' });
    const before = (await getMe(id)).created_at;

    await new Promise((r) => setTimeout(r, 10));
    const out = await updateMe(id, { name: 'NewName' });
    expect(out.name).toBe('NewName');
    expect(out.created_at).toBe(before);
  });
});
