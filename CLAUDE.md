# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Airbarium — flower identification app. Backend: Bun + Hono + PostgreSQL + Garage (S3). See the full design doc for all architectural decisions: @docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md

## Commands

```bash
bun install              # install deps
bun run dev              # hot-reload API (bun --watch src/server.ts)
bun run start            # start API without watch (production-style)
bun run auth:secret      # generate a BETTER_AUTH_SECRET (run before db:migrate)
bun test                 # run all tests
bun run typecheck        # tsc --noEmit
bun run lint             # biome check .
bun run format           # biome format --write .
bun run db:generate      # generate Drizzle migration from schema changes
bun run db:migrate       # apply migrations to local DB
bun run db:studio        # open Drizzle Studio
docker build -t airbarium-api .          # build the API + cron image
hadolint Dockerfile                      # lint the Dockerfile
helm lint deploy/helm/airbarium-api -f deploy/helm/airbarium-api/ci/values-ci.yaml   # lint the chart
helm template airbarium deploy/helm/airbarium-api -f deploy/helm/airbarium-api/ci/values-ci.yaml | kubeconform -strict -summary -ignore-missing-schemas
```

## Local dev setup

Toolchain pinned via Nix flake — `nix develop` (or direnv `use flake`) provides `bun`, `biome`, `node`, `docker-compose`, `postgresql_17`, `gh`. Do not install these via `nix profile`.

Docker Compose is required before any dev or integration test run:

```bash
nix develop              # or: direnv allow (once)
docker compose up -d     # starts postgres:17-alpine + dxflrs/garage:v2.3.0 + mailhog
bun run db:migrate       # always run after compose up if schema changed
```

Dev emails visible at http://localhost:8025 (MailHog).

Required env vars (copy `.env.example`):
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GARAGE_ENDPOINT`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY`, `GARAGE_REGION`, `PLANTNET_API_KEY`, `SMTP_URL`, `MAIL_FROM`, `WIKIPEDIA_USER_AGENT`, `APP_URL`, `PORT`, `LOG_LEVEL`

Optional: `PUSHGATEWAY_URL` (Lot 8d) — when set, the cron pushes purge metrics to a Prometheus Pushgateway; unset means the cron only logs its purge counts.

## Testing

- **Unit tests** (`tests/unit/`) — services and lib adapters tested with mocks. PlantNet and Wikipedia calls are always mocked.
- **Integration tests** (`tests/integration/`) — require docker compose running. Hit real Postgres and Garage. Use `tests/helpers/db.ts` and `tests/helpers/app.ts`.
- External services (SMTP, PlantNet, Wikipedia) are mocked in CI; Postgres and Garage run as GitHub Actions services.

## Git conventions

- Branches: `feat/<description>`, `fix/<description>`, `chore/<description>`
- Commits: Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- One branch per PR lot from the roadmap (e.g. `feat/lot-1-bootstrap`, `feat/lot-3-auth`)
- Never prepend `cd <path> && git …` to target the main repo from a worktree — use `git -C <path> …` instead. The compound `cd && git` form does not match `Bash(git *)` in the permission allowlist and triggers a manual approval prompt every time.

## Architecture rules

- **Routes stay thin**: parse → delegate to service → format response. No business logic in routes.
- **Services** hold business logic and are usable without Hono (tested directly in unit tests and reused by cron).
- **`lib/`** isolates external adapters (PlantNet, Wikipedia, Garage, mailer) — mock at this boundary in tests.
- **Zod schemas** in `src/schemas/` are shared between route validators and service types.
- **UUIDv7** for all IDs. Specimen IDs are client-generated on mobile for idempotent offline sync.
- **Snapshot pattern**: `specimens` denormalizes `identified_name`, `scientific_name`, `family`, `confidence_score` from `species`. These fields are frozen at creation and never updated — do not try to sync them back from `species`.
- **Identification is immutable**: once a specimen has an identification, it cannot be changed. `POST /specimens/:id/identify` is only valid when `identification_source = 'none'`.
- **Presigned S3 URLs** (1h): always generate fresh presigned URLs when returning `photo_url` in responses. Never return raw Garage URLs.
- **Rate limiting backed by Postgres** — no Redis in MVP. Uses a `rate_limit` table.
- **Better Auth routes (`/v1/auth/*`) return Better Auth's native error shape** (`{ message, code }`), not our `{ error: { code, message } }` envelope. This is intentional — the BA client SDK depends on it.
- **Password reset request endpoint is `/v1/auth/request-password-reset`** (BA's actual route). Older docs may say `/forget-password` — that path is not exposed by our BA version.
- **Trusted origins and CORS origins must stay in sync** — both lists live in `src/auth/better-auth.ts` (`trustedOrigins`) and `src/app.ts` (`cors.origin`). Add new client origins to both.
- **`db:migrate` / `db:generate` need a valid `.env`** — `drizzle.config.ts` imports the Zod-validated env, which requires `BETTER_AUTH_SECRET` (32+ chars). Run `bun run auth:secret` and paste it into `.env` before any migration, otherwise the config fails to load.
- **OpenAPI contract is generated & committed** — the API exposes a 3.1 spec at `/openapi.json` (+ Scalar docs at `/docs`), built with `@hono/zod-openapi`. Component schemas live in `src/schemas/openapi.ts`, path registration in `src/openapi-doc.ts`. This documentation layer is **decoupled from the handlers** (it does not validate/intercept traffic — bespoke per-route error codes stay intact). The spec is snapshotted in `openapi.json`; **after any route/response change run `bun run openapi:gen`** — CI fails on a stale `openapi.json` diff. Better Auth routes are intentionally absent (native `{ message, code }` shape; mobile uses the BA SDK). The mobile client is generated from this spec (`openapi-typescript` + `openapi-fetch`).

## 8-lot roadmap

> Statut au 2026-06-14 : lots 1–7 livrés (offline sync mergé). Lot 8 en cours, découpé en sous-lots : 8a (RGPD `DELETE /v1/me` + réconciliation Garage), 8b (cron de purge, `src/cron.ts` + `bun run cron`), 8c (rate limiting Postgres + middleware), 8d (observabilité — `/metrics` Prometheus, sondes `/v1/health` + `/v1/health/ready`, Pushgateway cron) **livrés**. 8e (chart Helm `deploy/helm/airbarium-api/` + Dockerfile multi-stage + `CronJob` Kubernetes + Job de migration en hook + HTTPRoute Gateway API optionnel) **livré**. MVP backend complet (lots 1–8).

| # | Lot | Depends on |
|---|-----|-----------|
| 1 | Bootstrap (Hono skeleton, health, logger, CI) | — |
| 2 | DB & migrations (Drizzle schemas) | 1 |
| 3 | Auth (Better Auth, mailer, /me) | 1, 2 |
| 4 | Storage (Garage client, avatar upload) | 1, 3 |
| 5 | Identifications (PlantNet, quota, species) | 1–4 |
| 6 | Specimens online (POST/GET/PATCH/DELETE) | 1–5 |
| 7 | Offline sync + retry identify | 6 |
| 8 | RGPD + cron + observability + Helm | 6, 7 |

## Documentation

- **README à tenir à jour** — à la fin de chaque lot, mettre à jour le `README.md` racine pour refléter ce qui a été livré : nouvelles commandes, variables d'env ajoutées, endpoints exposés, étapes de setup local impactées, statut d'avancement de la roadmap. Pas de PR de lot mergée sans le passage README correspondant.
