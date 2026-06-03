# Lot 4 — Storage (Garage S3) — Design

> Date : 2026-06-03
> Version : 1.0
> Scope : Lot 4 du roadmap MVP backend Airbarium — client Garage, upload/delete avatar, URLs pré-signées dans `/me`.
> Status : design validé, prêt pour plan d'implémentation.

## 1. Objectif

Mettre en place le socle de stockage objet S3 (Garage) pour le backend MVP. Concrètement :

- un adaptateur `lib/garage.ts` mockable, isolé de toute logique métier ;
- un service `photo-storage` qui valide et orchestre les uploads ;
- les endpoints `PUT /v1/me/avatar` et `DELETE /v1/me/avatar` ;
- l'enrichissement de `GET /v1/me` avec une URL pré-signée pour l'avatar ;
- le bootstrap déterministe du cluster Garage en dev et CI.

Ce lot dépend des Lots 1 et 3 (Hono skeleton + Better Auth + `/me`). Il débloque le Lot 5 (PlantNet identifications, qui ré-utilise les mêmes helpers Garage pour le bucket `specimens`).

## 2. Décisions tranchées

| Sujet | Choix retenu | Raison |
|---|---|---|
| Adapter pattern | `lib/garage.ts` (S3 client + helpers bas niveau) + `services/photo-storage.ts` (validation + orchestration) | Aligné sur `lib/mailer.ts` du Lot 3, frontière claire pour mock unitaire |
| Bootstrap cluster Garage | Service `garage-init` one-shot dans `docker-compose.yaml` (layout assign + apply + key import) | Idempotent, exécuté à `docker compose up`, ré-utilisable en CI via `docker compose run garage-init` |
| Bootstrap bucket `avatars` | `ensureBucket()` au boot de l'API (`HeadBucket` puis `CreateBucket` si 404), skip si `NODE_ENV=production` | Idempotent, pas de step manuel en dev, en prod le bucket vient de Helm/admin |
| Clé Garage avatar | Déterministe `avatars/<user_id>.jpg`, overwrite à chaque PUT | Zéro orphelin, code minimal, l'URL pré-signée (1h TTL) sert de cache-busting |
| Validation JPEG | Magic bytes `FF D8 FF` + size ≤ 2 Mo, JPEG uniquement | Aligne sur spec §6.4 photos identifications, validation réutilisable en Lot 5 |
| Stockage colonne `users.avatar_url` | Clé S3 brute (`<user_id>.jpg`), `NULL` si pas d'avatar | Pré-signe à la lecture, jamais en DB |
| Durée URL pré-signée | 3600 secondes (1h) | Spec §6.5 / §8.3 |
| Transaction DB ↔ Garage | Pas de 2PC. Clé déterministe + idempotence du DELETE rendent les divergences auto-réparables | Évite le coût d'un compensating action, accepté par la spec |
| Format d'erreur | Enveloppe standard `{ error: { code, message } }` du Lot 1 | Cohérence cross-endpoints |
| `DELETE /v1/me/avatar` | Toujours 204, idempotent (pas de 404 si déjà NULL) | Norme REST, simplifie le client mobile |

## 3. Architecture

```
PUT /v1/me/avatar (multipart)
  routes/me.ts (authMiddleware + multipart parser, bodyLimit 3 Mo)
    └─> services/photo-storage.ts uploadAvatar(userId, file)
          ├─ utils/jpeg.ts validateJpeg(buffer)
          ├─ lib/garage.ts putObject({ bucket, key, body, contentType })
          ├─ db.update users.avatarUrl
          └─ lib/garage.ts getPresignedUrl({ bucket, key, expiresInSeconds })
                → response { avatar_url }
```

Les routes restent fines (parse → délègue → format). Les services portent la business logic. `lib/garage.ts` n'expose **que** des opérations S3, jamais de validation métier ni de connaissance de l'objet "avatar". C'est ce qui rend Lot 5 trivial : pour les photos d'identifications, le service `identification.ts` appellera les mêmes `putObject` / `getPresignedUrl` sur le bucket `specimens` avec la clé `<user_id>/<id>.jpg`.

## 4. Fichiers

### 4.1 Nouveaux

| Path | Responsabilité |
|---|---|
| `src/lib/garage.ts` | Singleton `S3Client`, `ensureBucket`, `putObject`, `deleteObject`, `getPresignedUrl`, `__setForTests` |
| `src/services/photo-storage.ts` | `uploadAvatar(userId, file)`, `deleteAvatar(userId)`, `presignAvatar(key)` |
| `src/utils/jpeg.ts` | `validateJpeg(buffer): void` (magic bytes + taille) |
| `src/schemas/avatar.ts` | Schéma Zod multipart (champ `photo: File`) si nécessaire pour la cohérence — sinon parsing inline |
| `tests/helpers/garage.ts` | `setupTestGarage()`, `cleanupGarageObjects(keys)` |
| `tests/integration/avatar.test.ts` | Suite d'intégration PUT/DELETE/GET avatar |
| `tests/unit/services/photo-storage.test.ts` | Unit photo-storage avec `lib/garage` mocké |
| `tests/unit/utils/jpeg.test.ts` | Unit validateJpeg |
| `tests/unit/lib/garage.test.ts` | Smoke : `S3Client` configuré depuis `env` |

### 4.2 Modifiés

| Path | Change |
|---|---|
| `src/config/env.ts` | Ajouter `GARAGE_ENDPOINT`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY`, `GARAGE_REGION` |
| `src/routes/me.ts` | Ajouter `PUT /me/avatar` et `DELETE /me/avatar` (per-route `authMiddleware`) |
| `src/services/profile.ts` | `toResponse` ↦ injecte la presigned URL si `avatarUrl` non-null |
| `src/server.ts` | Au boot : `ensureBucket('avatars')` (skip si `NODE_ENV=production`) |
| `.env.example` | Promouvoir les 4 vars Garage (clés dev figées) |
| `package.json` | Ajouter `@aws-sdk/client-s3` et `@aws-sdk/s3-request-presigner` |
| `docker-compose.yaml` | Ajouter le service `garage-init` one-shot + healthcheck Garage |

## 5. Contrat API

### 5.1 `PUT /v1/me/avatar`

- **Auth** : requise (cookie Better Auth ou Bearer)
- **Content-Type** : `multipart/form-data` avec un champ `photo` (binaire JPEG)
- **Body limit** : 3 Mo au niveau Hono (marge sur la limite logique 2 Mo)

**Success — 200 OK** :

```json
{ "avatar_url": "http://localhost:3900/avatars/<uid>.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&..." }
```

**Errors** (enveloppe standard `{ error: { code, message } }`) :

| Status | Code | Cas |
|---|---|---|
| 400 | `MISSING_FIELD` | Champ `photo` absent du form-data |
| 400 | `INVALID_CONTENT_TYPE` | `photo.type !== 'image/jpeg'` |
| 400 | `INVALID_JPEG` | Magic bytes ≠ `FF D8 FF` |
| 400 | `FILE_TOO_LARGE` | buffer > 2_000_000 bytes |
| 401 | `UNAUTHORIZED` | `authMiddleware` non passé |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 3 Mo (Hono bodyLimit) |
| 500 | `STORAGE_ERROR` | Échec inattendu Garage (`putObject` throw) |

### 5.2 `DELETE /v1/me/avatar`

- **Auth** : requise
- **Body** : aucun

**Success — 204 No Content** — toujours, qu'un avatar existe ou non (idempotent). Si la colonne `avatar_url` était déjà NULL, on ne fait aucun appel Garage.

**Errors** :
- `401 UNAUTHORIZED`

### 5.3 `GET /v1/me`

Comportement existant + le champ `avatar_url` devient :

- une URL pré-signée 1h si `users.avatar_url` est non-null
- `null` sinon

Aucun nouveau code d'erreur.

### 5.4 Persistance

Colonne `users.avatar_url` (déjà créée en Lot 2) :

- valeur : clé S3 brute, ex. `f1e2d3c4-…-…-…-….jpg` (pas le bucket, pas le préfixe)
- `NULL` = pas d'avatar

Les URLs pré-signées sont **toujours** générées à la lecture, jamais persistées.

## 6. Flux détaillés

### 6.1 Upload avatar (PUT /v1/me/avatar)

```
1. authMiddleware → user.id résolu, sinon 401
2. Hono parse multipart (bodyLimit 3 Mo, sinon 413)
3. Récupérer le champ `photo` (File). Absent → 400 MISSING_FIELD
4. photo.type !== 'image/jpeg' → 400 INVALID_CONTENT_TYPE
5. buffer = new Uint8Array(await photo.arrayBuffer())
6. validateJpeg(buffer):
     - buffer.length > 2_000_000 → 400 FILE_TOO_LARGE
     - buffer.length < 3 || bytes[0..2] != [0xFF, 0xD8, 0xFF] → 400 INVALID_JPEG
7. key = `${user.id}.jpg`
8. lib/garage.putObject({ bucket:'avatars', key, body:buffer, contentType:'image/jpeg' })
     - erreur S3 → throw, error-handler middleware → 500 STORAGE_ERROR, log err
9. db.update users.set({ avatarUrl: key, updatedAt: now() }).where(eq(users.id, user.id))
10. presignedUrl = lib/garage.getPresignedUrl({ bucket:'avatars', key, expiresInSeconds: 3600 })
11. return 200 { avatar_url: presignedUrl }
```

**Pourquoi pas de transaction** : la clé est déterministe (`<user_id>.jpg`). Si l'étape 9 échoue après une 8 réussie, l'objet Garage est à jour mais la colonne DB pointe encore sur l'ancien état (qui peut être NULL). Le prochain PUT écrasera proprement ; un DELETE supprimera à coup sûr l'objet (le service lit la colonne, mais en complément on peut tenter `DeleteObject` sur la clé canonique `${user.id}.jpg` côté Lot 8 RGPD). Pas d'orphelin métier puisque la clé reste liée à l'utilisateur.

### 6.2 Delete avatar (DELETE /v1/me/avatar)

```
1. authMiddleware → user.id
2. row = db.select({ avatarUrl }).from(users).where(eq(users.id, user.id))
3. Si row.avatarUrl IS NOT NULL :
     a. lib/garage.deleteObject({ bucket:'avatars', key: row.avatarUrl }) — best-effort
          Si erreur Garage (404 inclus) : log warn, continue
     b. db.update users.set({ avatarUrl: null, updatedAt: now() }).where(eq(users.id, user.id))
4. return 204
```

### 6.3 Get profile (GET /v1/me)

```
1. authMiddleware → user.id
2. row = db.select().from(users).where(eq(users.id, user.id))
3. avatar_url = row.avatarUrl
     ? lib/garage.getPresignedUrl({ bucket:'avatars', key: row.avatarUrl, expiresInSeconds: 3600 })
     : null
4. return 200 { ...toResponse(row), avatar_url }
```

`getPresignedUrl` est local (crypto HMAC, pas d'appel réseau Garage) → coût négligeable, pas de cache.

### 6.4 Bootstrap au boot

```
src/server.ts:
  - parse env
  - ensureBucket('avatars') if env.NODE_ENV !== 'production'
      → tente HeadBucket
      → si 404 : CreateBucket
      → si autre erreur : log warn, continue (API démarre quand même)
  - app.listen(env.PORT)
```

Pas de crash-loop si Garage est down au démarrage : le premier `PUT /me/avatar` retournera 500 proprement. Permet à l'API d'absorber des redémarrages indépendants de Garage.

## 7. `lib/garage.ts` — surface attendue

```ts
export type PutObjectInput = {
  bucket: string;
  key: string;
  body: Uint8Array | Buffer;
  contentType: string;
};

export type DeleteObjectInput = {
  bucket: string;
  key: string;
};

export type PresignInput = {
  bucket: string;
  key: string;
  expiresInSeconds: number;
};

export function ensureBucket(bucket: string): Promise<void>;
export function putObject(input: PutObjectInput): Promise<void>;
export function deleteObject(input: DeleteObjectInput): Promise<void>;
export function getPresignedUrl(input: PresignInput): Promise<string>;

// Pour les unit tests :
export function __setForTests(stub: Partial<{
  ensureBucket: typeof ensureBucket;
  putObject: typeof putObject;
  deleteObject: typeof deleteObject;
  getPresignedUrl: typeof getPresignedUrl;
}>): void;
export function __resetForTests(): void;
```

Le client `S3Client` est instancié paresseusement (premier appel) avec `endpoint: env.GARAGE_ENDPOINT`, `region: env.GARAGE_REGION`, `forcePathStyle: true` (Garage), `credentials: { accessKeyId, secretAccessKey }`. Pas d'option de retry custom — les défauts du SDK suffisent en MVP.

## 8. Bootstrap Garage en dev/CI

Ajout au `docker-compose.yaml` :

```yaml
garage:
  # … inchangé sauf healthcheck :
  healthcheck:
    test: ['CMD', 'wget', '-q', '-O-', 'http://localhost:3903/health']
    interval: 5s
    timeout: 3s
    retries: 10

garage-init:
  image: dxflrs/garage:v2.3.0
  depends_on:
    garage:
      condition: service_healthy
  entrypoint: /bin/sh
  command:
    - -c
    - |
      set -e
      NODE_ID=$$(garage -h garage:3903 status | awk 'NR>2 {print $$1; exit}')
      garage -h garage:3903 layout assign -z dev -c 1G $$NODE_ID || true
      garage -h garage:3903 layout apply --version 1 || true
      garage -h garage:3903 key import \
        --key-id GKDEV0000000000000000000000000000000000000 \
        --secret SKDEV0000000000000000000000000000000000000000000000000000000000 \
        airbarium-dev || true
      garage -h garage:3903 key allow --create-bucket airbarium-dev || true
  environment:
    GARAGE_RPC_SECRET: b80d502fc6b37b60a8415511d41bcf9bcbe521e18f27dd10239ee5f3fb1e4051
  restart: 'no'
```

Les `|| true` sont volontaires : `layout apply` échoue à partir de la 2ᵉ exécution (version déjà appliquée), ce qui rend le service one-shot idempotent. Le `restart: 'no'` empêche docker compose de relancer le job une fois qu'il a exit 0.

`ensureBucket('avatars')` au boot de l'API gère la création du bucket lui-même.

`.env.example` final pour Lot 4 :

```
# Lot 4 — storage
GARAGE_ENDPOINT=http://localhost:3900
GARAGE_ACCESS_KEY=GKDEV0000000000000000000000000000000000000
GARAGE_SECRET_KEY=SKDEV0000000000000000000000000000000000000000000000000000000000
GARAGE_REGION=garage
```

En CI : ajouter un step `docker compose up -d garage garage-init` avant `bun test`.

## 9. Stratégie de tests

### 9.1 Unit

- **`tests/unit/utils/jpeg.test.ts`** : couverture exhaustive de `validateJpeg`
  - buffer vide → throw INVALID_JPEG
  - header `FF D8 FF` + 100 bytes random → OK
  - header `89 50 4E 47` (PNG) → throw INVALID_JPEG
  - buffer 2_000_001 bytes avec header JPEG → throw FILE_TOO_LARGE

- **`tests/unit/services/photo-storage.test.ts`** : mock `lib/garage` via `__setForTests`
  - `uploadAvatar` appelle `putObject` avec key/bucket/contentType corrects
  - `uploadAvatar` met à jour `users.avatarUrl` en DB (testDb réel via `tests/helpers/db`)
  - `deleteAvatar` ne fait rien si avatarUrl est déjà NULL
  - `deleteAvatar` swallowe une erreur `putObject` et nettoie quand même la colonne DB

- **`tests/unit/lib/garage.test.ts`** : smoke test que `S3Client` est instancié avec les bons params depuis `env`

### 9.2 Integration

- **`tests/helpers/garage.ts`** : `setupTestGarage()` (appelle `ensureBucket('avatars')`), `cleanupGarageObjects(keys)`

- **`tests/integration/avatar.test.ts`** (≈ 8 tests) :
  - PUT renvoie 200 + `avatar_url` qui matche `/X-Amz-Signature=/`
  - L'objet existe dans Garage après PUT (`HeadObject` direct)
  - `users.avatarUrl` en DB contient bien `<uid>.jpg` après PUT
  - PUT répété écrase l'objet existant
  - DELETE renvoie 204, l'objet Garage est supprimé, la colonne DB devient NULL
  - DELETE idempotent : 2 appels successifs → 204 + 204
  - GET /v1/me retourne `avatar_url` pré-signé après PUT, `null` après DELETE
  - PUT sans champ `photo` → 400 MISSING_FIELD
  - PUT avec un buffer non-JPEG (PNG) → 400 INVALID_JPEG

### 9.3 Coverage matrix

| Comportement | Unit | Intégration |
|---|---|---|
| Validation magic bytes JPEG | ✅ | ✅ |
| Limite 2 Mo | ✅ | — |
| Persistence DB | ✅ | ✅ |
| Vrais appels S3 | — | ✅ |
| Presigned URL signature | — | ✅ (regex sur l'URL) |
| Idempotence DELETE | ✅ | ✅ |
| 401 sans auth | — | ✅ |

### 9.4 Pattern de test (cohérence avec Lot 3)

```ts
beforeAll(async () => {
  await setupTestDb();
  await setupTestGarage();
});
beforeEach(async () => {
  await truncateAll();
});
afterEach(async () => {
  await cleanupGarageObjects(createdKeys);
});
afterAll(async () => {
  await teardownTestDb();
});
```

## 10. CI

Le job GitHub Actions doit lancer Garage en service ou via `docker compose`. Plus simple : extension du compose existant.

Étapes du job :

1. Checkout
2. Setup Bun + cache
3. `docker compose up -d postgres garage garage-init` (Postgres + Garage + bootstrap one-shot)
4. Attendre la santé : `docker compose run --rm wait-for-garage` (ou `until curl -sf http://localhost:3900/`)
5. `bun run db:migrate`
6. `bun run typecheck` + `bun run lint`
7. `bun test`

Pas de mock Garage en CI — on tape le vrai Garage du compose.

## 11. Hors scope Lot 4 (à relire)

- Bucket `specimens` et photos d'identifications → Lot 5
- Cleanup Garage lors du `DELETE /v1/me` (RGPD) → Lot 8
- Cleanup périodique d'objets orphelins → Lot 8 (cron worker)
- Rate limit sur PUT avatar → Lot 8 (middleware générique)
- Métriques Prometheus sur les opérations Garage → Lot 8
- Helm chart Garage prod → Lot 8

## 12. Critères de "done" Lot 4

- [ ] `PUT /v1/me/avatar` et `DELETE /v1/me/avatar` répondent conformément à la §5
- [ ] `GET /v1/me` retourne une URL pré-signée 1h après PUT, `null` après DELETE
- [ ] L'objet Garage existe / disparaît cohéremment avec la DB
- [ ] `docker compose up -d` suffit en local : `garage-init` configure layout + key, l'API crée le bucket au boot
- [ ] CI verte avec un step Garage explicite
- [ ] Tous les tests unitaires + d'intégration passent (`bun test`)
- [ ] `bun run typecheck` et `bun run lint` propres
