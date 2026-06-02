import type { Auth } from '@/auth/better-auth';
import type { LoggerVariables } from '@/middleware/logger';
import type { RequestIdVariables } from '@/middleware/request-id';

type SessionResult = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

export type AuthVariables = {
  user: SessionResult['user'];
  session: SessionResult['session'];
};

export type AppEnv = {
  Variables: RequestIdVariables & LoggerVariables & Partial<AuthVariables>;
};
