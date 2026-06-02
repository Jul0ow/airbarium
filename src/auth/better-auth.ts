import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { env } from '@/config/env';
import { db } from '@/db/client';
import { account, session, users, verification } from '@/db/schema';
import { resetPasswordEmail } from '@/lib/emails/reset-password';
import { verifyEmailEmail } from '@/lib/emails/verify-email';
import { sendMail } from '@/lib/mailer';
import { uuid7 } from '@/utils/uuid';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/v1/auth',
  trustedOrigins: ['http://localhost:8081', 'http://localhost:19006', 'https://app.airbarium.app'],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: users,
      account,
      session,
      verification,
    },
  }),
  user: {
    modelName: 'user',
    additionalFields: {
      avatarUrl: { type: 'string', required: false, input: false },
      deletedAt: { type: 'date', required: false, input: false },
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    // Spec §2: verification email is sent, but sign-in is not gated on it.
    // Explicit so an upstream default change can't silently flip behavior.
    requireEmailVerification: false,
    password: {
      hash: async (pw) => Bun.password.hash(pw, { algorithm: 'argon2id' }),
      verify: async ({ hash, password }) => Bun.password.verify(password, hash),
    },
    sendResetPassword: async ({ user, url }) => {
      const mail = resetPasswordEmail({ url, userName: user.name });
      await sendMail({ to: user.email, ...mail });
    },
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      const mail = verifyEmailEmail({ url, userName: user.name });
      await sendMail({ to: user.email, ...mail });
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  advanced: {
    database: {
      generateId: () => uuid7(),
    },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/email': { window: 60 * 15, max: 10 },
      '/sign-up/email':
        env.NODE_ENV === 'test' ? { window: 60, max: 1000 } : { window: 60 * 60, max: 3 },
    },
  },
  plugins: [bearer()],
});

export type Auth = typeof auth;
