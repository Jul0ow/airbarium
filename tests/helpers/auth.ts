import type { Hono } from 'hono';

export type SignUpResult = {
  userId: string;
  email: string;
  sessionToken: string;
  cookieHeader: string;
};

type SignUpBody = {
  user?: { id?: string; email?: string };
  token?: string;
  session?: { token?: string };
};

// Hono's app.request takes plain Request inputs, so a permissive type is fine here.
// biome-ignore lint/suspicious/noExplicitAny: test helper accepts any Hono variant
export async function signUpTestUser(
  app: Hono<any, any, any>,
  input: { email: string; password: string; name: string },
): Promise<SignUpResult> {
  const res = await app.request('/v1/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status >= 300) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as SignUpBody;
  const sessionToken = res.headers.get('set-auth-token') ?? body.token ?? body.session?.token;
  const cookieHeader = res.headers.get('set-cookie') ?? '';
  if (!sessionToken) {
    throw new Error('sign-up returned no session token');
  }
  if (!body.user?.id || !body.user?.email) {
    throw new Error('sign-up returned no user');
  }
  return {
    userId: body.user.id,
    email: body.user.email,
    sessionToken,
    cookieHeader,
  };
}

export function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
