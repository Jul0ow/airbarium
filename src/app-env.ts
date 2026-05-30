import type { LoggerVariables } from '@/middleware/logger';
import type { RequestIdVariables } from '@/middleware/request-id';

export type AppEnv = {
  Variables: RequestIdVariables & LoggerVariables;
};
