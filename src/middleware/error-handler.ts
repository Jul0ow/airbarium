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
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
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
    // Route by status (design §10.1): 5xx are server faults (e.g. INVARIANT data
    // corruption) and must be `error`, not buried at `warn` with the 4xx noise.
    const fields = { code: err.code, status: err.status, details: err.details };
    if (err.status >= 500) log.error(fields, err.message);
    else log.warn(fields, err.message);
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
    if (err.status >= 500) log.error({ code, status: err.status }, err.message);
    else log.warn({ code, status: err.status }, err.message);
    return c.json(
      { error: { code, message: err.message || code } },
      err.status as ContentfulStatusCode,
    );
  }

  log.error({ err }, 'unhandled error');
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
};
