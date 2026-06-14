import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { AppEnv } from '@/app-env';
import { httpRequestDuration } from '@/lib/metrics';

// Records the HTTP latency histogram. Kept separate from httpLogger (logging vs
// metrics are distinct concerns). The `route` label is the matched route
// *pattern* (e.g. `/v1/specimens/:id`), never the raw path, so cardinality
// stays bounded. This middleware is mounted at `*`, so `routePath(c)` would
// return its own `*`; `routePath(c, -1)` walks to the last matched route — the
// actual handler. Read in `finally`, after `next()`, once routing has resolved.
export const metrics = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const seconds = (performance.now() - start) / 1000;
      httpRequestDuration.observe(
        {
          method: c.req.method,
          route: routePath(c, -1),
          status_code: String(c.res?.status ?? 500),
        },
        seconds,
      );
    }
  };
};
