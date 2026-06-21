import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware } from '@/middleware/auth';
import { globalRateLimit } from '@/middleware/rate-limit';
import { getById } from '@/services/species';
import { parseUuidOr404 } from '@/utils/http';

const route = new Hono<AppEnv>();

route.get('/species/:id', authMiddleware(), globalRateLimit(), async (c) => {
  const id = parseUuidOr404(c.req.param('id'), 'SPECIES_NOT_FOUND', 'species not found');
  return c.json(await getById(id));
});

export default route;
