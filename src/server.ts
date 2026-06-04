import { createApp } from '@/app';
import { env } from '@/config/env';
import { ensureBucket } from '@/lib/garage';
import { logger } from '@/middleware/logger';

const app = createApp();

if (env.NODE_ENV !== 'production') {
  try {
    await ensureBucket('avatars');
  } catch (err) {
    logger.warn({ err }, 'startup: ensureBucket(avatars) failed — continuing anyway');
  }
}

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 30,
});

logger.info({ port: server.port }, `listening on :${server.port}`);
