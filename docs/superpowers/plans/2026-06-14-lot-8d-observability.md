# Lot 8d — Observability (`/metrics` Prometheus + health probes)

## Context

Lot 8 is the MVP polish lot; 8a–8c are merged. Lot 8d delivers the **observability** slice from design §10: a Prometheus `/metrics` endpoint and proper Kubernetes-style liveness/readiness probes. Today `/v1/health` exists but only probes Postgres, `/metrics` doesn't exist, and there's no metrics instrumentation anywhere. The lot-8 "done" criteria (§15) explicitly require the PlantNet quota to be observable in `/metrics`. Helm/CronJob wiring that consumes these (probes + Pushgateway) lands in the final lot 8e.

**Decisions locked in brainstorming (2026-06-14):**
- Library: **prom-client** (pure JS, safe on NixOS; matches design §3).
- Metric families: HTTP request histogram, PlantNet outcome counter, offline-sync ingestion counter, default Node/process metrics, **plus** a small business group (`users_total`, `specimens_total` scrape-time gauges). `db_pool_active` **dropped** (postgres.js doesn't expose pool internals cleanly).
- Health probes: keep bare `/v1/health` as **liveness** (DB-only, unchanged); add `/v1/health/ready` for **readiness** (DB + Garage, 503 if either down).
- Cron purge counters: pushed to a **Prometheus Pushgateway**, gated on a new optional `PUSHGATEWAY_URL` env (cron logs only when unset, so local/CI/tests need no gateway).

## Architecture

```
Request → requestId → httpLogger → metrics() histogram → secureHeaders → cors → handler
GET /metrics  (root, public, NOT under /v1) → render API registry
GET /v1/health        → liveness, DB only (unchanged)
GET /v1/health/ready  → readiness, DB + Garage
cron.ts → runPurgeCycle() → (if PUSHGATEWAY_URL) pushPurgeMetrics() → Pushgateway
```

Two **separate** prom-client registries so the short-lived cron never pulls in the API's HTTP/business collectors:
- `src/lib/metrics.ts` — **API registry**: default metrics, HTTP histogram, PlantNet counter, sync counter, business gauges, record helpers.
- `src/lib/cron-metrics.ts` — **cron registry** + `pushPurgeMetrics()`.

`recordPlantnet`/`recordSyncIngest` live in `lib/metrics.ts` and are imported by services the API uses (`lib/plantnet.ts`, `services/quota.ts`, `services/specimens.ts`) — none of which are on the cron import path.

## Metric inventory (`airbarium_` prefix, base-unit seconds)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `airbarium_http_request_duration_seconds` | Histogram (default buckets) | `method`, `route`, `status_code` | `middleware/metrics.ts` — its `_count` subsumes the §10.2 "per-status counter" |
| `airbarium_plantnet_requests_total` | Counter | `outcome` = `success`\|`no_match`\|`error`\|`quota_exceeded` | call boundary + quota gate |
| `airbarium_sync_ingest_total` | Counter | `result` = `identified`\|`unidentified` | `services/specimens.ts` offline branch |
| `airbarium_users_total` | Gauge (async `collect()`) | — | `SELECT count(*) FROM users WHERE deleted_at IS NULL` |
| `airbarium_specimens_total` | Gauge (async `collect()`) | — | `SELECT count(*) FROM specimens WHERE deleted_at IS NULL` |
| default process/node metrics | — | — | `collectDefaultMetrics({ register })` (once, at module load) |

**PlantNet outcome placement (principled split):**
- `quota_exceeded` is a **gate** outcome (no call made) → record in `services/quota.ts` `incrementOrThrow` right before throwing `QUOTA_EXCEEDED`. This is the §15 done-criteria metric and is testable (quota uses real DB, not the mocked lib).
- `success`/`no_match`/`error` describe the **call result** → record in `src/lib/plantnet.ts` `defaultImpl.identifyRaw`: wrap the body in `try { … record(results.length ? 'success' : 'no_match'); return … } catch (err) { record('error'); throw err }`. Centralizes all three call outcomes for online + offline-sync + retry in one place.

## Files

| Action | Path | Responsibility |
|---|---|---|
| Modify | `package.json` | add `prom-client` dependency |
| Create | `src/lib/metrics.ts` | API registry, metric defs, `recordPlantnet`/`recordSyncIngest`, business gauges, default metrics |
| Create | `src/middleware/metrics.ts` | `metrics()` middleware recording the HTTP histogram (separate from `httpLogger`) |
| Create | `src/routes/metrics.ts` | thin `GET /metrics` → `register.metrics()` with `register.contentType` |
| Modify | `src/app.ts` | mount `metrics()` after `httpLogger`; mount metrics route at root (not `/v1`) |
| Modify | `src/routes/health.ts` | add `/health/ready` (DB + Garage); bare `/health` untouched |
| Modify | `src/lib/garage.ts` | add `pingGarage()` to `Impl` (HeadBucket on `SPECIMENS_BUCKET`), export + stub support |
| Modify | `src/lib/plantnet.ts` | wrap `identifyRaw` to record success/no_match/error |
| Modify | `src/services/quota.ts` | record `quota_exceeded` on the limit throw |
| Modify | `src/services/specimens.ts` | record sync ingest in `createOffline` after `tryIdentifyOffline` |
| Create | `src/lib/cron-metrics.ts` | cron registry + `pushPurgeMetrics(result)` (Pushgateway, gated) |
| Modify | `src/config/env.ts` | add optional `PUSHGATEWAY_URL` (`z.string().url().optional()`) |
| Modify | `src/cron.ts` | call `pushPurgeMetrics(result)` before exit when `PUSHGATEWAY_URL` set |
| Modify | `.env.example`, `CLAUDE.md` (env list), `README.md` | document `PUSHGATEWAY_URL`, `/metrics`, readiness probe, roadmap status |
| Create | `docs/superpowers/specs/2026-06-14-lot-8d-observability-design.md`, `docs/superpowers/plans/2026-06-14-lot-8d-observability.md` | committed design + plan (project convention) |

## Tasks (subagent-driven, TDD)

**Task 0 — docs.** Write the design doc (decisions above) and a plan doc mirroring this file into `docs/superpowers/`; commit. (Matches the per-lot convention from 8a–8c.)

**Task 1 — metrics registry (`src/lib/metrics.ts`).** `bun add prom-client`. New `Registry`; `collectDefaultMetrics({ register })` once at load. Define the histogram, two counters, two business gauges (async `collect()` running the count queries via `@/db/client`). Export `register`, `recordPlantnet(outcome)`, `recordSyncIngest(result)`. **Unit test:** record helpers move the counters; `await register.metrics()` text contains each metric name; gauge `collect()` reflects seeded rows (integration — needs DB).

**Task 2 — HTTP histogram middleware (`src/middleware/metrics.ts`) + mount.** Mirror `httpLogger`'s wrap (`start` before `next`, observe in `finally`), labels `method`/`route`/`status_code` with `route = c.req.routePath`. Mount in `app.ts` right after `httpLogger`. **Integration test:** two requests to the same parameterized route (`/v1/specimens/:id` with different ids) produce a single label series (cardinality guard — verifies `routePath` yields the pattern, not the raw path); status_code label present.

**Task 3 — `/metrics` route + mount.** `routes/metrics.ts` returns `register.metrics()` with `register.contentType`; mount at root in `app.ts` (public, outside `/v1`). **Integration test:** after issuing one authenticated request, `GET /metrics` → 200 `text/plain`, body contains `airbarium_http_request_duration_seconds` and the business gauges.

**Task 4 — PlantNet outcome counter.** Wrap `identifyRaw` (success/no_match/error) in `lib/plantnet.ts`; record `quota_exceeded` in `quota.ts`. **Tests:** unit — stubbing the network/identifyRaw paths increments the expected outcome; integration — exhausting the 30/day quota increments `outcome="quota_exceeded"` and it shows in `/metrics` (the §15 criterion).

**Task 5 — sync ingestion counter.** In `createOffline`, after `tryIdentifyOffline`, `recordSyncIngest(final.identificationSource === 'none' ? 'unidentified' : 'identified')`. **Test:** offline POST with PlantNet stubbed to match → `identified`; stubbed to no_match/error → `unidentified`.

**Task 6 — readiness probe.** Add `pingGarage()` to `garage.ts` `Impl` (HeadBucket on `SPECIMENS_BUCKET`). Add `/v1/health/ready` → `{ status, db, garage }`, 200 when both ok else 503. **Tests:** integration — both up → 200; `__setGarageForTests({ pingGarage: throws })` → 503 with `garage:"down"`; bare `/v1/health` still 200 on DB-only.

**Task 7 — cron Pushgateway.** Add `PUSHGATEWAY_URL` to `env.ts`. `cron-metrics.ts`: own `Registry`, gauges `airbarium_purge_rows_deleted{category}`, `airbarium_purge_errored`, `airbarium_purge_last_run_timestamp_seconds`; `pushPurgeMetrics(result)` sets them from `PurgeCycleResult` and `new Pushgateway(url, [], reg).pushAdd({ jobName: 'airbarium-cron' })`, wrapped in try/catch (push failure logs warn, never fails cron). `cron.ts` calls it before `process.exit` only when `PUSHGATEWAY_URL` set. **Tests:** unit — `PUSHGATEWAY_URL` set → Pushgateway `pushAdd` invoked with the category values (mock the client); unset → not invoked, cron still exits 0.

**Task 8 — docs finalize.** `.env.example` (+ `# Lot 8d — observability` block), `CLAUDE.md` env list (`PUSHGATEWAY_URL`), `README.md` (new `/metrics` + readiness endpoints, metric inventory, roadmap status → 8d delivered). Update memory: new `project_lot8d_observability.md` (two registries, PlantNet outcome split, business gauges are scrape-time, Pushgateway gated by env) + MEMORY.md index line.

## Notes / risks
- **`c.req.routePath` cardinality** is the one real gotcha — Task 2's cardinality test must prove the label is the route *pattern*. If app-level middleware sees `/*`, fall back to deriving from `c.req.matchedRoutes`.
- **prom-client global registry** is module-singleton: metric assertion tests reset with `register.resetMetrics()` in `beforeEach` (or assert deltas).
- **`collectDefaultMetrics` is once-only** (throws if re-registered) — call at module load in `metrics.ts`, never per-request.
- **Separate cron registry** keeps the batch process off the API's collectors and avoids running the business `collect()` queries on push.
- `/metrics` self-counts in the histogram (it's behind `app.use('*')`); acceptable and standard.

## Verification (`nix develop --command`)
1. `bun run typecheck` + `bun run lint` clean.
2. `docker compose up -d` + `bun run db:migrate` (no schema change this lot, but confirm green).
3. `bun test` — all suites incl. new metrics/health/cron tests.
4. Manual: `bun run dev`, hit an authed endpoint, `curl localhost:3000/metrics` shows http histogram + business gauges; `curl localhost:3000/v1/health/ready` → 200 `{db,garage}`; stop Garage → readiness 503, liveness still 200.
5. Manual: `PUSHGATEWAY_URL` set + a local pushgateway → `bun run cron` lands `airbarium_purge_*` series; unset → cron logs only, exit 0.

## Execution
After approval: exit plan mode, commit the docs (Task 0), then run **subagent-driven-development** (fresh implementer per task + separate spec-compliance and code-quality reviewers, per the established lot workflow) in an isolated worktree branched `feat/lot-8d-observability`.
