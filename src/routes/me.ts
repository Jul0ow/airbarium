import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware } from '@/middleware/auth';
import { PatchMeSchema } from '@/schemas/me';
import { getMe, updateMe } from '@/services/profile';

const route = new Hono<AppEnv>();

route.use('*', authMiddleware());

route.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) throw new Error('unreachable: authMiddleware guards this route');
  return c.json(await getMe(user.id));
});

route.patch('/me', zValidator('json', PatchMeSchema), async (c) => {
  const user = c.get('user');
  if (!user) throw new Error('unreachable: authMiddleware guards this route');
  const input = c.req.valid('json');
  return c.json(await updateMe(user.id, input));
});

export default route;
