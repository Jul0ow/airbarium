import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '@/app-env';
import { errorHandler } from '@/middleware/error-handler';
import { AppError } from '@/utils/errors';

type LogEntry = { level: 'warn' | 'error'; fields: unknown; msg: unknown };

// Minimal fake Context: errorHandler only touches c.get('log') and c.json().
function fakeContext() {
  const logs: LogEntry[] = [];
  const log = {
    warn: (fields: unknown, msg?: unknown) => logs.push({ level: 'warn', fields, msg }),
    error: (fields: unknown, msg?: unknown) => logs.push({ level: 'error', fields, msg }),
  };
  const c = {
    get: (k: string) => (k === 'log' ? log : undefined),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context<AppEnv>;
  return { c, logs };
}

async function run(err: Error) {
  const { c, logs } = fakeContext();
  const res = await errorHandler(err, c);
  const body = (await res.json()) as {
    error: { code: string; message: string; details?: unknown };
  };
  return { res, body, logs };
}

describe('errorHandler', () => {
  it('maps a 4xx AppError to its envelope and logs at warn', async () => {
    const { res, body, logs } = await run(new AppError('BAD', 'bad input', 400, { field: 'x' }));
    expect(res.status).toBe(400);
    expect(body.error).toEqual({ code: 'BAD', message: 'bad input', details: { field: 'x' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('warn');
  });

  it('logs a 5xx AppError at error (not warn)', async () => {
    const { res, logs } = await run(new AppError('INVARIANT', 'corrupt', 500));
    expect(res.status).toBe(500);
    expect(logs[0]?.level).toBe('error');
  });

  it('maps an HTTPException to a coded envelope', async () => {
    const { res, body, logs } = await run(new HTTPException(403, { message: 'nope' }));
    expect(res.status).toBe(403);
    expect(body.error).toEqual({ code: 'FORBIDDEN', message: 'nope' });
    expect(logs[0]?.level).toBe('warn');
  });

  it('logs a 5xx HTTPException at error', async () => {
    const { res, body, logs } = await run(new HTTPException(500));
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(logs[0]?.level).toBe('error');
  });

  it('hides internals behind a generic 500 for unhandled errors', async () => {
    const { res, body, logs } = await run(new Error('secret stack detail'));
    expect(res.status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.msg).toBe('unhandled error');
  });
});
