# Airbarium — Design backend MVP

> Date : 2026-05-26
> Version : 1.0 (issue du cahier des charges v1.1)
> Périmètre : backend MVP (V1) — API REST, persistence, identification, sync offline
> Statut : design validé, prêt pour plan d'implémentation

---

## 1. Vue d'ensemble

Ce document complète le cahier des charges Airbarium v1.1 pour le **backend MVP uniquement**. Le frontend (React Native + Expo) est conçu en parallèle et n'est pas traité ici.

L'objectif de ce design est de fournir les éléments manquants du cahier des charges pour pouvoir attaquer l'implémentation sans ambiguïté : choix techniques tranchés, modèle de données complet, contrat API, flux détaillés, structure de code, plan de découpage en PRs.

**Ambition retenue :** "intermédiaire pragmatique". Le MVP intègre dès le départ un socle non-négociable (reset password, vérification email, suppression de compte RGPD, logs structurés, rate limit PlantNet) mais reporte tout ce qui n'est pas indispensable au lancement (export RGPD complet, 2FA, observabilité avancée, anonymisation des photos pour ML).

---

## 2. Décisions structurantes

Synthèse des choix actés lors du brainstorming. Chaque ligne tranche un point laissé ouvert (ou absent) dans le cahier des charges.

| Sujet | Choix retenu | Raison principale |
|---|---|---|
| Auth | Better Auth (email + password) | Léger, intégré à Hono, bonne synergie Bun |
| OAuth providers | Aucun en MVP (email/password seul) | À réintroduire après mise en store |
| Gestion de compte | Reset password + verify email + delete account + avatar upload | Tous "intermédiaire pragmatique" |
| ORM Postgres | Drizzle + drizzle-kit | TypeScript-first, léger, adapter Better Auth officiel |
| Stockage photos | **Garage** (S3-compatible) | Plus simple à opérer que SeaweedFS, footprint RAM faible, S3 pur |
| Workflow identification | Deux endpoints (`POST /identifications` puis `POST /specimens`) | Séparation des responsabilités, support naturel du flux offline |
| Identification post-PlantNet | Auto-pick si `confidence ≥ 0.70`, sinon choix utilisateur parmi 3 candidats PlantNet. **Pas de saisie manuelle libre.** | Cadre strict, validé en brainstorming |
| Cas "rien ne convient" | L'utilisateur reprend une photo. Aucun spécimen créé sans identification (sauf flux offline-sync). | Strict |
| IDs spécimens | UUIDv7 **client-generated** côté mobile | POST idempotent, robuste retry / coupure réseau, sync offline naturelle |
| Référentiel `species` | **Lazy upsert** lors de chaque identification PlantNet, FK depuis `specimens` + **snapshot dénormalisé** | Audit historique stable, perf lecture bibliothèque |
| Description / photo de référence | Wikipedia / Wikidata REST API en best-effort | PlantNet ne fournit pas de descriptions |
| Suppression spécimen | Soft delete (`deleted_at`), photo conservée | Préserve la donnée pour ML futur |
| Suppression de compte | **Hard delete** complet (DB + Garage) en MVP. La conservation anonymisée pour ML sera ajoutée en V2 avec consentement explicite. | RGPD safe par défaut |
| Trace identifications | Table dédiée avec `plantnet_raw_response` JSONB | Audit + futur entraînement ML |
| Quota PlantNet | Rate limit local par user (30 identifications / jour) + fallback gracieux | Free tier PlantNet est partagé : 500/jour |
| URLs photos | **URLs pré-signées S3** (durée 1h), générées à la lecture | Équilibre sécurité / perf |
| Tests | Unit + integration sur endpoints critiques | Couverture comportementale, mocks pour services externes |
| Dev local | `docker-compose` (Postgres + Garage + MailHog) | Reproductible, léger |
| Versionnage API | Prefix `/v1/` | Standard, permet une V2 future cohabitante |

---

## 3. Stack consolidée

| Couche | Choix | Notes |
|---|---|---|
| Runtime | Bun | TypeScript natif, démarrage rapide, image Docker officielle |
| Framework HTTP | Hono | Léger, type-safe, middlewares natifs (CORS, secureHeaders) |
| Validation | `@hono/zod-validator` + Zod | Schémas partagés entre routes et services |
| Auth | Better Auth + adapter Drizzle | Sessions cookie + Bearer pour mobile |
| ORM | Drizzle + drizzle-kit | Migrations versionnées |
| DB | PostgreSQL 17 | PostGIS pas requis en MVP (V2) |
| Stockage objets | Garage (S3) + `@aws-sdk/client-s3` | Buckets `specimens`, `avatars` |
| HTTP externe | `fetch` Bun natif | PlantNet, Wikipedia |
| Mailer | `nodemailer` (SMTP) | MailHog en dev, provider externe en prod (Brevo / Postmark) |
| Logs | `pino` JSON structuré | stdout, collecté par l'infra |
| Métriques | `prom-client` Prometheus | endpoint `/metrics` |
| Tests | `bun test` + Hono testing client + Postgres réel | Pas d'E2E en MVP |
| Lint / format | Biome | Plus rapide qu'ESLint, suffit pour ce périmètre |
| CI | GitHub Actions | services Postgres + Garage dans le job |

---

## 4. Architecture

```
Mobile (React Native + Expo)
   │  HTTPS, session cookie ou Bearer
   ▼
airbarium-api (Bun + Hono)            airbarium-cron (Bun, même image)
   ├── routes/                          └── purge identifications temp
   ├── services/                            purge specimens soft-deleted > 30j
   ├── db/ (Drizzle)                        cleanup plantnet_usage > 7j
   └── lib/ (adaptateurs externes)
        │
        ├── Postgres (Drizzle ORM)
        ├── Garage (S3-compatible, photos + avatars)
        ├── SMTP (MailHog dev / provider prod) — verify email + reset password
        ├── PlantNet API — identifications
        └── Wikipedia REST API — enrichissement species (best-effort)
```

Deux processus Bun distincts à partir de la même image Docker :
- `bun run dev` / `bun src/server.ts` : HTTP
- `bun src/cron.ts` : worker périodique

Pas de file de jobs en MVP. Le cron tourne en boucle simple avec `setInterval` (intervalle 1h).

---

## 5. Modèle de données

### 5.1 Tables métier (gérées par Drizzle)

#### `users` (étend la table user de Better Auth)

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | UUIDv7, server-generated |
| email | text UNIQUE NOT NULL | |
| email_verified | bool NOT NULL default false | piloté par Better Auth |
| name | text NOT NULL | pseudo affiché, non-unique |
| avatar_url | text | clé Garage `avatars/<user_id>.jpg` |
| created_at | timestamptz NOT NULL default now() | |
| updated_at | timestamptz NOT NULL default now() | |
| deleted_at | timestamptz | RGPD : à terme `DELETE /me` purge la ligne ; ce champ permet une rétention courte si besoin opérationnel |

#### `species` (référentiel partagé, lazy upsert)

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | UUIDv7 |
| scientific_name | text UNIQUE NOT NULL | clé naturelle (upsert) |
| common_name | text | |
| family | text | |
| description | text | Wikipedia, FR, ~200 caractères |
| reference_photo_url | text | URL externe PlantNet ou Wikipedia |
| wikipedia_url | text | |
| wikipedia_fetched_at | timestamptz | marqueur de tentative, évite retry infini |
| rarity_level | int | NULL en MVP, utilisé en V2 |
| created_at, updated_at | timestamptz | |

#### `identifications` (audit trail PlantNet, photos temporaires)

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | UUIDv7 |
| user_id | uuid FK users NOT NULL | |
| photo_url | text NOT NULL | clé Garage `specimens/<user_id>/<identification_id>.jpg` |
| photo_status | enum('temp','promoted','expired') NOT NULL default 'temp' | |
| plantnet_raw_response | jsonb NOT NULL | réponse PlantNet complète |
| top_match_species_id | uuid FK species | |
| top_match_confidence | numeric(5,4) | 0–1 |
| exif_metadata | jsonb | `{date_taken?, gps_lat?, gps_lng?}` |
| created_at | timestamptz default now() | |
| expires_at | timestamptz | `created_at + 24h` pour les `temp` |
| promoted_at | timestamptz | set quand un spécimen consomme cette identification |

#### `specimens` (cœur métier, ID client-generated)

| Colonne | Type | Notes |
|---|---|---|
| id | uuid PK | UUIDv7 **généré côté mobile** |
| user_id | uuid FK users NOT NULL | |
| identification_id | uuid FK identifications | NULL pour les spécimens créés via sync offline non encore identifiés |
| species_id | uuid FK species | NULL si non identifié |
| photo_url | text NOT NULL | clé Garage `specimens/<user_id>/<specimen_id>.jpg` |
| identified_name | text | **snapshot** au moment de l'ajout |
| scientific_name | text | **snapshot** |
| family | text | **snapshot** |
| confidence_score | numeric(5,4) | **snapshot** |
| identification_source | enum('plantnet_auto','plantnet_picked','none') NOT NULL default 'none' | voir §5.2 |
| lat | numeric(9,6) | |
| lng | numeric(9,6) | |
| location_label | text | input libre user, pas de reverse geocoding en MVP |
| user_notes | text | |
| collected_at | timestamptz NOT NULL | EXIF `date_taken` sinon `now()` |
| created_at | timestamptz NOT NULL default now() | |
| updated_at | timestamptz NOT NULL default now() | |
| deleted_at | timestamptz | soft delete |

#### `plantnet_usage` (rate limit par user / jour)

| Colonne | Type | Notes |
|---|---|---|
| user_id | uuid FK users | composite PK |
| day | date | composite PK |
| count | int NOT NULL default 0 | |

### 5.2 Sémantique de `identification_source`

- `plantnet_auto` : top match PlantNet accepté **sans intervention utilisateur**. Couvre deux cas :
  - flux online avec `top_match.confidence ≥ 0.70` (auto-pick via la règle du seuil)
  - flux offline-sync où l'API identifie côté serveur et retient le top match (l'utilisateur n'est pas présent pour choisir)
- `plantnet_picked` : flux online avec `top_match.confidence < 0.70`, l'utilisateur a explicitement choisi un des 3 candidats PlantNet (top inclus)
- `none` : créé sans identification (sync offline avec PlantNet KO/quota épuisé, ou retry `/identify` non encore exécuté)

**L'utilisateur ne peut jamais saisir une identification libre.** Le seul moyen d'avoir `species_id` non-NULL est de passer par PlantNet. Une identification, une fois posée sur un spécimen, **n'est pas modifiable** : si l'utilisateur n'est pas satisfait, il supprime le spécimen et reprend une photo.

### 5.3 Snapshot dénormalisé

`specimens` duplique `identified_name`, `scientific_name`, `family`, `confidence_score` qui pourraient être lus via la jointure `species`. Ce snapshot est figé au moment de l'ajout pour :

1. **Stabilité historique** : si Wikipedia corrige une fiche `species` plus tard, les spécimens passés conservent l'identité validée à l'époque
2. **Performance** : la liste paginée de la bibliothèque ne nécessite pas de JOIN
3. **Audit** : on sait exactement ce qui a été présenté à l'utilisateur

Coût : 3 colonnes texte dupliquées par spécimen. Négligeable au volume MVP.

### 5.4 Tables Better Auth (auto-générées)

`account`, `session`, `verification` — gérées par Better Auth via son schéma Drizzle, on n'écrit pas la logique.

### 5.5 Index clés

- `specimens (user_id, deleted_at, collected_at DESC)` — pagination bibliothèque
- `specimens (user_id, species_id) WHERE deleted_at IS NULL` — compteur d'espèces distinctes
- `species (scientific_name)` UNIQUE — upsert
- `identifications (expires_at) WHERE photo_status = 'temp'` — cron de purge
- `identifications (user_id, created_at DESC)`
- `plantnet_usage (user_id, day)` — PK composite, accès direct

---

## 6. API REST `/v1/*`

### 6.1 Conventions

- **Auth** : toutes les routes sauf `/v1/auth/*` et `/v1/health` requièrent une session valide (cookie Better Auth ou `Authorization: Bearer <token>`)
- **Erreurs** : enveloppe `{ error: { code: string, message: string, details?: any } }`, status HTTP cohérent
- **Pagination** : cursor-based : `?cursor=<uuid>&limit=20`, réponse `{ data, next_cursor }`
- **Timestamps** : ISO 8601 UTC
- **IDs** : UUID format string

### 6.2 Auth (montée Better Auth)

```
POST   /v1/auth/sign-up                { email, password, name }
POST   /v1/auth/sign-in                { email, password }
POST   /v1/auth/sign-out
GET    /v1/auth/session                -> { user, session } | 401
POST   /v1/auth/send-verification-email
GET    /v1/auth/verify-email?token=…
POST   /v1/auth/forget-password        { email }
POST   /v1/auth/reset-password         { token, new_password }
```

### 6.3 Profil

```
GET    /v1/me                          -> { id, email, email_verified, name, avatar_url, created_at }
PATCH  /v1/me                          { name? }
PUT    /v1/me/avatar                   multipart : file -> { avatar_url }
DELETE /v1/me/avatar
DELETE /v1/me                          // RGPD : hard delete DB + Garage
```

### 6.4 Identifications

```
POST   /v1/identifications             multipart :
                                         photo : file (image/jpeg, ≤ 2 Mo, ≤ 2000×2000)
                                         exif  : json { date_taken?, gps_lat?, gps_lng? }
                                       -> 201 {
                                         id,
                                         top_match : {
                                           species_id, common_name, scientific_name, family,
                                           confidence, reference_photo_url, description
                                         },
                                         alternatives : [ { species_id, ..., confidence } ],  // 2 candidats
                                         confidence_threshold : 0.70,
                                         auto_pickable : boolean
                                       }
                                       -> 422 si PlantNet ne renvoie aucun candidat
                                       -> 429 si quota user épuisé
                                       -> 502 si PlantNet KO
```

Notes :
- La photo uploadée est stockée dans Garage avec `photo_status = 'temp'`, `expires_at = now() + 24h`
- Les `species` du top + alternatives sont upsertées en base au passage
- L'enrichissement Wikipedia est déclenché en best-effort en arrière-plan pour chaque nouvelle espèce
- Pas de `GET /v1/identifications/:id` en MVP : la donnée est consommée par `POST /v1/specimens` ou expire

### 6.5 Spécimens

```
GET    /v1/specimens
       ?cursor=&limit=20&sort=collected_at_desc&q=&family=&date_from=&date_to=
                                       -> { data : [specimen, ...], next_cursor }
                                       // q : recherche simple sur identified_name (ILIKE)
                                       // sort : collected_at_desc (def) | created_at_desc | name_asc

GET    /v1/specimens/:id               -> specimen complet (photo_url pré-signée, durée 1h)

POST   /v1/specimens                   multipart OU JSON selon flux :
                                       {
                                         id : uuid7,                            // mobile-generated, IDEMPOTENT
                                         identification_id? : uuid,             // flux online
                                         chosen_species_id? : uuid,             // requis si identification_id
                                         identification_source : 'plantnet_auto'|'plantnet_picked'|'none',
                                         photo? : file,                         // requis si pas d'identification_id (offline-sync)
                                         collected_at : timestamp,
                                         lat?, lng?, location_label?, user_notes?
                                       }
                                       -> 201 specimen
                                       -> 200 si id ∈ DB pour ce user (idempotent)
                                       -> 409 si id ∈ DB pour un autre user

PATCH  /v1/specimens/:id               { user_notes?, location_label? }
                                       // seuls champs modifiables

DELETE /v1/specimens/:id               // soft delete

POST   /v1/specimens/:id/identify      // retry identification quand source='none'
                                       -> 200 specimen mis à jour
                                       -> 429 / 502 selon contexte

GET    /v1/specimens/stats             -> { total, distinct_species }
```

### 6.6 Species

```
GET    /v1/species/:id                 -> { id, common_name, scientific_name, family,
                                            description, reference_photo_url, wikipedia_url }
```

Pas de liste — utile uniquement en V2 pour le catalogue de rareté.

### 6.7 Divers

```
GET    /v1/health                      -> { status, db, garage, plantnet }
GET    /metrics                        // Prometheus format, non-versionné
```

---

## 7. Flux clés

### 7.1 Flux A — Identification + ajout (online)

1. Mobile compresse / redimensionne la photo (`expo-image-manipulator`, 2000px max, JPEG 85%)
2. Mobile extrait l'EXIF avant compression et le sépare
3. `POST /v1/identifications` (multipart photo + json exif)
4. API : check quota → upload Garage `<user>/<ident>.jpg` (status `temp`) → appel PlantNet → upsert species → insert `identifications` → réponse
5. Mobile :
   - Si `auto_pickable = true` : crée le spécimen sans UI de sélection
   - Sinon : affiche top + 2 alternatives, l'utilisateur choisit ; si rien ne convient, retake photo (abandonne, pas de POST)
6. `POST /v1/specimens` avec `id` UUIDv7, `identification_id`, `chosen_species_id`, `identification_source`
7. API : valide cohérence (seuil, candidat ∈ identification) → rename objet Garage en `<user>/<specimen>.jpg` → tx insert specimen + flip `identifications.photo_status = 'promoted'`

**Validations côté API à `POST /v1/specimens`** :
- `identification_id` doit appartenir au user, `photo_status = 'temp'`, non expiré
- `chosen_species_id ∈ { top_match.species_id ∪ alternatives[].species_id }` de l'identification
- Si `top_match.confidence ≥ 0.70` ⇒ `chosen_species_id == top_match.species_id` ET `identification_source == 'plantnet_auto'`
- Sinon ⇒ `identification_source == 'plantnet_picked'`
- Violation ⇒ 400

### 7.2 Flux B — Sync offline

Le mobile a accumulé des spécimens hors-ligne (UUIDv7 générés localement, photos compressées en SQLite). À la reconnexion :

```
pour chaque spécimen en attente, dans l'ordre FIFO :
  POST /v1/specimens
    multipart :
      id = <uuid7 local>
      photo = <jpeg>
      identification_source = 'none'
      collected_at, lat, lng, location_label, user_notes
      (PAS de identification_id ni chosen_species_id)

  api :
    1. idempotence : si id ∈ DB pour ce user → retour 200, ack
    2. upload Garage <user>/<specimen>.jpg
    3. insert specimen, species_id NULL, source='none'
    4. tentative identification synchrone (timeout 10s) :
       - si quota OK : appel PlantNet → upsert species → update specimen avec FK + snapshot + source='plantnet_auto'
         **En flux offline-sync, le seuil 70% n'est PAS appliqué côté serveur** : on retient toujours le top match avec sa confidence, quelle qu'elle soit. L'utilisateur n'étant pas présent, lui demander de choisir a posteriori serait une UX confuse. Le mobile peut afficher un warning visuel si confidence basse, sans bloquer.
       - si KO / quota / no_match : specimen reste source='none', species_id=NULL
    5. retour 201 specimen complet

  mobile :
    - retire de la queue locale au reçu d'un 2xx
    - si specimen.species_id == NULL, garde un indicateur visuel "non identifié" → propose `POST /specimens/:id/identify` pour retenter ultérieurement
```

**Comportement de `POST /v1/specimens/:id/identify`** :
- Valide uniquement si le spécimen a `identification_source = 'none'` (sinon 409 — une identification posée n'est pas modifiable)
- Vérifie le quota PlantNet du user
- Re-télécharge la photo depuis Garage et la renvoie à PlantNet
- En cas de succès : met à jour le spécimen avec le top match + snapshot + source='plantnet_auto' (même règle qu'en offline-sync, pas de seuil)
- En cas d'échec : le spécimen reste `'none'`, le retry pourra être retenté

**Conflit `last-write-wins`** (cf. cahier des charges §4.5) : appliqué uniquement au PATCH `user_notes`. Pas d'optimistic locking en MVP. Acceptable tant que le multi-device n'est pas implémenté.

### 7.3 Flux C — Suppression de compte (RGPD)

```
DELETE /v1/me
  1. transaction Postgres :
       a. SELECT photo_url FROM specimens WHERE user_id=:me  → liste à purger
       b. SELECT photo_url FROM identifications WHERE user_id=:me → idem
       c. SELECT avatar_url FROM users WHERE id=:me
       d. DELETE FROM users WHERE id=:me     // cascade vers specimens, identifications, sessions
  2. delete objets Garage (best-effort, idempotent, hors transaction) :
       - bucket=specimens, prefix=<user_id>/
       - bucket=avatars,    key=<user_id>.jpg
     erreurs Garage isolées loggées en warn, ne rollback PAS la DB
     (les objets orphelins seront éventuellement purgés par un job de réconciliation périodique — non implémenté en MVP)
  3. invalide la session courante
  4. -> 204
```

Important : capture des `photo_url` AVANT la cascade, sinon impossible de savoir quoi nettoyer.

### 7.4 Flux D — Cron de purge (worker séparé, intervalle 1h)

```sql
-- identifications temporaires expirées
DELETE FROM identifications
WHERE photo_status = 'temp' AND expires_at < now()
RETURNING id, photo_url;
-- pour chaque photo_url : DELETE objet Garage

-- specimens soft-deleted depuis > 30 jours
DELETE FROM specimens
WHERE deleted_at < now() - interval '30 days'
RETURNING id, photo_url;
-- DELETE objet Garage

-- plantnet_usage anciens
DELETE FROM plantnet_usage WHERE day < current_date - 7;
```

---

## 8. Intégrations externes

### 8.1 PlantNet (`lib/plantnet.ts`)

- **Endpoint** : `POST https://my-api.plantnet.org/v2/identify/all?api-key=<KEY>`
- **Free tier** : 500 req/jour, partagé. Variable d'env `PLANTNET_API_KEY`.
- **Requête** : multipart `organs=flower`, `images=<jpeg>`, `lang=fr`, `nb-results=3`
- **Mapping** : `results[0]` = top, `results[1..2]` = alternatives ; `species.scientificNameWithoutAuthor` est la clé d'upsert
- **`reference_photo_url`** = `results[i].images[0].url.m` (URL crowd-sourced PlantNet, **pas de copy** vers Garage en MVP pour économiser le stockage)
- **Erreurs** :
  - 429 PlantNet (quota global) → 502 API + log alerte
  - 5xx / timeout 10s → 502 API
  - `results` vide → 422 API `{ error: { code: 'NO_MATCH' } }`
- **Quota local** : incrément atomique de `plantnet_usage.count` AVANT l'appel ; décrément en cas d'erreur ≠ 200 PlantNet (évite de pénaliser le user pour des pannes serveur PlantNet)

### 8.2 Wikipedia (`lib/wikipedia.ts`)

- **Endpoint** : `GET https://fr.wikipedia.org/api/rest_v1/page/summary/<scientific_name>`
- **Auth** : User-Agent obligatoire (var d'env `WIKIPEDIA_USER_AGENT`, ex. `Airbarium/0.1 (contact@…)`)
- **Stratégie** : appel best-effort en arrière-plan via `queueMicrotask` après la réponse au mobile. Échec silencieux toléré.
- **Mapping** :
  ```
  description           = response.extract
  wikipedia_url         = response.content_urls.desktop.page
  wikipedia_fetched_at  = now()
  ```
- **404 / erreur** : on set quand même `wikipedia_fetched_at = now()` (marqueur "tenté"), `description` reste NULL. Évite les retries infinis.
- **Retry** : le cron peut tenter une seconde passe pour `species WHERE wikipedia_fetched_at IS NULL AND created_at < now() - 5 min` — laissé optionnel pour V1.

### 8.3 Garage (`lib/garage.ts`)

- **Client** : `@aws-sdk/client-s3` (Garage est 100% S3 compatible)
- **Variables d'env** : `GARAGE_ENDPOINT`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY`, `GARAGE_REGION` (peu importe, mettre `garage`)
- **Buckets** :
  - `specimens` : `<user_id>/<identification_id>.jpg` (temp) ou `<user_id>/<specimen_id>.jpg` (promoted)
  - `avatars` : `<user_id>.jpg`
- **Opérations** :
  - `PutObject` pour upload (Content-Type forcé `image/jpeg`)
  - `CopyObject` + `DeleteObject` pour "renommer" temp → promoted
  - `DeleteObject` / `DeleteObjects` pour purge (cron + RGPD)
  - `getSignedUrl` (helper aws-sdk) pour générer une URL pré-signée de durée 1h à la lecture
- **Lecture côté mobile** : pas de download direct du `photo_url` brut. Le mobile appelle `GET /v1/specimens/:id` qui retourne un objet avec `photo_url` pré-signé (1h), à utiliser directement pour `<Image src>`.

### 8.4 Mailer (`lib/mailer.ts`)

- **Lib** : `nodemailer` (compatible Bun)
- **Config dev** : `SMTP_URL=smtp://mailhog:1025`, interface visible sur `http://localhost:8025`
- **Config prod** : `SMTP_URL=smtps://user:pass@<provider>:465`. Suggestion : Brevo (free 300/jour) ou Postmark.
- **Templates** : 2 emails HTML inline simples
  - `verify-email.ts` : sujet "Confirme ton inscription à Airbarium" + lien `${APP_URL}/v1/auth/verify-email?token=…`
  - `reset-password.ts` : sujet "Réinitialise ton mot de passe" + lien `${APP_URL}/reset-password?token=…` (deep link mobile)
- **Var d'env** : `MAIL_FROM="Airbarium <noreply@airbarium.app>"`

---

## 9. Sécurité

### 9.1 Auth & sessions

- Better Auth en mode session cookie (httpOnly, secure en prod, SameSite=Lax) + mode Bearer pour mobile
- Durée : 30 jours, rolling refresh à chaque requête authentifiée
- Hashing : `Bun.password` (Argon2) — natif, géré par Better Auth

### 9.2 CORS (middleware Hono)

```
origins :
  - http://localhost:8081      // expo dev mobile
  - http://localhost:19006     // expo web preview
  - https://app.airbarium.app  // futur web
methods : GET, POST, PATCH, PUT, DELETE
credentials : true
```

### 9.3 Rate limiting (middleware custom, backed Postgres)

- PlantNet : 30 identifications / jour / user (couvert par `plantnet_usage`)
- Sign-in : 10 tentatives / 15 min / `(IP, email)`
- Sign-up : 3 / heure / IP
- API globale : 600 req / 10 min / user (fenêtre glissante, granularité 1 min)

Pas de Redis en MVP : compteurs en Postgres avec une table `rate_limit (key, window, count)`. Coût acceptable au volume MVP.

### 9.4 Validation des entrées

- Chaque route a un validator Zod via `@hono/zod-validator`
- Upload photo : check magic bytes JPEG (`FF D8 FF`) en complément du Content-Type
- Taille fichier : limite Hono `bodyLimit` à 3 Mo (marge sur le 2 Mo logique)

### 9.5 Secrets

Toutes les variables sensibles via env. En k8s : `Secret` monté, type `Opaque`, géré par sealed-secrets ou external-secrets selon l'infra du cluster.

Variables d'env requises :
```
DATABASE_URL
BETTER_AUTH_SECRET           # 32+ bytes random
BETTER_AUTH_URL              # https://api.airbarium.app
GARAGE_ENDPOINT, GARAGE_ACCESS_KEY, GARAGE_SECRET_KEY, GARAGE_REGION
PLANTNET_API_KEY
SMTP_URL, MAIL_FROM
WIKIPEDIA_USER_AGENT
APP_URL                      # pour les liens dans les emails
PORT                         # default 3000
LOG_LEVEL                    # default 'info'
```

### 9.6 Headers de sécurité

Middleware `secureHeaders` de Hono :
- `Strict-Transport-Security: max-age=63072000`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`

Pas de CSP : aucune surface web servie par l'API.

### 9.7 Hors scope MVP

2FA, IP allowlisting admin, WAF, audit log des actions sensibles — à reprendre en V2.

---

## 10. Observabilité

### 10.1 Logs

- `pino` JSON structuré sur stdout
- Format : `{ level, time, msg, request_id, user_id?, route?, status?, latency_ms?, ... }`
- `request_id` : middleware générant/propageant `X-Request-Id`
- Niveaux :
  - `info` : 1 ligne par requête (route + status + latence)
  - `warn` : 4xx
  - `error` : 5xx + exceptions non gérées
  - `debug` : utilisé en dev uniquement

### 10.2 Métriques

Endpoint `/metrics` (Prometheus text format) exposé par `prom-client` :
- Histogramme de latence par route
- Compteurs par status code
- Compteur PlantNet (`success`, `quota_exceeded`, `error`)
- Compteur ingestion sync offline
- Gauge `db_pool_active`

### 10.3 Healthchecks

- `GET /v1/health` : `{ status, db, garage, plantnet }`
- En Kubernetes :
  - **liveness** sur `/v1/health` ne checkant que la DB (PlantNet/Garage transitoires ne doivent pas restart le pod)
  - **readiness** check DB + Garage (Garage down = on retire de l'ingress)

### 10.4 Tracing distribué

Hors scope MVP. À envisager V2 si une stack OpenTelemetry est disponible.

---

## 11. Dev local

### 11.1 `docker-compose.yaml`

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: airbarium
      POSTGRES_USER: airbarium
      POSTGRES_PASSWORD: dev
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U airbarium']

  garage:
    image: dxflrs/garage:v2.3.0
    ports: ['3900:3900', '3902:3902']
    volumes:
      - garage-meta:/var/lib/garage/meta
      - garage-data:/var/lib/garage/data
      - ./compose/garage.toml:/etc/garage.toml

  mailhog:
    image: mailhog/mailhog
    ports: ['1025:1025', '8025:8025']

volumes:
  pgdata: {}
  garage-meta: {}
  garage-data: {}
```

### 11.2 Workflow

```
docker compose up -d
bun install
bun run db:migrate
bun run db:seed                # optionnel, user dev
bun run dev                    # hot-reload via bun --watch
# emails consultables sur http://localhost:8025
```

### 11.3 Scripts `package.json`

| Script | Commande |
|---|---|
| `dev` | `bun --watch src/server.ts` |
| `cron` | `bun src/cron.ts` |
| `test` | `bun test` |
| `db:generate` | `drizzle-kit generate` |
| `db:migrate` | `drizzle-kit migrate` |
| `db:studio` | `drizzle-kit studio` |
| `typecheck` | `tsc --noEmit` |
| `lint` | `biome check .` |
| `format` | `biome format --write .` |

---

## 12. CI/CD et déploiement

### 12.1 CI — GitHub Actions

`.github/workflows/ci.yaml` :
- Trigger : push + pull_request
- Services : Postgres 17 + Garage v2.3.0 dans le job
- Étapes : `setup-bun`, `install`, `typecheck`, `lint`, `db:migrate`, `test`
- PlantNet, Wikipedia, SMTP : **mockés** dans les tests

### 12.2 Déploiement

Chart Helm `deploy/helm/airbarium-api/` :
- `Deployment` : 2 replicas en prod, 1 en staging
- `Service` ClusterIP
- `ConfigMap` (vars non sensibles) + `Secret` (vars sensibles)
- `IngressRoute` Traefik **ou** `HTTPRoute` Gateway API (choix opérationnel)
- `HorizontalPodAutoscaler` sur CPU (optionnel MVP)
- `Deployment` worker cron séparé, 1 replica fixe, `command: ["bun", "run", "cron"]`

Dépendances Helm (chartes séparées) :
- Postgres : **CloudNativePG operator** + `Cluster` CR (Postgres 17). Apporte HA, failover automatique, backups continus (Barman Cloud vers Garage en option), monitoring Prometheus natif. Bien plus production-grade qu'un chart Bitnami pour un coût opérationnel équivalent.
- Garage : chart community ou Deployment+StatefulSet custom (~80 lignes YAML)
- Pas de MailHog en prod : provider externe configuré via `SMTP_URL`

Note : CloudNativePG est un opérateur Kubernetes, il ne tourne pas en local. Le `docker-compose` dev et les services GitHub Actions continuent d'utiliser l'image `postgres:17-alpine` directement.

---

## 13. Structure de code

```
airbarium-backend/
├── package.json
├── tsconfig.json
├── biome.json
├── docker-compose.yaml
├── compose/
│   └── garage.toml
├── drizzle.config.ts
├── .env.example
├── README.md
│
├── src/
│   ├── server.ts                   # entry HTTP
│   ├── cron.ts                     # entry worker
│   ├── app.ts                      # construction app Hono (réutilisée par tests)
│   │
│   ├── config/
│   │   └── env.ts                  # Zod parsing des env vars
│   │
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema/
│   │   │   ├── users.ts
│   │   │   ├── species.ts
│   │   │   ├── specimens.ts
│   │   │   ├── identifications.ts
│   │   │   ├── plantnet-usage.ts
│   │   │   └── index.ts
│   │   └── migrations/
│   │
│   ├── auth/
│   │   └── better-auth.ts
│   │
│   ├── routes/
│   │   ├── index.ts
│   │   ├── health.ts
│   │   ├── me.ts
│   │   ├── identifications.ts
│   │   ├── specimens.ts
│   │   └── species.ts
│   │
│   ├── services/
│   │   ├── identification.ts
│   │   ├── species-enrichment.ts
│   │   ├── specimen-create.ts
│   │   ├── photo-storage.ts
│   │   ├── account-deletion.ts
│   │   └── quota.ts
│   │
│   ├── lib/
│   │   ├── plantnet.ts
│   │   ├── wikipedia.ts
│   │   ├── garage.ts
│   │   └── mailer.ts
│   │
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── error-handler.ts
│   │   ├── request-id.ts
│   │   ├── rate-limit.ts
│   │   └── logger.ts
│   │
│   ├── schemas/
│   │   ├── common.ts
│   │   ├── specimens.ts
│   │   └── identifications.ts
│   │
│   └── utils/
│       ├── errors.ts
│       ├── uuid.ts
│       └── jpeg.ts
│
├── tests/
│   ├── helpers/
│   │   ├── app.ts
│   │   ├── db.ts
│   │   ├── auth.ts
│   │   └── mocks/
│   │       ├── plantnet.ts
│   │       └── wikipedia.ts
│   ├── unit/
│   └── integration/
│
└── deploy/
    └── helm/
        └── airbarium-api/
```

**Principes de découpage** :
- `routes/` reste fin : parse → délègue → format la réponse
- `services/` contient la business logic, testable sans Hono, réutilisé par le cron
- `lib/` isole les adaptateurs externes pour les mocker facilement
- `schemas/` Zod partagés entre validators de route et types de service

---

## 14. Découpage en lots de PRs

8 lots indépendants, mergeable l'un après l'autre. Estimations en demi-journées indicatives (solo, focus).

| # | Lot | Contenu | Dépend de | Effort |
|---|---|---|---|---|
| 1 | **Bootstrap projet** | `package.json`, tsconfig, biome, docker-compose, env config Zod, Hono squelette, `/v1/health`, logger pino, request-id middleware, error-handler, GH Actions CI minimal | — | 1 |
| 2 | **DB & migrations** | Drizzle config, schémas (users, species, specimens, identifications, plantnet_usage), première migration, helpers tests DB | 1 | 1 |
| 3 | **Auth Better Auth** | Config Better Auth + adapter Drizzle, mailer nodemailer + MailHog, middleware `auth`, `GET /v1/me`, `PATCH /v1/me`, tests sign-up / sign-in / verify / reset | 1, 2 | 2 |
| 4 | **Storage Garage** | Client S3, `lib/garage.ts`, `services/photo-storage.ts` (upload, rename, presigned URL), `PUT/DELETE /v1/me/avatar`, tests d'intégration contre Garage du compose | 1, 3 | 1 |
| 5 | **Identifications** | `lib/plantnet.ts` + mocks, `services/identification.ts`, `services/quota.ts`, `POST /v1/identifications`, intégration Wikipedia best-effort, `GET /v1/species/:id`, tests | 1–4 | 2 |
| 6 | **Spécimens (online)** | `POST /v1/specimens` flux online (`identification_id` requis), idempotence UUIDv7, validation cohérence seuil, `GET /v1/specimens/:id`, `PATCH`, `DELETE` soft, `GET /v1/specimens` paginé, `GET /v1/specimens/stats` | 1–5 | 2 |
| 7 | **Sync offline + retry** | Branche "no `identification_id`" de `POST /v1/specimens`, identification synchrone best-effort + fallback `'none'`, `POST /v1/specimens/:id/identify` | 6 | 1 |
| 8 | **RGPD + cron + observabilité** | `DELETE /v1/me` (cascade DB + Garage), worker `cron.ts`, middleware rate-limit, `/metrics` Prometheus, doc README finale, chart Helm minimal | 6, 7 | 2 |

Total : ~12 demi-journées soit 1.5–2 semaines en plein focus solo. Avec frontend en parallèle, compter 3–4 semaines.

**Dépendances** : le lot 1 débloque tout ; les lots 2, 3, 4 peuvent partiellement se faire en parallèle après 1 ; le lot 5 bloque 6 et 7 ; le lot 8 est le polish final.

---

## 15. Critères de "done" du MVP

À la fin du lot 8, le backend est livrable si :

- [ ] Tous les endpoints listés en §6 répondent et sont couverts par au moins un test d'intégration
- [ ] Les user stories US-01 à US-15 du cahier des charges sont fonctionnellement satisfaites
- [ ] Le worker cron tourne et purge effectivement les identifications temp expirées (testé manuellement avec une identification de plus de 24h)
- [ ] La suppression de compte purge effectivement DB + Garage (vérifié avec un user de test : `\dt` Postgres + `s3 ls` Garage)
- [ ] Le rate-limit PlantNet 30/jour est observable dans `/metrics`
- [ ] Les emails de verify / reset arrivent dans MailHog en dev (et chez le provider en staging)
- [ ] Le chart Helm déploie une instance fonctionnelle sur le cluster cible
- [ ] La couverture de tests d'intégration > 60% des handlers de routes

---

## 16. Hors scope MVP

Confirmation explicite de ce qui n'est **pas** dans ce backend, à reprendre en V2+ :

- OAuth Google / Apple
- Export RGPD complet (`GET /me/export`)
- Anonymisation et conservation des photos pour ML après suppression de compte
- Référentiel d'espèces pré-seedé (le lazy upsert suffit)
- Système de rareté, badges, statistiques avancées
- Carte géospatiale, PostGIS
- Fonctionnalités sociales (amis, partage, fil d'activité)
- Identification d'autres plantes (feuilles, arbres, champignons)
- Notifications push
- Mode hors-ligne pour l'identification (modèle on-device)
- 2FA, WAF, IP allowlisting
- Tracing distribué OpenTelemetry
- Multi-device avec optimistic locking
- Internationalisation au-delà du français
- Audit log des actions sensibles
