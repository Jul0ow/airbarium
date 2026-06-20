import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '@/app-env';
import { authMiddleware, requireUser } from '@/middleware/auth';
import { globalRateLimit } from '@/middleware/rate-limit';
import { ExifFormSchema } from '@/schemas/identifications';
import { identifyAndStore } from '@/services/identification';
import { AppError, zodIssues } from '@/utils/errors';
import { JPEG_BODY_LIMIT_BYTES, readJpegUpload } from '@/utils/jpeg';

const route = new Hono<AppEnv>();

route.post(
  '/identifications',
  // Cap body size before auth so unauthenticated uploads cannot stream MBs
  // through the TLS layer just to be 401'd afterwards.
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

    const ct = c.req.header('content-type') ?? '';
    if (!ct.toLowerCase().startsWith('multipart/form-data')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Expected multipart/form-data', 415);
    }

    const form = await c.req.parseBody();
    const buffer = await readJpegUpload(form.photo);

    const exifInput: Record<string, string | undefined> = {};
    if (typeof form.date_taken === 'string') exifInput.date_taken = form.date_taken;
    if (typeof form.gps_lat === 'string') exifInput.gps_lat = form.gps_lat;
    if (typeof form.gps_lng === 'string') exifInput.gps_lng = form.gps_lng;

    const parsed = ExifFormSchema.safeParse(exifInput);
    if (!parsed.success) {
      throw new AppError('INVALID_EXIF', 'Invalid EXIF form fields', 400, zodIssues(parsed.error));
    }

    const out = await identifyAndStore(user.id, buffer, parsed.data);
    return c.json(out, 201);
  },
);

export default route;
