import { eq } from 'drizzle-orm';
import { AVATARS_BUCKET, SPECIMENS_BUCKET } from '@/config/constants';
import { db } from '@/db/client';
import { identifications, rateLimit, specimens, users, verification } from '@/db/schema';
import { deleteObject } from '@/lib/garage';
import { logger } from '@/middleware/logger';

/**
 * RGPD hard delete. Captures every Garage object key inside a transaction
 * BEFORE deleting the user row (the DB cascade wipes specimens, identifications,
 * plantnet_usage, account and session). Garage objects are then purged
 * best-effort OUTSIDE the transaction: failures are logged and swallowed so a
 * Garage outage never rolls back the structured-data deletion.
 */
export async function deleteAccount(userId: string, userEmail: string): Promise<void> {
  // 1. Capture keys + cascade delete, atomically.
  const { specimenKeys, identificationKeys, avatarKey } = await db.transaction(async (tx) => {
    const specimenRows = await tx
      .select({ photoUrl: specimens.photoUrl })
      .from(specimens)
      .where(eq(specimens.userId, userId)); // ALL rows, incl. soft-deleted
    const identificationRows = await tx
      .select({ photoUrl: identifications.photoUrl })
      .from(identifications)
      .where(eq(identifications.userId, userId));
    const [userRow] = await tx
      .select({ avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, userId));

    await tx.delete(verification).where(eq(verification.identifier, userEmail));
    await tx.delete(users).where(eq(users.id, userId));
    // rate_limit rows are keyed by text (`global:<userId>`), with no FK to users,
    // so the user-delete cascade does NOT remove them — explicit delete required.
    await tx.delete(rateLimit).where(eq(rateLimit.key, `global:${userId}`));

    return {
      specimenKeys: specimenRows.map((r) => r.photoUrl),
      identificationKeys: identificationRows.map((r) => r.photoUrl),
      avatarKey: userRow?.avatarUrl ?? null,
    };
  });

  // 2. Best-effort Garage purge, deduplicated, outside the transaction.
  const seen = new Set<string>();
  const targets: Array<{ bucket: string; key: string }> = [];
  for (const key of [...specimenKeys, ...identificationKeys]) {
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({ bucket: SPECIMENS_BUCKET, key });
    }
  }
  if (avatarKey) targets.push({ bucket: AVATARS_BUCKET, key: avatarKey });

  const results = await Promise.allSettled(targets.map((t) => deleteObject(t)));
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      const target = targets[i];
      logger.warn(
        { err: res.reason, bucket: target?.bucket, key: target?.key, userId },
        'account-deletion: garage purge failed',
      );
    }
  });
}
