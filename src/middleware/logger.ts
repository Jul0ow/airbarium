import type { MiddlewareHandler } from 'hono';
import pino, { type Logger } from 'pino';
import { env } from '@/config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'airbarium-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type LoggerVariables = {
  log: Logger;
};

export const httpLogger = (): MiddlewareHandler<{
  Variables: { requestId: string } & LoggerVariables;
}> => {
  return async (c, next) => {
    const requestId = c.get('requestId');
    const child = logger.child({ request_id: requestId });
    c.set('log', child);

    const start = performance.now();
    await next();
    const latency_ms = Math.round((performance.now() - start) * 100) / 100;

    const status = c.res.status;
    const payload = {
      method: c.req.method,
      path: c.req.path,
      status,
      latency_ms,
    };

    if (status >= 500) {
      child.error(payload, 'request');
    } else if (status >= 400) {
      child.warn(payload, 'request');
    } else {
      child.info(payload, 'request');
    }
  };
};
