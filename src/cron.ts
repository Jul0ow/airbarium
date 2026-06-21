import { rawClient } from '@/db/client';
import { pushPurgeMetrics } from '@/lib/cron-metrics';
import { logger } from '@/middleware/logger';
import { runPurgeCycle } from '@/services/purge';

// Guard the whole cycle: any unexpected throw (outside the per-category try
// blocks, or in pushPurgeMetrics) still closes the DB pool and exits with a
// controlled non-zero code instead of leaking a connection / crashing raw.
let exitCode = 0;
try {
  const result = await runPurgeCycle();
  // Best-effort metrics push (no-op unless PUSHGATEWAY_URL is set). Never blocks
  // the exit code on a push failure — the purge already happened.
  await pushPurgeMetrics(result);
  exitCode = result.hadError ? 1 : 0;
  logger.info({ hadError: result.hadError }, 'cron: exiting');
} catch (err) {
  exitCode = 1;
  logger.error({ err }, 'cron: unexpected failure');
} finally {
  await rawClient.end();
}
process.exit(exitCode);
