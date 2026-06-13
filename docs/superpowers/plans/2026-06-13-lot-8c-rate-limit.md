# Lot 8c — Rate limiting backed by Postgres — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Postgres-backed global API rate limiter (600 req/10 min/user, bucketed sliding window) and move Better Auth's auth-route limits to Postgres storage, with cron cleanup and account-deletion purge.

**Architecture:** A `rate-limit` service holds the sliding-window logic (testable without Hono, like `quota.ts`); a thin `globalRateLimit()` middleware wraps it and runs after `authMiddleware` on the authenticated sub-routers. Better Auth's limits switch to `storage: 'database'` against a new BA-managed `auth_rate_limit` table. The lot-8b one-shot cron gains two purges; `deleteAccount` purges the user's global buckets.

**Tech Stack:** Bun, Hono, Drizzle, Better Auth, PostgreSQL.

---

## Constants (`src/config/constants.ts`)

```ts
export const GLOBAL_RATE_LIMIT_MAX = 600;
export const GLOBAL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_RATE_LIMIT_BUCKET_MS = 60 * 1000;
// Auth rows older than the largest BA window (sign-up = 1h) can never affect a limit → safe to purge.
export const AUTH_RATE_LIMIT_MAX_WINDOW_MS = 60 * 60 * 1000;
```

---

### Task 1: Better Auth rate-limit table + DB storage

**Files:**
- Create: `src/db/schema/auth-rate-limit.ts`
- Modify: `src/db/schema/index.ts`, `src/auth/better-auth.ts`
- Create: `src/db/migrations/*` (generated)
- Test: `tests/integration/` auth suite

- [ ] **Step 1: Define the table.** `pgTable('auth_rate_limit', { id: text().primaryKey(), key: text().notNull().unique(), count: integer().notNull().default(0), lastRequest: bigint({ mode: 'number' }).notNull() })`. Property names MUST be `id`/`key`/`count`/`lastRequest` (BA maps model fields to columns by property name). Export `authRateLimit` + `$inferSelect`/`$inferInsert` types. Add the export to `src/db/schema/index.ts`.
- [ ] **Step 2: Wire BA storage.** In `better-auth.ts`, add `rateLimit: authRateLimit` to the `drizzleAdapter` `schema` map, and add `storage: 'database'` to the existing `rateLimit` config (keep `enabled/window/max/customRules`). `advanced.database.generateId: uuid7` already populates `id`.
- [ ] **Step 3: Generate + apply migration.** `nix develop --command bun run db:generate` then `nix develop --command bun run db:migrate`. Commit SQL + meta.
- [ ] **Step 4: Test (write first, watch fail, then implement above).** Integration: perform one sign-in request via the test app, assert a row exists in `auth_rate_limit`. Do NOT assert 429 (test env sets sign-up `max:1000`).
- [ ] **Step 5: typecheck + lint + commit.**

### Task 2: Global limiter service

**Files:**
- Create: `src/services/rate-limit.ts`
- Test: `tests/integration/rate-limit.test.ts`

- [ ] **Step 1: Write failing tests.** Seed `rate_limit` buckets directly. (a) buckets summing to 599 in-window → `checkGlobalRateLimit(user)` returns `allowed:true`; immediately call again → the new bucket makes 601 → `allowed:false`. (b) a bucket with `windowStart` older than 10 min is excluded from the sum. (c) two distinct userIds don't interfere.
- [ ] **Step 2: Implement.** `checkGlobalRateLimit(userId): Promise<{ allowed: boolean; retryAfterSeconds: number }>`:
  - `key = 'global:' + userId`; `bucket = new Date(Math.floor(Date.now() / GLOBAL_RATE_LIMIT_BUCKET_MS) * GLOBAL_RATE_LIMIT_BUCKET_MS)`.
  - Upsert mirroring `quota.ts`: `insert({ key, windowStart: bucket, count: 1, expiresAt: new Date(bucket.getTime() + GLOBAL_RATE_LIMIT_WINDOW_MS) }).onConflictDoUpdate({ target: [rateLimit.key, rateLimit.windowStart], set: { count: sql\`${rateLimit.count} + 1\` } })`.
  - `const [row] = await db.select({ total: sql<number>\`coalesce(sum(${rateLimit.count}), 0)\` }).from(rateLimit).where(and(eq(rateLimit.key, key), sql\`${rateLimit.windowStart} > now() - (interval '1 millisecond' * ${GLOBAL_RATE_LIMIT_WINDOW_MS})\`))`. Note `sum()` may come back as string — coerce with `Number(row.total)`.
  - `return { allowed: Number(row.total) <= GLOBAL_RATE_LIMIT_MAX, retryAfterSeconds: 60 }`.
- [ ] **Step 3: Run tests green; typecheck + lint + commit.**

### Task 3: Global limiter middleware

**Files:**
- Create: `src/middleware/rate-limit.ts`
- Test: `tests/integration/rate-limit.test.ts` (middleware section) — may mount an ad-hoc Hono app in the test.

- [ ] **Step 1: Write failing test.** Mount a minimal Hono app: `app.get('/_t', authMiddleware(), globalRateLimit(), c => c.json({ ok: true }))` (reuse `tests/helpers/app.ts`/`auth.ts` for a session). Seed `rate_limit` to the cap for that user → expect 429, body `error.code === 'RATE_LIMITED'`, header `Retry-After` present. Fail-open test: stub the service to throw → expect 200.
- [ ] **Step 2: Implement.** `globalRateLimit(): MiddlewareHandler<AppEnv>`:
  ```ts
  const user = requireUser(c);
  let result;
  try {
    result = await checkGlobalRateLimit(user.id);
  } catch (err) {
    c.get('log').warn({ err, userId: user.id }, 'rate-limit: check failed, allowing (fail-open)');
    return next();
  }
  if (!result.allowed) {
    c.header('Retry-After', String(result.retryAfterSeconds));
    throw new AppError('RATE_LIMITED', 'Rate limit exceeded', 429, {
      limit: GLOBAL_RATE_LIMIT_MAX, window_seconds: GLOBAL_RATE_LIMIT_WINDOW_MS / 1000,
    });
  }
  await next();
  ```
- [ ] **Step 3: Run tests green; typecheck + lint + commit.**

### Task 4: Wire middleware into authenticated routers

**Files:**
- Modify: `src/routes/me.ts`, `src/routes/species.ts`, `src/routes/specimens.ts`, `src/routes/identifications.ts`
- Test: `tests/integration/` route suites (existing) + one new 401 assertion

- [ ] **Step 1:** In each of the four routers, add at the top before the endpoints: `route.use('*', authMiddleware(), globalRateLimit());` and REMOVE the per-endpoint `authMiddleware()` argument from each `route.get/post/patch/put/delete(...)`. Keep per-endpoint `bodyLimit` and validators. (`router.use('*')` runs before endpoint middleware, so the limiter sees `c.user`.) Leave `health.ts` untouched.
- [ ] **Step 2:** Run the FULL existing test suite — all route tests must stay green (auth still enforced via router-level middleware). Add one test: an unauthenticated request to a previously-per-endpoint-auth route (e.g. `GET /v1/me`) still returns 401.
- [ ] **Step 3: typecheck + lint + commit.**

### Task 5: Cron cleanup

**Files:**
- Modify: `src/services/purge.ts`
- Test: `tests/integration/cron-purge.test.ts`

- [ ] **Step 1: Write failing tests.** Seed an expired `rate_limit` row (`expiresAt` in the past) + a fresh one; seed a stale `auth_rate_limit` row (`lastRequest = Date.now() - 2h`) + a fresh one (`lastRequest = Date.now()`). After `runPurgeCycle()`, expired/stale gone, fresh survive. Assert the boundary is strict.
- [ ] **Step 2: Implement.** Add `purgeExpiredRateLimits` (`DELETE FROM rate_limit WHERE expiresAt < now()`) and `purgeStaleAuthRateLimits` (`cutoff = Date.now() - AUTH_RATE_LIMIT_MAX_WINDOW_MS`; `db.delete(authRateLimit).where(lt(authRateLimit.lastRequest, cutoff))`). Return the existing `CategoryResult` shape; call both from `runPurgeCycle` and fold into `hadError`.
- [ ] **Step 3: Run tests green; typecheck + lint + commit.**

### Task 6: Account-deletion purge

**Files:**
- Modify: `src/services/account-deletion.ts`
- Test: `tests/integration/me-delete.test.ts`

- [ ] **Step 1: Write failing test.** Seed a `rate_limit` row with `key = 'global:' + userId`, call the delete-account flow, assert the row is gone.
- [ ] **Step 2: Implement.** Inside the existing transaction (before/after the user delete is fine — no FK), add `await tx.delete(rateLimit).where(eq(rateLimit.key, \`global:${userId}\`));`. Import `rateLimit` from `@/db/schema`.
- [ ] **Step 3: Run tests green; typecheck + lint + commit.**

### Task 7: README + memory

**Files:**
- Modify: `README.md`
- Modify: `/home/juloow/.claude/projects/-home-juloow-Documents-airbarium/memory/project_lot8c_ratelimit_deletion.md` (+ MEMORY.md index if wording changes)

- [ ] **Step 1:** README: add a lot 8c section (global limit 600/10min/user sliding window; auth limits now Postgres-backed via `auth_rate_limit`; cron cleanup of both tables) and bump the roadmap status line. No new env vars.
- [ ] **Step 2:** Update the memory note to record that the global limiter keys by `global:<userId>` (not email) and that the deletion purge is now implemented.
- [ ] **Step 3: commit.**

---

## Self-review notes
- **Spec coverage:** Tasks 1–2 (auth + global storage), 3–4 (middleware + wiring), 5 (cron), 6 (deletion), 7 (docs) cover spec §1–§8.
- **Type consistency:** service returns `{ allowed, retryAfterSeconds }` used verbatim by the middleware; `authRateLimit.lastRequest` is `bigint mode:'number'`, compared with `Date.now()` (number) in both BA and cron.
- **Risk:** Task 4 router-level auth refactor is the only behavioral change to existing code — full suite must stay green and a 401 test added.
