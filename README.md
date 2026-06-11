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

Lots 1 (Bootstrap), 2 (DB & migrations), 3 (Auth), 4 (Storage), 5 (Identifications), 6 (Specimens online), et 7 (Sync offline + retry identify) — Hono skeleton, `/v1/health` with DB probe, Drizzle schemas for users/species/identifications/specimens/plantnet_usage/rate_limit, Better Auth wiring with email/password + mailer + bearer plugin, `GET /v1/me`, `PATCH /v1/me`, Garage S3 adapter with presigned URLs, `PUT/DELETE /v1/me/avatar`, `POST /v1/identifications` + `GET /v1/species/:id` with PlantNet + Wikipedia integration and per-user daily quota, `POST/GET/PATCH/DELETE /v1/specimens` + `GET /v1/specimens/stats` with idempotent UUIDv7, threshold-validated promotion, cursor-paginated lists and filters, soft delete, CI with Postgres + Garage services, `POST /v1/specimens` en multipart pour la sync offline avec identification synchrone best-effort + `POST /v1/specimens/:id/identify` pour retry (Lot 7). See the 8-lot roadmap in [`CLAUDE.md`](CLAUDE.md).

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

## Lot 6 — Specimens quickstart

L'API specimens transforme une identification temporaire en entrée permanente dans la bibliothèque de l'utilisateur. Flux online uniquement (le mobile fournit `identification_id` + `chosen_species_id`). Lot 7 ajoutera la branche offline-sync.

### Workflow type

1. `POST /v1/identifications` (multipart) → réponse contient `id`, `top_match.species_id`, `alternatives[]`, `auto_pickable`.
2. Le mobile génère un UUIDv7 local pour le specimen.
3. `POST /v1/specimens` avec `{ id, identification_id, chosen_species_id, identification_source, collected_at, ... }`.

`identification_source` est strictement dérivé du seuil 0.70 :
- `top.confidence >= 0.70` ⇒ doit être `plantnet_auto`, et `chosen_species_id` doit être le top match.
- `top.confidence < 0.70` ⇒ doit être `plantnet_picked` (le mobile a fait choisir l'utilisateur parmi top + 2 alternatives).

### Endpoints

| Méthode | Path | Notes |
|---|---|---|
| POST | `/v1/specimens` | Idempotent sur `id`. 201 = créé, 200 = no-op (replay même user), 409 = id existant pour un autre user. |
| GET | `/v1/specimens` | Cursor-based : `?cursor&limit=20&sort&q&family&date_from&date_to`. Filtres combinables en AND. |
| GET | `/v1/specimens/stats` | `{ total, distinct_species }` sur les specimens actifs. |
| GET | `/v1/specimens/:id` | Specimen complet, `photo_url` pré-signé 1h. 404 cross-user. |
| PATCH | `/v1/specimens/:id` | Body `{ user_notes?, location_label? }`. `null` = clear. Au moins un champ requis. |
| DELETE | `/v1/specimens/:id` | Soft delete (204). La photo Garage reste jusqu'au cron Lot 8 (purge 30j). |

### Exemple

```bash
TOKEN=...
IDENT_ID=...      # from POST /v1/identifications
SPECIES_ID=...    # from top_match.species_id
SID=$(bun -e 'import { uuid7 } from "./src/utils/uuid.ts"; console.log(uuid7())')

curl -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$SID\",
    \"identification_id\": \"$IDENT_ID\",
    \"chosen_species_id\": \"$SPECIES_ID\",
    \"identification_source\": \"plantnet_auto\",
    \"collected_at\": \"2026-06-07T10:00:00Z\",
    \"location_label\": \"Jardin du Luxembourg\"
  }"

# Replay même body → 200 (idempotent)
# GET /v1/specimens → liste
# GET /v1/specimens/stats → {total:1, distinct_species:1}
# PATCH user_notes → 200
# DELETE → 204, GET /:id → 404
```

### Pagination cursor

Le `next_cursor` est un base64url opaque encodant `{ k, v, id }` (colonne de tri, valeur, tie-breaker). Le client le passe verbatim au prochain appel via `?cursor=...`. `null` = pas de page suivante.

Sort options : `collected_at_desc` (défaut), `created_at_desc`, `name_asc`.

### Codes d'erreur

| Status | Code | Cause |
|---|---|---|
| `400` | (Zod) | Body invalide (champ manquant, type, longueur, `identification_source=none` refusé) |
| `400` | `INVALID_CHOICE` | `chosen_species_id` ne fait pas partie des candidats PlantNet de cette identification |
| `400` | `THRESHOLD_VIOLATED` | Règle du seuil 0.70 violée (mauvaise combinaison confidence/source/choice) |
| `400` | `INVALID_CURSOR` | Cursor malformé (pas base64url ou JSON invalide ou clé `k` inconnue) |
| `404` | `SPECIMEN_NOT_FOUND` | Specimen inexistant, cross-user, ou soft-deleted |
| `404` | `IDENTIFICATION_NOT_FOUND` | Identification inexistante ou cross-user |
| `409` | `ID_CONFLICT` | `id` existe déjà pour un autre user |
| `409` | `ALREADY_PROMOTED` | Identification déjà consommée par un specimen précédent |
| `410` | `IDENTIFICATION_EXPIRED` | Identification créée il y a plus de 24h (purge Lot 8 à venir) |

### Notes d'implémentation

- **Pas de copy S3** : `specimens.photo_url` réutilise la clé Garage de l'identification (`<user_id>/<identification_id>.jpg`). On flip uniquement `identifications.photo_status='promoted'` + `promoted_at=now()` dans la même transaction que l'INSERT specimen.
- **Snapshot dénormalisé** : `identified_name`, `scientific_name`, `family`, `confidence_score` sont figés au moment du POST. Une mise à jour future de `species.description` (Wikipedia) ne change pas ce qui est stocké sur le specimen.
- **Idempotence stricte** : un replay POST avec le même `id` ignore TOUT le reste du body et renvoie le specimen existant (200, no-op).
- **Race condition** : si 2 POSTs concurrents tentent de promouvoir la même identification, Postgres serialise l'UPDATE conditionnel `WHERE photo_status='temp'` — le perdant voit 0 row et lève 409 `ALREADY_PROMOTED`, sa transaction (INSERT specimen inclus) est rollback.

## Lot 7 — Offline sync + retry identify

Deux cas où le flux online de Lot 6 ne s'applique pas : le mobile a pris des photos **hors-ligne** (pas d'identification préalable), et un specimen resté non identifié doit pouvoir être ré-identifié plus tard.

### Sync offline — `POST /v1/specimens` en multipart

Le même endpoint que Lot 6, mais en `multipart/form-data` au lieu de JSON. Le serveur stocke la photo dans Garage (`<user_id>/<specimen_id>.jpg`) puis tente une identification PlantNet **synchrone** (timeout 10s). **Le seuil 0.70 n'est PAS appliqué** : l'utilisateur n'étant pas présent pour arbitrer, le top match est retenu quelle que soit sa confidence (`identification_source='plantnet_auto'`).

Si PlantNet est indisponible, en timeout, ou si le quota est épuisé, le specimen est tout de même créé avec `identification_source='none'` et un **201** est retourné — un batch de sync de 50 photos ne doit jamais échouer à cause d'un hoquet PlantNet. Le mobile retentera via `/:id/identify`.

| Champ (form-data) | Requis | Notes |
|---|---|---|
| `id` | oui | UUIDv7 généré côté mobile. Idempotent. |
| `photo` | oui | `image/jpeg`, ≤ 2 Mo, magic bytes validés. |
| `identification_source` | oui | doit valoir `none`. |
| `collected_at` | oui | ISO 8601 avec offset. |
| `lat`, `lng` | non | coordonnées, bornées. |
| `location_label`, `user_notes` | non | texte libre. |

```bash
TOKEN=...
SID=$(bun -e 'import { uuid7 } from "./src/utils/uuid.ts"; console.log(uuid7())')

curl -X POST http://localhost:3000/v1/specimens \
  -H "Authorization: Bearer $TOKEN" \
  -F "id=$SID" \
  -F "identification_source=none" \
  -F "collected_at=2026-06-11T12:00:00Z" \
  -F "photo=@./flower.jpg"
# → 201 : specimen identifié (plantnet_auto) si PlantNet OK, sinon source='none'
# Replay même id → 200 (idempotent, pas de ré-upload)
```

### Retry identify — `POST /v1/specimens/:id/identify`

Ré-identifie un specimen resté `identification_source='none'`. Le serveur re-télécharge la photo depuis Garage et la repasse à PlantNet (même règle qu'en offline-sync : pas de seuil). Body vide.

```bash
curl -X POST http://localhost:3000/v1/specimens/$SID/identify \
  -H "Authorization: Bearer $TOKEN"
# → 200 specimen mis à jour avec le snapshot d'identification
```

### Codes d'erreur (Lot 7)

| Status | Code | Cause |
|---|---|---|
| `400` | `MISSING_FIELD` | Champ `photo` absent en multipart |
| `400` | `INVALID_CONTENT_TYPE` | `photo` n'est pas `image/jpeg` |
| `400` | `VALIDATION` | Champs multipart invalides (`identification_source` ≠ `none`, etc.) |
| `409` | `ALREADY_IDENTIFIED` | Retry sur un specimen déjà identifié (immuable) |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | Content-Type ni `application/json` ni `multipart/form-data` |
| `422` | `NO_MATCH` | PlantNet n'a renvoyé aucun candidat (retry ; quota consommé) |
| `429` | `QUOTA_EXCEEDED` | Quota PlantNet quotidien (30/jour) épuisé (retry) |
| `500` | `PHOTO_NOT_FOUND` | Photo absente de Garage alors que le specimen existe (retry) |
| `502` | `PLANTNET_UNAVAILABLE` | PlantNet KO (retry ; quota remboursé) |

### Notes d'implémentation

- **Même `create()`, deux branches** : `POST /v1/specimens` bifurque sur le `Content-Type`. La branche JSON (Lot 6) est inchangée ; la branche multipart partage le check d'idempotence puis suit le flux offline.
- **Quota** : convention Lot 5 — l'appel PlantNet est compté avant exécution, remboursé uniquement sur erreur ≠ 200 (timeout / 5xx / quota global) ou photo manquante. **Jamais remboursé sur `no_match`** (résultats vides = 200 légitime).
- **Best-effort en offline** : l'identification synchrone du flux offline ne fait jamais échouer le POST. Toute erreur (PlantNet, quota, ou même une panne DB après l'insert) laisse le specimen en `source='none'`, récupérable via le retry.
- **Immutabilité** : `/:id/identify` n'est valide que si `identification_source='none'`. Une identification posée ne se remplace pas (409).
