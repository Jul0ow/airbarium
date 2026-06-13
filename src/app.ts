import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '@/app-env';
import { auth } from '@/auth/better-auth';
import { authJsonGuard } from '@/middleware/auth-json-guard';
import { errorHandler } from '@/middleware/error-handler';
import { httpLogger } from '@/middleware/logger';
import { metrics } from '@/middleware/metrics';
import { requestId } from '@/middleware/request-id';
import { routes } from '@/routes';
import metricsRoute from '@/routes/metrics';
import { NotFoundError } from '@/utils/errors';

export const createApp = () => {
  const app = new Hono<AppEnv>();

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
      origin: ['http://localhost:8081', 'http://localhost:19006', 'https://app.airbarium.app'],
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    }),
  );

  app.use('/v1/auth/*', authJsonGuard());
  app.on(['GET', 'POST'], '/v1/auth/*', (c) => auth.handler(c.req.raw));

  app.route('/', metricsRoute);
  app.route('/v1', routes);

  app.notFound(() => {
    throw new NotFoundError('Route not found');
  });
  app.onError(errorHandler);

  return app;
};

export type App = ReturnType<typeof createApp>;
