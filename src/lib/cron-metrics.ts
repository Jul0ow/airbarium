import { Gauge, Pushgateway, Registry } from 'prom-client';
import { env } from '@/config/env';
import { logger } from '@/middleware/logger';
import type { PurgeCycleResult } from '@/services/purge';

const PUSH_JOB = 'airbarium-cron';

// The cron is a short-lived batch process Prometheus can't scrape, so it pushes
// its purge counts to a Pushgateway. This is a dedicated registry — the cron
// never imports the API's lib/metrics registry, keeping its push payload to the
// purge gauges alone. A push failure is logged and swallowed: it must never
// fail the purge cycle. When PUSHGATEWAY_URL is unset the cron's structured
// logs (logged by runPurgeCycle) are the sole observability surface.
export async function pushPurgeMetrics(result: PurgeCycleResult): Promise<void> {
  const url = env.PUSHGATEWAY_URL;
  if (!url) return;

  const registry = new Registry();

  const rowsDeleted = new Gauge({
    name: 'airbarium_purge_rows_deleted',
    help: 'Rows deleted by the last purge cycle, by category.',
    labelNames: ['category'] as const,
    registers: [registry],
  });
  rowsDeleted.set(
    { category: 'expired_identifications' },
    result.expiredIdentifications.rowsDeleted,
  );
  rowsDeleted.set(
    { category: 'old_soft_deleted_specimens' },
    result.oldSoftDeletedSpecimens.rowsDeleted,
  );
  rowsDeleted.set({ category: 'old_plantnet_usage' }, result.oldPlantnetUsage.rowsDeleted);
  rowsDeleted.set({ category: 'expired_rate_limits' }, result.expiredRateLimits.rowsDeleted);
  rowsDeleted.set({ category: 'stale_auth_rate_limits' }, result.staleAuthRateLimits.rowsDeleted);
  rowsDeleted.set({ category: 'orphan_objects' }, result.orphanReconciliation.orphansDeleted);

  const errored = new Gauge({
    name: 'airbarium_purge_errored',
    help: 'Whether the last purge cycle hit any error (1) or not (0).',
    registers: [registry],
  });
  errored.set(result.hadError ? 1 : 0);

  const lastRun = new Gauge({
    name: 'airbarium_purge_last_run_timestamp_seconds',
    help: 'Unix timestamp (seconds) of the last completed purge cycle.',
    registers: [registry],
  });
  lastRun.set(Date.now() / 1000);

  try {
    const gateway = new Pushgateway(url, {}, registry);
    await gateway.pushAdd({ jobName: PUSH_JOB });
    logger.info({ jobName: PUSH_JOB }, 'cron: pushed purge metrics to pushgateway');
  } catch (err) {
    logger.warn({ err }, 'cron: pushgateway push failed (ignored)');
  }
}
