import { deleteObject, ensureBucket } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const AVATARS_BUCKET = 'avatars';
const SPECIMENS_BUCKET = 'specimens';

let avatarsReady = false;
let specimensReady = false;

export async function setupTestGarage(): Promise<void> {
  if (avatarsReady) return;
  await ensureBucket(AVATARS_BUCKET);
  avatarsReady = true;
}

export async function setupTestSpecimens(): Promise<void> {
  if (specimensReady) return;
  await ensureBucket(SPECIMENS_BUCKET);
  specimensReady = true;
}

// Errors are swallowed: keys are deterministic per UUID, so a leaked object
// cannot collide with a future test. Failing here would mask the real test
// result. Pass plain strings to target the avatars bucket (back-compat), or
// { bucket, key } tuples to target a specific bucket.
export async function cleanupGarageObjects(
  keys: Array<string | { bucket: string; key: string }>,
): Promise<void> {
  await Promise.all(
    keys.map(async (entry) => {
      const { bucket, key } =
        typeof entry === 'string' ? { bucket: AVATARS_BUCKET, key: entry } : entry;
      try {
        await deleteObject({ bucket, key });
      } catch (err) {
        logger.debug({ err, bucket, key }, 'cleanupGarageObjects: ignored');
      }
    }),
  );
}

export const TEST_AVATARS_BUCKET = AVATARS_BUCKET;
export const TEST_SPECIMENS_BUCKET = SPECIMENS_BUCKET;
