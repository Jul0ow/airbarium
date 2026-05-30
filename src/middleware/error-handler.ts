import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Logger } from 'pino';
import { logger as rootLogger } from '@/middleware/logger';
import { AppError } from '@/utils/errors';

const ctxLog = (c: Context): Logger => {
  const log = c.get('log');
  return (log as Logger | undefined) ?? rootLogger;
};

export const errorHandler: ErrorHandler = (err, c) => {
  const log = ctxLog(c);

  if (err instanceof AppError) {
    log.warn({ code: err.code, status: err.status, details: err.details }, err.message);
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
      err.status as ContentfulStatusCode,
    );
  }

  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  log.error({ err }, 'unhandled error');
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
};
