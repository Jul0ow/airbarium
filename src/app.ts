import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from '@/app-env';
import { errorHandler } from '@/middleware/error-handler';
import { httpLogger } from '@/middleware/logger';
import { requestId } from '@/middleware/request-id';
import { routes } from '@/routes';

export const createApp = () => {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.use('*', httpLogger());
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

  app.route('/v1', routes);

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));
  app.onError(errorHandler);

  return app;
};

export type App = ReturnType<typeof createApp>;
