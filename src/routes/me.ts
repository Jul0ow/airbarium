import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie } from 'hono/cookie';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import { jsonBody } from '@/middleware/json-body';
import { globalRateLimit } from '@/middleware/rate-limit';
import { PatchMeSchema } from '@/schemas/me';
import { deleteAccount } from '@/services/account-deletion';
import { deleteAvatar, uploadAvatar } from '@/services/photo-storage';
import { getMe, updateMe } from '@/services/profile';
import { AppError } from '@/utils/errors';
import { JPEG_BODY_LIMIT_BYTES, validateJpeg } from '@/utils/jpeg';

const route = new Hono<AppEnv>();

route.get('/me', authMiddleware(), globalRateLimit(), async (c) => {
  return c.json(await getMe(requireUser(c).id));
});

route.patch('/me', authMiddleware(), globalRateLimit(), ...jsonBody(PatchMeSchema), async (c) => {
  const input = c.req.valid('json');
  return c.json(await updateMe(requireUser(c).id, input));
});

route.put(
  '/me/avatar',
  authMiddleware(),
  globalRateLimit(),
  bodyLimit({
    maxSize: JPEG_BODY_LIMIT_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'File exceeds upload body limit', 413);
    },
  }),
  async (c) => {
    const user = requireUser(c);

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

route.delete('/me/avatar', authMiddleware(), globalRateLimit(), async (c) => {
  await deleteAvatar(requireUser(c).id);
  return c.body(null, 204);
});

route.delete('/me', authMiddleware(), globalRateLimit(), async (c) => {
  const user = requireUser(c);
  await deleteAccount(user.id, user.email);
  // Real invalidation is the cascade-deleted session row; Bearer clients don't
  // send cookies, so deletion is complete once the session row is gone. Clearing
  // the cookie is cosmetic cleanup for web clients. The __Secure- name requires
  // { secure: true } or Hono's serialize() throws.
  deleteCookie(c, 'better-auth.session_token');
  deleteCookie(c, '__Secure-better-auth.session_token', { secure: true });
  return c.body(null, 204);
});

export default route;
