import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/app-env';
import { GLOBAL_RATE_LIMIT_MAX, GLOBAL_RATE_LIMIT_WINDOW_MS } from '@/config/constants';
import { checkGlobalRateLimit } from '@/services/rate-limit';
import { AppError } from '@/utils/errors';
import { requireUser } from './auth';

export const globalRateLimit = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const user = requireUser(c);
  let result: { allowed: boolean; retryAfterSeconds: number };
  try {
    result = await checkGlobalRateLimit(user.id);
  } catch (err) {
    // FAIL-OPEN: a rate-limiter outage must not take down the API.
    c.get('log').warn({ err, userId: user.id }, 'rate-limit: check failed, allowing (fail-open)');
    await next();
    return;
  }
  if (!result.allowed) {
    c.header('Retry-After', String(result.retryAfterSeconds));
    throw new AppError('RATE_LIMITED', 'Rate limit exceeded', 429, {
      limit: GLOBAL_RATE_LIMIT_MAX,
      window_seconds: GLOBAL_RATE_LIMIT_WINDOW_MS / 1000,
    });
  }
  await next();
};
