import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware } from '@/middleware/auth';
import { globalRateLimit } from '@/middleware/rate-limit';
import { getById } from '@/services/species';

const route = new Hono<AppEnv>();

route.get('/species/:id', authMiddleware(), globalRateLimit(), async (c) => {
  const id = c.req.param('id');
  return c.json(await getById(id));
});

export default route;
