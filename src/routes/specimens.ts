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
import { AppError, ValidationError } from '@/utils/errors';

const route = new Hono<AppEnv>();

// Auth is applied inline per route (not via `route.use('*', ...)`) so that
// unknown paths under `/v1/*` fall through to the global 404 handler instead
// of being intercepted as 401 by this sub-app's wildcard.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Malformed `:id` returns 404 SPECIMEN_NOT_FOUND (not 400) so the route reads
// uniformly: "this URL does not address a specimen of yours" regardless of
// whether the id is invalid, unknown, or owned by someone else.
const parseSpecimenIdOr404 = (raw: string): string => {
  if (!UUID_RE.test(raw)) {
    throw new AppError('SPECIMEN_NOT_FOUND', `specimen ${raw} not found`, 404);
  }
  return raw;
};

const issuesPayload = (
  issues: Array<{ path: ReadonlyArray<PropertyKey>; code: string; message: string }>,
) => ({
  issues: issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
});

const createValidator = zValidator('json', CreateSpecimenSchema, (result) => {
  if (result.success) return;
  const sourceIssue = result.error.issues.find(
    (i) => i.path.length === 1 && i.path[0] === 'identification_source',
  );
  if (sourceIssue) {
    throw new AppError(
      'OFFLINE_SOURCE_NOT_ALLOWED',
      'identification_source must be plantnet_auto or plantnet_picked',
      400,
      issuesPayload(result.error.issues),
    );
  }
  throw new ValidationError('Invalid request body', issuesPayload(result.error.issues));
});

const patchValidator = zValidator('json', PatchSpecimenSchema, (result) => {
  if (result.success) return;
  const refineIssue = result.error.issues.find((i) => i.path.length === 0 && i.code === 'custom');
  if (refineIssue) {
    throw new AppError(
      'INVALID_PATCH',
      'at least one of user_notes / location_label is required',
      400,
      issuesPayload(result.error.issues),
    );
  }
  throw new ValidationError('Invalid request body', issuesPayload(result.error.issues));
});

route.post('/specimens', authMiddleware(), createValidator, async (c) => {
  const user = requireUser(c);
  const body = c.req.valid('json');
  const out = await service.create(user.id, body);
  return c.json(out.specimen, out.wasCreated ? 201 : 200);
});

route.get(
  '/specimens',
  authMiddleware(),
  zValidator('query', ListSpecimensQuerySchema),
  async (c) => {
    const user = requireUser(c);
    const params = c.req.valid('query');
    const out = await service.list(user.id, params);
    return c.json(out, 200);
  },
);

// IMPORTANT: declare /stats BEFORE /:id so Hono does not match :id == 'stats'.
route.get('/specimens/stats', authMiddleware(), async (c) => {
  const user = requireUser(c);
  return c.json(await service.stats(user.id), 200);
});

route.get('/specimens/:id', authMiddleware(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  return c.json(await service.getById(user.id, id), 200);
});

route.patch('/specimens/:id', authMiddleware(), patchValidator, async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  const body = c.req.valid('json');
  return c.json(await service.patch(user.id, id, body), 200);
});

route.delete('/specimens/:id', authMiddleware(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  await service.softDelete(user.id, id);
  return c.body(null, 204);
});

export default route;
