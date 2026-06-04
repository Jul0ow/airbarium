import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { deleteObject, getPresignedUrl, putObject } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const AVATARS_BUCKET = 'avatars';
const PRESIGN_TTL = 3600;

function avatarKey(userId: string): string {
  return `${userId}.jpg`;
}

export async function uploadAvatar(
  userId: string,
  buffer: Uint8Array,
): Promise<{ avatarUrl: string }> {
  const key = avatarKey(userId);
  await putObject({ bucket: AVATARS_BUCKET, key, body: buffer, contentType: 'image/jpeg' });
  await db.update(users).set({ avatarUrl: key, updatedAt: new Date() }).where(eq(users.id, userId));
  const avatarUrl = await getPresignedUrl({
    bucket: AVATARS_BUCKET,
    key,
    expiresInSeconds: PRESIGN_TTL,
  });
  return { avatarUrl };
}

export async function deleteAvatar(userId: string): Promise<void> {
  const [row] = await db
    .select({ avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return;
  if (row.avatarUrl) {
    try {
      await deleteObject({ bucket: AVATARS_BUCKET, key: row.avatarUrl });
    } catch (err) {
      logger.warn({ err, userId }, 'photo-storage.deleteAvatar: garage delete failed');
    }
    await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }
}

export async function presignAvatar(userId: string): Promise<string> {
  return getPresignedUrl({
    bucket: AVATARS_BUCKET,
    key: avatarKey(userId),
    expiresInSeconds: PRESIGN_TTL,
  });
}
