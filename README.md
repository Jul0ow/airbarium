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

Lots 1 (Bootstrap), 2 (DB & migrations), 3 (Auth), 4 (Storage), and 5 (Identifications) — Hono skeleton, `/v1/health` with DB probe, Drizzle schemas for users/species/identifications/specimens/plantnet_usage/rate_limit, Better Auth wiring with email/password + mailer + bearer plugin, `GET /v1/me`, `PATCH /v1/me`, Garage S3 adapter with presigned URLs, `PUT/DELETE /v1/me/avatar`, `POST /v1/identifications` + `GET /v1/species/:id` with PlantNet + Wikipedia integration and per-user daily quota, CI with Postgres + Garage services. See the 8-lot roadmap in [`CLAUDE.md`](CLAUDE.md).

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

## Lot 5 — Identifications quickstart

Lot 5 branche **PlantNet** (identification de fleurs) et **Wikipedia** (enrichissement des fiches espèces) sur le backend. Au boot, l'API crée aussi le bucket `specimens` (skip en `NODE_ENV=production`).

### Variables d'env à ajouter

```
PLANTNET_API_KEY=<ta-clé-plantnet>                    # obtenir sur https://my.plantnet.org/
WIKIPEDIA_USER_AGENT="Airbarium/0.1 (contact@…)"      # Wikipedia REST exige un User-Agent
```

PlantNet free tier : 500 identifications/jour partagées entre tous les utilisateurs. Le quota local par user est de **30/jour**, géré atomiquement en Postgres (`plantnet_usage` table). Reset à minuit UTC.

### `POST /v1/identifications` — identifier une fleur

Multipart : `photo` (file JPEG ≤ 2 Mo, magic bytes vérifiés) + EXIF facultatif via form fields séparés (`date_taken`, `gps_lat`, `gps_lng`).

```bash
curl -sS -X POST http://localhost:3000/v1/identifications \
  -H "Authorization: Bearer <token>" \
  -F "photo=@/path/to/flower.jpg;type=image/jpeg" \
  -F "date_taken=2026-05-15T10:00:00Z" \
  -F "gps_lat=48.85" \
  -F "gps_lng=2.34" | jq .
```

Réponse 201 :

```json
{
  "id": "0192…",
  "top_match": {
    "species_id": "0192…",
    "common_name": "Amaryllis du Japon",
    "scientific_name": "Lycoris radiata",
    "family": "Amaryllidaceae",
    "confidence": 0.9233,
    "reference_photo_url": "https://bs.plantnet.org/…",
    "description": null
  },
  "alternatives": [ { "species_id": "…", "confidence": 0.0099, "…": "…" }, { "…": "…" } ],
  "confidence_threshold": 0.7,
  "auto_pickable": true
}
```

- `auto_pickable: true` ⇒ confidence ≥ 0.70, le mobile peut créer le spécimen sans demander à l'utilisateur (Lot 6).
- `auto_pickable: false` ⇒ on présente les 3 candidats à l'utilisateur.
- `description` est `null` à la création — l'enrichissement Wikipedia tourne en arrière-plan (`queueMicrotask`), il faut relire la fiche species après.

La photo est stockée dans Garage sous `<user_id>/<identification_id>.jpg`, `photo_status='temp'`, `expires_at = now + 24h`. Sera consommée par `POST /v1/specimens` (Lot 6) ou purgée par le cron (Lot 8).

### `GET /v1/species/:id` — fiche espèce enrichie

```bash
curl -sS http://localhost:3000/v1/species/<species_id> -H "Authorization: Bearer <token>" | jq .
```

```json
{
  "id": "0192…",
  "common_name": "Amaryllis du Japon",
  "scientific_name": "Lycoris radiata",
  "family": "Amaryllidaceae",
  "description": "Le lycoris est un genre de plantes…",
  "reference_photo_url": "https://bs.plantnet.org/…",
  "wikipedia_url": "https://fr.wikipedia.org/wiki/Lycoris_radiata"
}
```

`description` et `wikipedia_url` peuvent être `null` si Wikipedia n'a pas d'article pour cette espèce (404 silencieux toléré — best-effort).

### Codes d'erreur attendus

| Status | Code | Cause |
|---|---|---|
| `400` | `MISSING_FIELD` | Pas de `photo` dans le multipart |
| `400` | `INVALID_CONTENT_TYPE` | `photo.type` ≠ `image/jpeg` |
| `400` | `INVALID_JPEG` | Magic bytes ne matchent pas `FF D8 FF` |
| `400` | `INVALID_EXIF` | `gps_lat`/`gps_lng` hors range ou `date_taken` malformé |
| `413` | `PAYLOAD_TOO_LARGE` | Body > 3 Mo (limite Hono) |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Content-type pas `multipart/form-data` |
| `422` | `NO_MATCH` | PlantNet n'a retourné aucun candidat — pas de refund quota |
| `429` | `QUOTA_EXCEEDED` | 30 identifications atteintes pour aujourd'hui (UTC) |
| `502` | `PLANTNET_UNAVAILABLE` | PlantNet 5xx/timeout/429 global — refund quota |

`GET /v1/species/:id` renvoie `404 NOT_FOUND` si l'ID est inconnu.
