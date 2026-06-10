import { beforeAll, describe, expect, it } from 'bun:test';
import { getObject, putObject } from '@/lib/garage';
import { cleanupGarageObjects, setupTestSpecimens, TEST_SPECIMENS_BUCKET } from '../helpers/garage';

beforeAll(async () => {
  await setupTestSpecimens();
});

describe('lib/garage getObject', () => {
  it('round-trips bytes put then get', async () => {
    const key = `gettest/${crypto.randomUUID()}.bin`;
    const body = new Uint8Array([1, 2, 3, 4, 5, 0xff, 0xd8, 0xff]);
    await putObject({ bucket: TEST_SPECIMENS_BUCKET, key, body, contentType: 'application/octet-stream' });

    const out = await getObject({ bucket: TEST_SPECIMENS_BUCKET, key });
    expect(Array.from(out)).toEqual(Array.from(body));

    await cleanupGarageObjects([{ bucket: TEST_SPECIMENS_BUCKET, key }]);
  });

  it('throws a NoSuchKey-shaped error for a missing key', async () => {
    let caught: unknown;
    try {
      await getObject({ bucket: TEST_SPECIMENS_BUCKET, key: `missing/${crypto.randomUUID()}.bin` });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const name = (caught as { name?: string }).name;
    expect(name === 'NoSuchKey' || name === 'NotFound').toBe(true);
  });
});
