import { createApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/middleware/logger';

const app = createApp();

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 30,
});

logger.info({ port: server.port }, `listening on :${server.port}`);
