import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '@/app-env';
import { AppError } from '@/utils/errors';

const httpStatusCode = (status: StatusCode): string => {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 502:
      return 'BAD_GATEWAY';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'HTTP_ERROR';
  }
};

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const log = c.get('log');

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
    const code = httpStatusCode(err.status);
    log.warn({ code, status: err.status }, err.message);
    return c.json(
      { error: { code, message: err.message || code } },
      err.status as ContentfulStatusCode,
    );
  }

  log.error({ err }, 'unhandled error');
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
};
