import { zValidator } from '@hono/zod-validator';
import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '@/app-env';
import { UnsupportedMediaTypeError, ValidationError, zodIssues } from '@/utils/errors';

const JSON_CONTENT_TYPE = /^application\/([a-z\-.]+\+)?json(\s*;|$)/i;

const requireJsonContentType = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const ct = c.req.header('content-type') ?? '';
    if (!JSON_CONTENT_TYPE.test(ct)) {
      throw new UnsupportedMediaTypeError(
        'Expected Content-Type: application/json',
        ct ? { received: ct } : undefined,
      );
    }
    return next();
  };
};

// biome-ignore lint/suspicious/noExplicitAny: passthrough generic for zValidator
export const jsonBody = <T extends z.ZodType<any, any>>(schema: T) =>
  [
    requireJsonContentType(),
    zValidator('json', schema, (result) => {
      if (!result.success) {
        throw new ValidationError('Invalid request body', zodIssues(result.error));
      }
    }),
  ] as const;
