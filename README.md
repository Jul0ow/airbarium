# Airbarium backend

Backend for the Airbarium flower identification app — Bun + Hono + PostgreSQL + Garage (S3).

Full design: [`docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md`](docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md).

## Quick start

```bash
cp .env.example .env
# Required before db:migrate — drizzle.config.ts imports the validated env, which
# requires a BETTER_AUTH_SECRET (32+ chars). Generate one and add it to .env:
bun run auth:secret                # paste output into .env as BETTER_AUTH_SECRET=
docker compose up -d               # postgres + garage + mailhog
bun install
bun run db:migrate                 # apply schema to local postgres
bun run dev                        # API on :3000, hot reload
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

Lots 1 (Bootstrap), 2 (DB & migrations), 3 (Auth), and 4 (Storage) — Hono skeleton, `/v1/health` with DB probe, Drizzle schemas for users/species/identifications/specimens/plantnet_usage/rate_limit, Better Auth wiring with email/password + mailer + bearer plugin, `GET /v1/me`, `PATCH /v1/me`, Garage S3 adapter with presigned URLs, `PUT/DELETE /v1/me/avatar`, CI with Postgres + Garage services. See the 8-lot roadmap in [`CLAUDE.md`](CLAUDE.md).

## Lot 3 — Auth quickstart

1. **Generate a secret**: `bun run auth:secret` → copie le 64-char hex dans `.env`'s `BETTER_AUTH_SECRET=`
2. **Vérifie `.env`**: `BETTER_AUTH_URL`, `SMTP_URL`, `MAIL_FROM`, `APP_URL` doivent être renseignés (cf. `.env.example`)
3. **Up + migrate**: `docker compose up -d && bun run db:migrate`
4. **Dev**: `bun run dev`
5. **Sign-up**:

   ```bash
   curl -sS -X POST http://localhost:3000/v1/auth/sign-up/email \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"correct-horse-battery-staple","name":"You"}'
   ```

6. **Vérifie l'email** sur http://localhost:8025 (MailHog) → clique le lien
7. **Sign-in**:

   ```bash
   curl -sS -X POST http://localhost:3000/v1/auth/sign-in/email \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"correct-horse-battery-staple"}' \
     -i
   ```
   Récupère le header `set-auth-token: <token>` (ou `body.token`) pour les appels Bearer.

8. **Profil**:

   ```bash
   curl -sS http://localhost:3000/v1/me -H "Authorization: Bearer <token>"
   ```

## Lot 4 — Storage quickstart

Garage (S3-compatible) tourne dans le `docker compose` aux côtés de Postgres. Le service `garage-init` provisionne la layout cluster et importe la clé d'accès `GKDEV…` au premier démarrage — les valeurs sont déjà câblées dans `.env.example` (`GARAGE_ENDPOINT`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY`, `GARAGE_REGION`). Au boot, l'API crée le bucket `avatars` si absent (skip en `NODE_ENV=production`).

1. **Up**: `docker compose up -d` (postgres + garage + garage-init + mailhog)
2. **Upload avatar** (JPEG ≤ 2 Mo, magic bytes `FF D8 FF` vérifiés) :

   ```bash
   curl -sS -X PUT http://localhost:3000/v1/me/avatar \
     -H "Authorization: Bearer <token>" \
     -F "photo=@/path/to/photo.jpg;type=image/jpeg"
   # -> { "avatar_url": "http://localhost:3900/avatars/<user_id>.jpg?X-Amz-…" }
   ```

   Le `avatar_url` renvoyé est **pré-signé (1h)** — utilisable directement dans un `<Image src>` ou `curl`.

3. **Lire le profil** (le champ `avatar_url` est désormais pré-signé à chaque `GET /me`) :

   ```bash
   curl -sS http://localhost:3000/v1/me -H "Authorization: Bearer <token>"
   ```

4. **Supprimer l'avatar** :

   ```bash
   curl -sS -X DELETE http://localhost:3000/v1/me/avatar \
     -H "Authorization: Bearer <token>" -i   # 204
   ```

Codes d'erreur attendus : `400` (champ `photo` manquant ou content-type ≠ jpeg), `413` (> 2 Mo), `415` (pas multipart).
