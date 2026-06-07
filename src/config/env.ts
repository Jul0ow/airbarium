import { z } from 'zod';

const PostgresUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'DATABASE_URL must start with postgres:// or postgresql://',
  });

const SmtpUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('smtp://') || v.startsWith('smtps://'), {
    message: 'SMTP_URL must start with smtp:// or smtps://',
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: PostgresUrl,
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >=32 chars'),
  BETTER_AUTH_URL: z.string().url(),
  SMTP_URL: SmtpUrl,
  MAIL_FROM: z.string().min(1),
  APP_URL: z.string().url(),
  GARAGE_ENDPOINT: z.string().url(),
  GARAGE_ACCESS_KEY: z.string().min(1),
  GARAGE_SECRET_KEY: z.string().min(1),
  GARAGE_REGION: z.string().min(1).default('garage'),
  PLANTNET_API_KEY: z.string().min(1),
  WIKIPEDIA_USER_AGENT: z.string().min(1).default('Airbarium/0.1 (dev)'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env: Env = parsed.data;
