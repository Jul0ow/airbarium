# Airbarium backend

Backend for the Airbarium flower identification app — Bun + Hono + PostgreSQL + Garage (S3).

Full design: [`docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md`](docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md).

## Quick start

```bash
cp .env.example .env
docker compose up -d        # postgres + garage + mailhog
bun install
bun run db:migrate          # apply schema to local postgres
bun run dev                 # API on :3000, hot reload
```

Health check: `curl http://localhost:3000/v1/health` returns `{ "status": "ok", "db": "ok" }` when Postgres is reachable.

## Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Hot-reload API on `$PORT` |
| `bun run start` | Production-style start (no watch) |
| `bun run test` | Run `bun test` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |
| `bun run db:generate` | Generate a Drizzle migration from schema changes |
| `bun run db:migrate` | Apply migrations to the local DB |
| `bun run db:studio` | Open Drizzle Studio |

`cron` is added in later lots.

## Status

Lots 1 (Bootstrap) and 2 (DB & migrations) — Hono skeleton, `/v1/health` with DB probe, Drizzle schemas for users/species/identifications/specimens/plantnet_usage/rate_limit, first migration, docker-compose, CI with Postgres service. See the 8-lot roadmap in [`CLAUDE.md`](CLAUDE.md).
