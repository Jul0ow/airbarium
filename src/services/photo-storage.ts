import { eq } from 'drizzle-orm';
import { AVATARS_BUCKET, PRESIGNED_URL_TTL_SECONDS } from '@/config/constants';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { deleteObject, getPresignedUrl, putObject } from '@/lib/garage';
import { logger } from '@/middleware/logger';

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
    expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
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
    expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
  });
}
