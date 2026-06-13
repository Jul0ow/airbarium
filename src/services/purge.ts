import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import {
  AUTH_RATE_LIMIT_MAX_WINDOW_MS,
  AVATARS_BUCKET,
  ORPHAN_GRACE_MS,
  PLANTNET_USAGE_RETENTION_DAYS,
  SPECIMEN_SOFT_DELETE_RETENTION_DAYS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
import { db } from '@/db/client';
import {
  authRateLimit,
  identifications,
  plantnetUsage,
  rateLimit,
  specimens,
  users,
} from '@/db/schema';
import { deleteObject, listObjects } from '@/lib/garage';
import { logger } from '@/middleware/logger';

export type CategoryResult = {
  rowsDeleted: number;
  garageDeleted: number;
  garageFailed: number;
  errored: boolean;
};

function newCategoryResult(): CategoryResult {
  return { rowsDeleted: 0, garageDeleted: 0, garageFailed: 0, errored: false };
}

// Best-effort delete of the given keys in one bucket. Failures are logged and
// counted, never thrown — a Garage outage must not fail the purge.
async function purgeGarageKeys(bucket: string, keys: string[], res: CategoryResult): Promise<void> {
  const settled = await Promise.allSettled(keys.map((key) => deleteObject({ bucket, key })));
  keys.forEach((key, i) => {
    const s = settled[i];
    if (!s) return;
    if (s.status === 'fulfilled') {
      res.garageDeleted++;
    } else {
      res.garageFailed++;
      logger.warn({ err: s.reason, bucket, key }, 'cron.purge: garage delete failed');
    }
  });
}

export async function purgeExpiredIdentifications(): Promise<CategoryResult> {
  const res = newCategoryResult();
  let keys: string[];
  try {
    const rows = await db
      .delete(identifications)
      .where(
        and(eq(identifications.photoStatus, 'temp'), lt(identifications.expiresAt, sql`now()`)),
      )
      .returning({ photoUrl: identifications.photoUrl });
    keys = rows.map((r) => r.photoUrl);
    res.rowsDeleted = keys.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeExpiredIdentifications: db delete failed');
    return res;
  }
  await purgeGarageKeys(SPECIMENS_BUCKET, keys, res);
  return res;
}

export async function purgeOldSoftDeletedSpecimens(): Promise<CategoryResult> {
  const res = newCategoryResult();
  let keys: string[];
  try {
    const rows = await db
      .delete(specimens)
      .where(
        and(
          isNotNull(specimens.deletedAt),
          lt(
            specimens.deletedAt,
            sql`now() - (interval '1 day' * ${SPECIMEN_SOFT_DELETE_RETENTION_DAYS})`,
          ),
        ),
      )
      .returning({ photoUrl: specimens.photoUrl });
    keys = rows.map((r) => r.photoUrl);
    res.rowsDeleted = keys.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeOldSoftDeletedSpecimens: db delete failed');
    return res;
  }
  await purgeGarageKeys(SPECIMENS_BUCKET, keys, res);
  return res;
}

export async function purgeOldPlantnetUsage(): Promise<CategoryResult> {
  const res = newCategoryResult();
  try {
    const rows = await db
      .delete(plantnetUsage)
      .where(
        lt(
          plantnetUsage.day,
          sql`current_date - (interval '1 day' * ${PLANTNET_USAGE_RETENTION_DAYS})`,
        ),
      )
      .returning({ day: plantnetUsage.day });
    res.rowsDeleted = rows.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeOldPlantnetUsage: db delete failed');
  }
  return res;
}

export async function purgeExpiredRateLimits(): Promise<CategoryResult> {
  const res = newCategoryResult();
  try {
    const rows = await db
      .delete(rateLimit)
      .where(lt(rateLimit.expiresAt, sql`now()`))
      .returning({ key: rateLimit.key });
    res.rowsDeleted = rows.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeExpiredRateLimits: db delete failed');
  }
  return res;
}

export async function purgeStaleAuthRateLimits(): Promise<CategoryResult> {
  const res = newCategoryResult();
  try {
    // lastRequest is bigint({ mode: 'number' }); epoch-ms (~1.75e12) stays well
    // within JS safe-integer range (~9e15), so this number↔bigint comparison is
    // exact for decades. cutoff is therefore a safe integer too.
    const cutoff = Date.now() - AUTH_RATE_LIMIT_MAX_WINDOW_MS;
    const rows = await db
      .delete(authRateLimit)
      .where(lt(authRateLimit.lastRequest, cutoff))
      .returning({ id: authRateLimit.id });
    res.rowsDeleted = rows.length;
  } catch (err) {
    res.errored = true;
    logger.error({ err }, 'cron.purgeStaleAuthRateLimits: db delete failed');
  }
  return res;
}

export type ReconcileResult = {
  scanned: number;
  orphansDeleted: number;
  garageFailed: number;
  errored: boolean;
};

// Reconcile orphaned Garage objects: objects whose key is referenced by no DB
// row. Runs AFTER the purges, so freshly-purged objects are already gone and we
// only catch true orphans (failed purge/account-deletion deletes, aborted
// temp->promoted renames). A grace window protects in-flight uploads.
export async function reconcileOrphans(): Promise<ReconcileResult> {
  const res: ReconcileResult = { scanned: 0, orphansDeleted: 0, garageFailed: 0, errored: false };
  const now = Date.now();

  let buckets: Array<{ bucket: string; refs: Set<string> }>;
  try {
    const [specimenRows, identRows, avatarRows] = await Promise.all([
      db.select({ k: specimens.photoUrl }).from(specimens),
      db.select({ k: identifications.photoUrl }).from(identifications),
      db.select({ k: users.avatarUrl }).from(users).where(isNotNull(users.avatarUrl)),
    ]);
    // Both specimen photos and identification photos live in the `specimens`
    // bucket, so their keys share one reference set.
    const specimensBucketRefs = new Set<string>([...specimenRows, ...identRows].map((r) => r.k));
    const avatarsRefs = new Set<string>(avatarRows.map((r) => r.k as string));
    buckets = [
      { bucket: SPECIMENS_BUCKET, refs: specimensBucketRefs },
      { bucket: AVATARS_BUCKET, refs: avatarsRefs },
    ];
  } catch (err) {
    // Never delete on an incomplete reference set.
    res.errored = true;
    logger.error({ err }, 'cron.reconcileOrphans: failed to build referenced-key set; skipping');
    return res;
  }

  for (const { bucket, refs } of buckets) {
    let objects: Awaited<ReturnType<typeof listObjects>>;
    try {
      objects = await listObjects({ bucket });
    } catch (err) {
      res.errored = true;
      logger.error({ err, bucket }, 'cron.reconcileOrphans: listObjects failed; skipping bucket');
      continue;
    }
    res.scanned += objects.length;
    for (const obj of objects) {
      if (refs.has(obj.key)) continue;
      if (now - obj.lastModified.getTime() <= ORPHAN_GRACE_MS) continue;
      try {
        await deleteObject({ bucket, key: obj.key });
        res.orphansDeleted++;
      } catch (err) {
        res.garageFailed++;
        logger.warn({ err, bucket, key: obj.key }, 'cron.reconcileOrphans: orphan delete failed');
      }
    }
  }
  return res;
}

export type PurgeCycleResult = {
  expiredIdentifications: CategoryResult;
  oldSoftDeletedSpecimens: CategoryResult;
  oldPlantnetUsage: CategoryResult;
  expiredRateLimits: CategoryResult;
  staleAuthRateLimits: CategoryResult;
  orphanReconciliation: ReconcileResult;
  hadError: boolean;
};

export async function runPurgeCycle(): Promise<PurgeCycleResult> {
  logger.info('cron: purge cycle starting');
  const expiredIdentifications = await purgeExpiredIdentifications();
  const oldSoftDeletedSpecimens = await purgeOldSoftDeletedSpecimens();
  const oldPlantnetUsage = await purgeOldPlantnetUsage();
  const expiredRateLimits = await purgeExpiredRateLimits();
  const staleAuthRateLimits = await purgeStaleAuthRateLimits();
  const orphanReconciliation = await reconcileOrphans();
  const hadError =
    expiredIdentifications.errored ||
    oldSoftDeletedSpecimens.errored ||
    oldPlantnetUsage.errored ||
    expiredRateLimits.errored ||
    staleAuthRateLimits.errored ||
    orphanReconciliation.errored;
  const result: PurgeCycleResult = {
    expiredIdentifications,
    oldSoftDeletedSpecimens,
    oldPlantnetUsage,
    expiredRateLimits,
    staleAuthRateLimits,
    orphanReconciliation,
    hadError,
  };
  logger.info({ result }, 'cron: purge cycle complete');
  return result;
}
