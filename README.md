# Airbarium backend

Backend for the Airbarium flower identification app — Bun + Hono + PostgreSQL + Garage (S3).

Full design: [`docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md`](docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md).

## Quick start

```bash
cp .env.example .env
docker compose up -d        # postgres + garage + mailhog
bun install
bun run dev                 # API on :3000, hot reload
```

Health check: `curl http://localhost:3000/v1/health`.

## Scripts

| Script | Purpose |
|---|---|
| `bun run dev` | Hot-reload API on `$PORT` |
| `bun run start` | Production-style start (no watch) |
| `bun run test` | Run `bun test` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |

DB scripts (`db:generate`, `db:migrate`, `db:studio`) and `cron` are added in later lots.

## Status

Lot 1 (Bootstrap) — Hono skeleton, `/v1/health`, logger, request-id, error-handler, docker-compose, CI. See the 8-lot roadmap in [`CLAUDE.md`](CLAUDE.md).
