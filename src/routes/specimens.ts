import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import {
  CreateSpecimenSchema,
  ListSpecimensQuerySchema,
  PatchSpecimenSchema,
} from '@/schemas/specimens';
import * as service from '@/services/specimens';
import { AppError } from '@/utils/errors';

const route = new Hono<AppEnv>();

route.use('*', authMiddleware());

route.post('/specimens', zValidator('json', CreateSpecimenSchema), async (c) => {
  const user = requireUser(c);
  const body = c.req.valid('json');
  const out = await service.create(user.id, body);
  return c.json(out.specimen, out.wasCreated ? 201 : 200);
});

route.get('/specimens', zValidator('query', ListSpecimensQuerySchema), async (c) => {
  const user = requireUser(c);
  const params = c.req.valid('query');
  const out = await service.list(user.id, params);
  return c.json(out, 200);
});

// IMPORTANT: declare /stats BEFORE /:id so Hono does not match :id == 'stats'.
route.get('/specimens/stats', async (c) => {
  const user = requireUser(c);
  return c.json(await service.stats(user.id), 200);
});

route.get('/specimens/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${id} not found`, 404);
  }
  return c.json(await service.getById(user.id, id), 200);
});

route.patch('/specimens/:id', zValidator('json', PatchSpecimenSchema), async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const body = c.req.valid('json');
  return c.json(await service.patch(user.id, id, body), 200);
});

route.delete('/specimens/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  await service.softDelete(user.id, id);
  return c.body(null, 204);
});

export default route;
