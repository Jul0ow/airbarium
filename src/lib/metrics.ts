import { count, isNull } from 'drizzle-orm';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { db } from '@/db/client';
import { specimens, users } from '@/db/schema';
import { logger } from '@/middleware/logger';

// Single registry for the live API process. The short-lived cron uses its own
// registry (lib/cron-metrics.ts) so it never pulls in these HTTP/business
// collectors. collectDefaultMetrics must run exactly once — the module cache
// guarantees that.
export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestDuration = new Histogram({
  name: 'airbarium_http_request_duration_seconds',
  help: 'HTTP request latency in seconds, labelled by method, matched route and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

const plantnetRequests = new Counter({
  name: 'airbarium_plantnet_requests_total',
  help: 'PlantNet identification attempts by outcome.',
  labelNames: ['outcome'] as const,
  registers: [register],
});

const syncIngest = new Counter({
  name: 'airbarium_sync_ingest_total',
  help: 'Specimens ingested via the offline-sync branch, by identification result.',
  labelNames: ['result'] as const,
  registers: [register],
});

export type PlantnetOutcome = 'success' | 'no_match' | 'error' | 'quota_exceeded';

export function recordPlantnet(outcome: PlantnetOutcome): void {
  plantnetRequests.inc({ outcome });
}

export type SyncIngestResult = 'identified' | 'unidentified';

export function recordSyncIngest(result: SyncIngestResult): void {
  syncIngest.inc({ result });
}

// Business gauges are computed lazily at scrape time: a plain COUNT(*) is cheap
// and low-cardinality. "Per-day" activity is NOT modelled here — it comes from
// the monotonic counters above via PromQL increase(metric[1d]), never a
// daily-reset gauge (which would fight the model and break across restarts).
// A failed query leaves the previous value rather than crashing the whole
// /metrics scrape, so operational metrics stay available when the DB hiccups.
export const usersTotal = new Gauge({
  name: 'airbarium_users_total',
  help: 'Number of non-deleted user accounts.',
  registers: [register],
  async collect() {
    try {
      const [row] = await db.select({ value: count() }).from(users).where(isNull(users.deletedAt));
      this.set(row?.value ?? 0);
    } catch (err) {
      logger.debug({ err }, 'metrics.usersTotal: count query failed');
    }
  },
});

export const specimensTotal = new Gauge({
  name: 'airbarium_specimens_total',
  help: 'Number of non-deleted specimens.',
  registers: [register],
  async collect() {
    try {
      const [row] = await db
        .select({ value: count() })
        .from(specimens)
        .where(isNull(specimens.deletedAt));
      this.set(row?.value ?? 0);
    } catch (err) {
      logger.debug({ err }, 'metrics.specimensTotal: count query failed');
    }
  },
});
