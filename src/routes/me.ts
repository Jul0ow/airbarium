import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '@/app-env';
import { authMiddleware } from '@/middleware/auth';
import { jsonBody } from '@/middleware/json-body';
import { PatchMeSchema } from '@/schemas/me';
import { deleteAvatar, uploadAvatar } from '@/services/photo-storage';
import { getMe, updateMe } from '@/services/profile';
import { AppError } from '@/utils/errors';
import { validateJpeg } from '@/utils/jpeg';

const route = new Hono<AppEnv>();

route.get('/me', authMiddleware(), async (c) => {
  const user = c.get('user');
  if (!user) throw new Error('unreachable: authMiddleware guards this route');
  return c.json(await getMe(user.id));
});

route.patch('/me', authMiddleware(), ...jsonBody(PatchMeSchema), async (c) => {
  const user = c.get('user');
  if (!user) throw new Error('unreachable: authMiddleware guards this route');
  const input = c.req.valid('json');
  return c.json(await updateMe(user.id, input));
});

route.put(
  '/me/avatar',
  authMiddleware(),
  bodyLimit({
    maxSize: 3 * 1024 * 1024,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'File exceeds 3MB body limit', 413);
    },
  }),
  async (c) => {
    const user = c.get('user');
    if (!user) throw new Error('unreachable: authMiddleware guards this route');

    const ct = c.req.header('content-type') ?? '';
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data', 415);
    }

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

    const { avatarUrl } = await uploadAvatar(user.id, buffer);
    return c.json({ avatar_url: avatarUrl });
  },
);

route.delete('/me/avatar', authMiddleware(), async (c) => {
  const user = c.get('user');
  if (!user) throw new Error('unreachable: authMiddleware guards this route');
  await deleteAvatar(user.id);
  return c.body(null, 204);
});

export default route;
