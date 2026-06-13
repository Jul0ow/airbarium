import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { db } from '@/db/client';
import { specimens, users } from '@/db/schema';
import { recordPlantnet, recordSyncIngest, register } from '@/lib/metrics';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, truncateAll } from '../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(async () => {
  await truncateAll();
  register.resetMetrics();
});

async function seedUser(deleted = false): Promise<string> {
  const id = uuid7();
  await db.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: 'Metrics User',
    deletedAt: deleted ? new Date() : null,
  });
  return id;
}

async function seedSpecimen(userId: string, deleted = false): Promise<void> {
  await db.insert(specimens).values({
    id: uuid7(),
    userId,
    photoUrl: `${userId}/${uuid7()}.jpg`,
    identificationSource: 'none',
    collectedAt: new Date(),
    deletedAt: deleted ? new Date() : null,
  });
}

describe('lib/metrics', () => {
  it('recordPlantnet increments the outcome-labelled counter', async () => {
    recordPlantnet('success');
    recordPlantnet('success');
    recordPlantnet('quota_exceeded');

    const text = await register.metrics();
    expect(text).toContain('airbarium_plantnet_requests_total{outcome="success"} 2');
    expect(text).toContain('airbarium_plantnet_requests_total{outcome="quota_exceeded"} 1');
  });

  it('recordSyncIngest increments the result-labelled counter', async () => {
    recordSyncIngest('identified');
    recordSyncIngest('unidentified');

    const text = await register.metrics();
    expect(text).toContain('airbarium_sync_ingest_total{result="identified"} 1');
    expect(text).toContain('airbarium_sync_ingest_total{result="unidentified"} 1');
  });

  it('business gauges reflect non-deleted rows at scrape time', async () => {
    const u1 = await seedUser();
    const u2 = await seedUser();
    await seedUser(true); // deleted user must not count
    await seedSpecimen(u1);
    await seedSpecimen(u2);
    await seedSpecimen(u1, true); // deleted specimen must not count

    const text = await register.metrics();
    expect(text).toContain('airbarium_users_total 2');
    expect(text).toContain('airbarium_specimens_total 2');
  });

  it('exposes default node/process metrics', async () => {
    const text = await register.metrics();
    expect(text).toContain('process_cpu_seconds_total');
  });
});
