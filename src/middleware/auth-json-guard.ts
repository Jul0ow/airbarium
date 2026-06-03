import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/app-env';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

export const authJsonGuard = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (!METHODS_WITH_BODY.has(c.req.method)) {
      return next();
    }
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return next();
    }
    try {
      await c.req.raw.clone().json();
    } catch {
      return c.json({ message: 'Invalid JSON body', code: 'INVALID_JSON' }, 400);
    }
    return next();
  };
};
