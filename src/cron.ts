import { rawClient } from '@/db/client';
import { logger } from '@/middleware/logger';
import { runPurgeCycle } from '@/services/purge';

const result = await runPurgeCycle();
await rawClient.end();
logger.info({ hadError: result.hadError }, 'cron: exiting');
process.exit(result.hadError ? 1 : 0);
