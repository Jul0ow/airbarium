import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/app-env';
import { auth } from '@/auth/better-auth';
import { UnauthorizedError } from '@/utils/errors';

export const authMiddleware = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const result = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!result?.user || !result?.session) {
      throw new UnauthorizedError('Authentication required');
    }
    c.set('user', result.user);
    c.set('session', result.session);
    await next();
  };
};
