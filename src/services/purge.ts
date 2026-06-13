import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import {
  PLANTNET_USAGE_RETENTION_DAYS,
  SPECIMEN_SOFT_DELETE_RETENTION_DAYS,
  SPECIMENS_BUCKET,
} from '@/config/constants';
import { db } from '@/db/client';
import { identifications, plantnetUsage, specimens } from '@/db/schema';
import { deleteObject } from '@/lib/garage';
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
