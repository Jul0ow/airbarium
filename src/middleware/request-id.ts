import type { MiddlewareHandler } from 'hono';

export type RequestIdVariables = {
  requestId: string;
};

export const requestId = (): MiddlewareHandler<{ Variables: RequestIdVariables }> => {
  return async (c, next) => {
    const incoming = c.req.header('X-Request-Id');
    const id = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  };
};
