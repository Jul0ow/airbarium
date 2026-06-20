import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/config/env';
import * as schema from './schema';

const queryClient = postgres(env.DATABASE_URL, {
  max: env.NODE_ENV === 'test' ? 1 : 10,
  // Prepared statements ON: the hot paths (list, rate-limit, quota, session
  // lookup, getById) are repeated identically, so caching the plan is a clear
  // win. We connect directly to Postgres (CloudNativePG -rw service), not through
  // a transaction-mode pooler. IMPORTANT: if a PgBouncer/pooler in *transaction*
  // mode is ever placed in front, set prepare: false (named prepared statements
  // don't survive transaction-level connection reuse).
  prepare: true,
});

export const db = drizzle(queryClient, { schema, casing: 'snake_case' });
export type Database = typeof db;
export const rawClient = queryClient;
