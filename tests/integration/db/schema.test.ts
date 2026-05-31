import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { identifications, plantnetUsage, rateLimit, species, specimens, users } from '@/db/schema';
import { uuid7 } from '@/utils/uuid';
import { setupTestDb, teardownTestDb, testDb, truncateAll } from '../../helpers/db';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('db schema', () => {
  it('inserts a user and reads it back', async () => {
    const id = uuid7();
    await testDb.insert(users).values({ id, email: 'alice@example.com', name: 'Alice' });

    const [row] = await testDb.select().from(users).where(eq(users.id, id));
    expect(row?.email).toBe('alice@example.com');
    expect(row?.emailVerified).toBe(false);
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('enforces unique email on users', async () => {
    await testDb.insert(users).values({ id: uuid7(), email: 'dup@example.com', name: 'A' });

    await expect(
      testDb.insert(users).values({ id: uuid7(), email: 'dup@example.com', name: 'B' }).execute(),
    ).rejects.toThrow();
  });

  it('enforces unique scientific_name on species', async () => {
    await testDb.insert(species).values({ id: uuid7(), scientificName: 'Rosa canina' });

    await expect(
      testDb.insert(species).values({ id: uuid7(), scientificName: 'Rosa canina' }).execute(),
    ).rejects.toThrow();
  });

  it('cascades user delete to identifications, specimens, plantnet_usage', async () => {
    const userId = uuid7();
    const speciesId = uuid7();
    const identId = uuid7();
    const specId = uuid7();

    await testDb.insert(users).values({ id: userId, email: 'c@example.com', name: 'C' });
    await testDb.insert(species).values({ id: speciesId, scientificName: 'Tulipa gesneriana' });
    await testDb.insert(identifications).values({
      id: identId,
      userId,
      photoUrl: `specimens/${userId}/${identId}.jpg`,
      plantnetRawResponse: { results: [] },
      topMatchSpeciesId: speciesId,
    });
    await testDb.insert(specimens).values({
      id: specId,
      userId,
      identificationId: identId,
      speciesId,
      photoUrl: `specimens/${userId}/${specId}.jpg`,
      collectedAt: new Date(),
      identificationSource: 'plantnet_auto',
    });
    await testDb.insert(plantnetUsage).values({ userId, day: '2026-05-31', count: 1 });

    await testDb.delete(users).where(eq(users.id, userId));

    expect(
      await testDb.select().from(identifications).where(eq(identifications.userId, userId)),
    ).toHaveLength(0);
    expect(await testDb.select().from(specimens).where(eq(specimens.userId, userId))).toHaveLength(
      0,
    );
    expect(
      await testDb.select().from(plantnetUsage).where(eq(plantnetUsage.userId, userId)),
    ).toHaveLength(0);
    // species survives — it's a shared referential
    expect(await testDb.select().from(species).where(eq(species.id, speciesId))).toHaveLength(1);
  });

  it('sets specimens.identification_id to NULL when identification is deleted', async () => {
    const userId = uuid7();
    const identId = uuid7();
    const specId = uuid7();

    await testDb.insert(users).values({ id: userId, email: 'd@example.com', name: 'D' });
    await testDb.insert(identifications).values({
      id: identId,
      userId,
      photoUrl: 'x',
      plantnetRawResponse: {},
    });
    await testDb.insert(specimens).values({
      id: specId,
      userId,
      identificationId: identId,
      photoUrl: 'y',
      collectedAt: new Date(),
    });

    await testDb.delete(identifications).where(eq(identifications.id, identId));

    const [row] = await testDb
      .select()
      .from(specimens)
      .where(and(eq(specimens.id, specId), eq(specimens.userId, userId)));
    expect(row?.identificationId).toBeNull();
  });

  it('enforces composite PK on plantnet_usage', async () => {
    const userId = uuid7();
    await testDb.insert(users).values({ id: userId, email: 'e@example.com', name: 'E' });

    await testDb.insert(plantnetUsage).values({ userId, day: '2026-05-31', count: 1 });
    await expect(
      testDb.insert(plantnetUsage).values({ userId, day: '2026-05-31', count: 2 }).execute(),
    ).rejects.toThrow();
  });

  it('enforces composite PK on rate_limit', async () => {
    const windowStart = new Date('2026-05-31T12:00:00Z');
    const expiresAt = new Date('2026-05-31T13:00:00Z');

    await testDb.insert(rateLimit).values({ key: 'signin:1.2.3.4', windowStart, expiresAt });
    await expect(
      testDb.insert(rateLimit).values({ key: 'signin:1.2.3.4', windowStart, expiresAt }).execute(),
    ).rejects.toThrow();
  });
});
