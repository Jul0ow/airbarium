import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DAILY_PLANTNET_QUOTA } from '@/config/constants';
import { plantnetUsage, users } from '@/db/schema';
import { register } from '@/lib/metrics';
import { incrementOrThrow, refund } from '@/services/quota';
import { AppError } from '@/utils/errors';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, testDb, truncateAll } from '../../helpers/db';

const today = () => new Date().toISOString().slice(0, 10);

async function createUser() {
  const id = uuid7();
  await testDb.insert(users).values({ id, email: `${id}@example.com`, name: 'Q' });
  return id;
}

async function readCount(userId: string): Promise<number> {
  const [row] = await testDb
    .select({ count: plantnetUsage.count })
    .from(plantnetUsage)
    .where(and(eq(plantnetUsage.userId, userId), eq(plantnetUsage.day, today())));
  return row?.count ?? 0;
}

beforeAll(async () => {
  await setupTestDb();
});
beforeEach(async () => {
  await truncateAll();
});

describe('incrementOrThrow', () => {
  it('inserts row with count=1 on first call', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(1);
  });

  it('increments existing row', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(2);
  });

  it('allows up to 30 calls then throws QUOTA_EXCEEDED on the 31st', async () => {
    const uid = await createUser();
    for (let i = 0; i < 30; i++) await incrementOrThrow(uid);
    expect(await readCount(uid)).toBe(30);

    try {
      await incrementOrThrow(uid);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('QUOTA_EXCEEDED');
      expect((err as AppError).status).toBe(429);
    }
    expect(await readCount(uid)).toBe(30);
  });

  it('records the quota_exceeded PlantNet metric on the rejected call (§15)', async () => {
    const uid = await createUser();
    register.resetMetrics();
    for (let i = 0; i < DAILY_PLANTNET_QUOTA; i++) await incrementOrThrow(uid);

    await expect(incrementOrThrow(uid)).rejects.toBeInstanceOf(AppError);

    const text = await register.metrics();
    expect(text).toContain('airbarium_plantnet_requests_total{outcome="quota_exceeded"} 1');
  });
});

describe('refund', () => {
  it('decrements when count > 0', async () => {
    const uid = await createUser();
    await incrementOrThrow(uid);
    await incrementOrThrow(uid);
    await refund(uid);
    expect(await readCount(uid)).toBe(1);
  });

  it('no-op when no row exists', async () => {
    const uid = await createUser();
    await refund(uid);
    expect(await readCount(uid)).toBe(0);
  });
});
