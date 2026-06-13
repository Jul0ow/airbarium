import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { db } from '@/db/client';
import { pingGarage } from '@/lib/garage';

const route = new Hono<AppEnv>();

// Liveness: DB only. A transient Garage/PlantNet blip must NOT restart the pod,
// so those dependencies are deliberately excluded here (see /health/ready).
route.get('/health', async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch (err) {
    c.get('log').error({ err }, 'health: db probe failed');
  }

  const status = dbOk ? 'ok' : 'degraded';
  return c.json({ status, db: dbOk ? 'ok' : 'down' }, dbOk ? 200 : 503);
});

// Readiness: DB + Garage. A Garage outage returns 503 so the pod is pulled from
// the ingress (it can't serve photo uploads/reads) without being restarted.
route.get('/health/ready', async (c) => {
  const log = c.get('log');
  const [dbOk, garageOk] = await Promise.all([
    db
      .execute(sql`SELECT 1`)
      .then(() => true)
      .catch((err) => {
        log.error({ err }, 'health: db probe failed');
        return false;
      }),
    pingGarage()
      .then(() => true)
      .catch((err) => {
        log.error({ err }, 'health: garage probe failed');
        return false;
      }),
  ]);

  const ready = dbOk && garageOk;
  return c.json(
    {
      status: ready ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      garage: garageOk ? 'ok' : 'down',
    },
    ready ? 200 : 503,
  );
});

export default route;
