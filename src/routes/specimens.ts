import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import { globalRateLimit } from '@/middleware/rate-limit';
import {
  CreateSpecimenSchema,
  ListSpecimensQuerySchema,
  PatchSpecimenSchema,
} from '@/schemas/specimens';
import { CreateSpecimenOfflineFormSchema } from '@/schemas/specimens-offline';
import * as service from '@/services/specimens';
import { AppError, ValidationError } from '@/utils/errors';
import { JPEG_BODY_LIMIT_BYTES, validateJpeg } from '@/utils/jpeg';

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

async function handleJsonCreate(c: Context<AppEnv>, userId: string) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  const result = CreateSpecimenSchema.safeParse(raw);
  if (!result.success) {
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
  }
  return service.create(userId, result.data);
}

async function handleMultipartCreate(c: Context<AppEnv>, userId: string) {
  const form = await c.req.parseBody();
  const photo = form.photo;
  if (!(photo instanceof File)) {
    throw new AppError('MISSING_FIELD', 'photo field is required', 400);
  }
  if (photo.type !== 'image/jpeg') {
    throw new AppError('INVALID_CONTENT_TYPE', 'photo must be image/jpeg', 400, {
      received: photo.type,
    });
  }
  const buffer = new Uint8Array(await photo.arrayBuffer());
  validateJpeg(buffer);

  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k !== 'photo' && typeof v === 'string' && v !== '') fields[k] = v;
  }
  const result = CreateSpecimenOfflineFormSchema.safeParse(fields);
  if (!result.success) {
    throw new ValidationError('Invalid request body', issuesPayload(result.error.issues));
  }

  return service.create(userId, {
    id: result.data.id,
    photo: buffer,
    identification_source: 'none',
    collected_at: result.data.collected_at,
    lat: result.data.lat,
    lng: result.data.lng,
    location_label: result.data.location_label,
    user_notes: result.data.user_notes,
  });
}

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

route.post(
  '/specimens',
  bodyLimit({
    maxSize: JPEG_BODY_LIMIT_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'File exceeds upload body limit', 413);
    },
  }),
  authMiddleware(),
  globalRateLimit(),
  async (c) => {
    const user = requireUser(c);
    const ct = (c.req.header('content-type') ?? '').toLowerCase();
    let out: Awaited<ReturnType<typeof service.create>>;
    if (ct.startsWith('application/json')) {
      out = await handleJsonCreate(c, user.id);
    } else if (ct.startsWith('multipart/form-data')) {
      out = await handleMultipartCreate(c, user.id);
    } else {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Expected application/json or multipart/form-data',
        415,
      );
    }
    return c.json(out.specimen, out.wasCreated ? 201 : 200);
  },
);

route.get(
  '/specimens',
  authMiddleware(),
  globalRateLimit(),
  zValidator('query', ListSpecimensQuerySchema),
  async (c) => {
    const user = requireUser(c);
    const params = c.req.valid('query');
    const out = await service.list(user.id, params);
    return c.json(out, 200);
  },
);

// IMPORTANT: declare /stats BEFORE /:id so Hono does not match :id == 'stats'.
route.get('/specimens/stats', authMiddleware(), globalRateLimit(), async (c) => {
  const user = requireUser(c);
  return c.json(await service.stats(user.id), 200);
});

route.get('/specimens/:id', authMiddleware(), globalRateLimit(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  return c.json(await service.getById(user.id, id), 200);
});

route.patch('/specimens/:id', authMiddleware(), globalRateLimit(), patchValidator, async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  const body = c.req.valid('json');
  return c.json(await service.patch(user.id, id, body), 200);
});

route.delete('/specimens/:id', authMiddleware(), globalRateLimit(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  await service.softDelete(user.id, id);
  return c.body(null, 204);
});

route.post('/specimens/:id/identify', authMiddleware(), globalRateLimit(), async (c) => {
  const user = requireUser(c);
  const id = parseSpecimenIdOr404(c.req.param('id'));
  return c.json(await service.retryIdentify(user.id, id), 200);
});

export default route;
