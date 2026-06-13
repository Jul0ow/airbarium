import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __setGarageForTests,
  deleteObject,
  ensureBucket,
  getPresignedUrl,
  listObjects,
  putObject,
} from '@/lib/garage';

describe('lib/garage swap helper', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = null;
  });

  afterEach(() => {
    restore?.();
  });

  it('routes each operation through the swapped impl', async () => {
    const calls: string[] = [];
    restore = __setGarageForTests({
      ensureBucket: async (bucket) => {
        calls.push(`ensure:${bucket}`);
      },
      putObject: async ({ bucket, key }) => {
        calls.push(`put:${bucket}/${key}`);
      },
      deleteObject: async ({ bucket, key }) => {
        calls.push(`delete:${bucket}/${key}`);
      },
      getPresignedUrl: async ({ bucket, key, expiresInSeconds }) => {
        calls.push(`sign:${bucket}/${key}@${expiresInSeconds}`);
        return `stub://${key}`;
      },
    });

    await ensureBucket('b1');
    await putObject({ bucket: 'b1', key: 'k1', body: new Uint8Array(), contentType: 'x' });
    await deleteObject({ bucket: 'b1', key: 'k1' });
    const url = await getPresignedUrl({ bucket: 'b1', key: 'k1', expiresInSeconds: 60 });

    expect(calls).toEqual(['ensure:b1', 'put:b1/k1', 'delete:b1/k1', 'sign:b1/k1@60']);
    expect(url).toBe('stub://k1');
  });

  it('restores the previous impl on cleanup', async () => {
    let firstCalled = false;
    let secondCalled = false;

    const restoreFirst = __setGarageForTests({
      putObject: async () => {
        firstCalled = true;
      },
    });
    const restoreSecond = __setGarageForTests({
      putObject: async () => {
        secondCalled = true;
      },
    });

    await putObject({ bucket: 'b', key: 'k', body: new Uint8Array(), contentType: 'x' });
    expect(secondCalled).toBe(true);
    expect(firstCalled).toBe(false);

    restoreSecond();
    secondCalled = false;
    await putObject({ bucket: 'b', key: 'k', body: new Uint8Array(), contentType: 'x' });
    expect(firstCalled).toBe(true);
    expect(secondCalled).toBe(false);

    restoreFirst();
  });

  it('routes listObjects through the swapped impl', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    restore = __setGarageForTests({
      listObjects: async ({ bucket, prefix }) => {
        return [{ key: `${bucket}/${prefix ?? ''}obj.jpg`, lastModified: stamp }];
      },
    });

    const out = await listObjects({ bucket: 'b1', prefix: 'p/' });
    expect(out).toEqual([{ key: 'b1/p/obj.jpg', lastModified: stamp }]);
  });

  it('merges partial stubs over the previous impl', async () => {
    let putCount = 0;
    let deleteCount = 0;

    const restoreBase = __setGarageForTests({
      putObject: async () => {
        putCount++;
      },
      deleteObject: async () => {
        deleteCount++;
      },
    });

    const restoreOverride = __setGarageForTests({
      deleteObject: async () => {
        throw new Error('overridden');
      },
    });

    await putObject({ bucket: 'b', key: 'k', body: new Uint8Array(), contentType: 'x' });
    expect(putCount).toBe(1);

    await expect(deleteObject({ bucket: 'b', key: 'k' })).rejects.toThrow('overridden');
    expect(deleteCount).toBe(0);

    restoreOverride();
    restoreBase();
  });
});
