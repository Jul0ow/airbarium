import { deleteObject, ensureBucket } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const AVATARS_BUCKET = 'avatars';

let setupDone = false;

export async function setupTestGarage(): Promise<void> {
  if (setupDone) return;
  await ensureBucket(AVATARS_BUCKET);
  setupDone = true;
}

// Errors are swallowed: avatar keys are deterministic per user-id (UUIDv7),
// so a leaked object cannot collide with a future test. Failing here would
// mask the real test result.
export async function cleanupGarageObjects(keys: string[]): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        await deleteObject({ bucket: AVATARS_BUCKET, key });
      } catch (err) {
        logger.debug({ err, key }, 'cleanupGarageObjects: ignored');
      }
    }),
  );
}

export const TEST_AVATARS_BUCKET = AVATARS_BUCKET;
