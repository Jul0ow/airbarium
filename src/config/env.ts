import { z } from 'zod';

const PostgresUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'DATABASE_URL must start with postgres:// or postgresql://',
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: PostgresUrl,
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env: Env = parsed.data;
