import { rawClient } from '@/db/client';
import { pushPurgeMetrics } from '@/lib/cron-metrics';
import { logger } from '@/middleware/logger';
import { runPurgeCycle } from '@/services/purge';

const result = await runPurgeCycle();
// Best-effort metrics push (no-op unless PUSHGATEWAY_URL is set). Never blocks
// the exit code on a push failure — the purge already happened.
await pushPurgeMetrics(result);
await rawClient.end();
logger.info({ hadError: result.hadError }, 'cron: exiting');
process.exit(result.hadError ? 1 : 0);
