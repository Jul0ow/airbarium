import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { type User, users } from '@/db/schema';
import { presignAvatar } from '@/services/photo-storage';

export type ProfileResponse = {
  id: string;
  email: string;
  email_verified: boolean;
  name: string;
  avatar_url: string | null;
  created_at: string;
};

async function toResponse(u: User): Promise<ProfileResponse> {
  return {
    id: u.id,
    email: u.email,
    email_verified: u.emailVerified,
    name: u.name,
    avatar_url: u.avatarUrl ? await presignAvatar(u.avatarUrl) : null,
    created_at: u.createdAt.toISOString(),
  };
}

export async function getMe(userId: string): Promise<ProfileResponse> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) throw new Error(`profile.getMe: user ${userId} not found`);
  return toResponse(row);
}

export async function updateMe(
  userId: string,
  patch: { name?: string | undefined },
): Promise<ProfileResponse> {
  const set: { updatedAt: Date; name?: string } = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  const [row] = await db.update(users).set(set).where(eq(users.id, userId)).returning();
  if (!row) throw new Error(`profile.updateMe: user ${userId} not found`);
  return toResponse(row);
}
