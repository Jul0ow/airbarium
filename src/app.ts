import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '@/app-env';
import { auth } from '@/auth/better-auth';
import { AUTH_BODY_LIMIT_BYTES, CLIENT_ORIGINS } from '@/config/constants';
import { authJsonGuard } from '@/middleware/auth-json-guard';
import { errorHandler } from '@/middleware/error-handler';
import { httpLogger } from '@/middleware/logger';
import { metrics } from '@/middleware/metrics';
import { requestId } from '@/middleware/request-id';
import { registerOpenApiDoc } from '@/openapi-doc';
import { routes } from '@/routes';
import metricsRoute from '@/routes/metrics';
import { AppError, NotFoundError } from '@/utils/errors';

export const createApp = () => {
  const app = new OpenAPIHono<AppEnv>();

  app.use('*', requestId());
  app.use('*', httpLogger());
  app.use('*', metrics());
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: 'max-age=63072000',
      xContentTypeOptions: 'nosniff',
      xFrameOptions: 'DENY',
    }),
  );
  app.use(
    '*',
    cors({
      origin: CLIENT_ORIGINS,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    }),
  );

  // Cap the unauthenticated auth routes' body BEFORE authJsonGuard clones/parses
  // it: without this, a multi-hundred-MB POST would be buffered in memory (OOM).
  app.use(
    '/v1/auth/*',
    bodyLimit({
      maxSize: AUTH_BODY_LIMIT_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
      },
    }),
  );
  app.use('/v1/auth/*', authJsonGuard());
  app.on(['GET', 'POST'], '/v1/auth/*', (c) => auth.handler(c.req.raw));

  app.route('/', metricsRoute);
  app.route('/v1', routes);

  // OpenAPI contract (/openapi.json) + Scalar docs (/docs). Registered after the
  // route mounts and before notFound so the doc endpoints resolve. Pure
  // documentation — does not touch the handlers above.
  registerOpenApiDoc(app);

  app.notFound(() => {
    throw new NotFoundError('Route not found');
  });
  app.onError(errorHandler);

  return app;
};

export type App = ReturnType<typeof createApp>;
