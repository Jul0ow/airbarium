import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { db } from '@/db/client';

const route = new Hono<AppEnv>();

// Lot 2: probes Postgres. `garage` (Lot 4) and `plantnet` (Lot 5) probes follow.
route.get('/health', async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch (err) {
    c.get('log').warn({ err }, 'health: db probe failed');
  }

  const status = dbOk ? 'ok' : 'degraded';
  return c.json({ status, db: dbOk ? 'ok' : 'down' }, dbOk ? 200 : 503);
});

export default route;
