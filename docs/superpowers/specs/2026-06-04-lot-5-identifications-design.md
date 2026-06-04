# Lot 5 — Identifications (PlantNet + quota + species + Wikipedia) — Design

> Date : 2026-06-04
> Version : 1.0
> Scope : Lot 5 du roadmap MVP backend Airbarium — endpoint `POST /v1/identifications`, endpoint `GET /v1/species/:id`, quota PlantNet, enrichissement Wikipedia best-effort.
> Status : design validé, prêt pour plan d'implémentation.

## 1. Objectif

Brancher PlantNet sur le backend pour transformer une photo en candidat d'espèce. Le mobile envoie une JPEG (≤ 2 Mo) + métadonnées EXIF optionnelles, le backend :

1. Vérifie le quota du user (30 identifications/jour).
2. Upload la photo dans le bucket Garage `specimens` en statut `temp`.
3. Appelle PlantNet (`organs=flower`, `lang=fr`, `nb-results=3`).
4. Upsert lazily les `species` du top match et des 2 alternatives.
5. Déclenche un enrichissement Wikipedia best-effort (en background, via `queueMicrotask`) pour chaque species nouvellement créée.
6. Persiste un row `identifications` (immutable, audit trail) avec `expires_at = now() + 24h`.
7. Renvoie top + 2 alternatives + `confidence_threshold` + flag `auto_pickable`.

`GET /v1/species/:id` retourne la fiche species (avec description Wikipedia si disponible).

Ce lot dépend des Lots 1-4 (Hono skeleton, schemas Drizzle, Better Auth, `lib/garage.ts` + `validateJpeg`). Il débloque le Lot 6 (création de `specimens` à partir d'une identification) et le Lot 7 (sync offline + retry identify).

## 2. Décisions tranchées

| Sujet | Choix | Raison |
|---|---|---|
| Format du payload EXIF | Form fields séparés (`date_taken?`, `gps_lat?`, `gps_lng?`) **amendement** vs spec MVP §6.4 qui disait `exif: json` | Pour 3 champs stables, moins de friction côté mobile (pas de `JSON.stringify`). La colonne `exif_metadata` reste `jsonb` côté DB |
| Inclusion de `GET /v1/species/:id` | Oui | Trivial à partir du service species (lazy upsert), débloque le mobile pour une "fiche espèce" même en V0 |
| Quota atomic strategy | `INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET count = plantnet_usage.count + 1 RETURNING count` — refund sur `count > 30` | Atomique en une requête, pas de transaction ni d'advisory lock |
| Quota refund | Décrément uniquement sur 5xx PlantNet, timeout, 429 PlantNet | NO_MATCH (PlantNet 200 + résultats vides) = PlantNet a répondu, pas de refund |
| Confidence threshold | Constante `CONFIDENCE_THRESHOLD = 0.70` en dur, exposée dans la réponse | Le mobile applique la règle UX (auto-pick vs choix utilisateur). Le serveur ne décide pas |
| Auto-pick côté serveur | Aucun en Lot 5 — la réponse expose juste `auto_pickable`, l'`identification_source` est posée par Lot 6 quand le specimen est créé | Découplage clean entre "identifier une photo" (Lot 5) et "ajouter à la bibliothèque" (Lot 6) |
| Garage key | `<user_id>/<identification_id>.jpg` dans le bucket `specimens` | Aligné spec §8.3, préfixe par user pour cleanup RGPD |
| `photo_status` | `'temp'` à la création, `expires_at = now() + 24h` | Cleanup viendra en Lot 8 via cron |
| `reference_photo_url` | URL crowd-sourced PlantNet (`results[i].images[0].url.m`), pas de copy vers Garage | Économie de stockage. Risque de lien mort accepté pour MVP |
| Lazy upsert species | Clé d'unicité = `scientific_name`. `INSERT ... ON CONFLICT (scientific_name) DO UPDATE SET updated_at = now() RETURNING *, (xmax = 0) AS is_new` | Détection des créations vs mises à jour pour ne déclencher l'enrichissement Wikipedia que sur les nouvelles species |
| Trigger Wikipedia | `queueMicrotask` uniquement sur species nouvellement créées dans CET appel | Code simple, pas de scan DB, pas de double-fetch en cas de requêtes concurrentes du même nom |
| Wikipedia 404 | Set `wikipedia_fetched_at = now()` quand même, `description` reste NULL | Évite des retries infinis. La règle "tenté = fetched_at non-null" suffit |
| Wikipedia erreur 5xx / timeout | Silent (log warn), pas de mise à jour `wikipedia_fetched_at` → un cron Lot 8 pourra retenter | L'absence de mise à jour signale "non tenté avec succès" |
| PlantNet timeout | 10 secondes via `AbortController` | Aligné spec §8.1 |
| PlantNet params | `organs=flower`, `lang=fr`, `nb-results=3` (fixés en dur) | Hors scope MVP de laisser le client choisir l'organe |
| Mock PlantNet en CI | Swap pattern via `__setPlantnetForTests` | Identique à `lib/mailer` et `lib/garage` (Lots 3-4) |
| Auth sur `GET /v1/species/:id` | Requise | Cohérence cross-endpoints. Pas de cache CDN public envisagé en MVP |

## 3. Architecture

```
POST /v1/identifications (multipart)
  routes/identifications.ts (authMiddleware + bodyLimit + parse multipart)
    └─> services/identification.ts identifyAndStore(userId, buffer, exif)
          ├─ services/quota.ts incrementOrThrow(userId)
          ├─ lib/plantnet.ts identify(buffer)         [+ refund si throw]
          ├─ lib/garage.ts putObject({ bucket:'specimens', key, body, contentType })
          ├─ for each result:
          │    └─ services/species.ts upsertFromPlantnet(...) → { species, isNew }
          │       └─ if isNew: services/species-enrichment.ts scheduleEnrichment(id)
          │           └─ queueMicrotask(() => enrichSpecies(id))
          │                ├─ lib/wikipedia.ts fetchSummary(scientificName)
          │                └─ db.update species (description, wikipedia_url, wikipedia_fetched_at)
          ├─ db.insert identifications
          └─ return { id, top_match, alternatives, confidence_threshold, auto_pickable }

GET /v1/species/:id
  routes/species.ts (authMiddleware)
    └─> services/species.ts getById(id) → SpeciesResponse
```

`lib/plantnet.ts` et `lib/wikipedia.ts` sont des adapters purs (HTTP + parse). Aucune connaissance de DB ni de quota. Les services portent la business logic. La frontière mockable est `lib/*` (via `__setForTests`).

## 4. Fichiers

### 4.1 Nouveaux

| Path | Responsabilité |
|---|---|
| `src/lib/plantnet.ts` | Singleton client + `identify(buffer): Promise<PlantnetResult[]>` + `__setPlantnetForTests` |
| `src/lib/wikipedia.ts` | Singleton + `fetchSummary(scientificName): Promise<WikiSummary \| null>` + `__setWikipediaForTests` |
| `src/services/quota.ts` | `incrementOrThrow(userId)` (atomic UPSERT) + `refund(userId)` |
| `src/services/identification.ts` | `identifyAndStore(userId, buffer, exif)` |
| `src/services/species-enrichment.ts` | `enrichSpecies(id)` + `scheduleEnrichment(id)` (fire-and-forget) |
| `src/services/species.ts` | `getById(id)`, `upsertFromPlantnet(input)` |
| `src/routes/identifications.ts` | `POST /v1/identifications` |
| `src/routes/species.ts` | `GET /v1/species/:id` |
| `src/schemas/identifications.ts` | Zod transform pour les 3 form fields EXIF |
| `tests/unit/lib/plantnet.test.ts` | success, no_match, 5xx, 429, timeout |
| `tests/unit/lib/wikipedia.test.ts` | success, 404 → null, 5xx → throw, User-Agent vérifié |
| `tests/unit/services/quota.test.ts` | 1er, 30e, 31e (429), refund |
| `tests/unit/services/identification.test.ts` | happy, quota exceeded, timeout (refund), no_match (sans refund), garage fail |
| `tests/unit/services/species.test.ts` | upsert is_new=true/false, getById 404 |
| `tests/unit/services/species-enrichment.test.ts` | success, 404, throw caught |
| `tests/integration/identifications.test.ts` | end-to-end PlantNet+Wikipedia mockés, real Postgres+Garage |
| `tests/integration/species.test.ts` | GET avec/sans description, 404 |
| `tests/helpers/plantnet.ts` | `installMockPlantnet({ topConfidence?, noMatch?, fail? })` |
| `tests/helpers/wikipedia.ts` | `installMockWikipedia({ found?, status? })` |

### 4.2 Modifiés

| Path | Change |
|---|---|
| `src/config/env.ts` | Ajouter `PLANTNET_API_KEY` (required) + `WIKIPEDIA_USER_AGENT` (default `Airbarium/0.1`) |
| `src/routes/index.ts` | Monter `identifications.ts` et `species.ts` |
| `src/server.ts` | Au boot : `await ensureBucket('specimens')` (skip prod) |
| `tests/helpers/garage.ts` | Setup étendu pour le bucket `specimens` |
| `.env.example` | Documenter `PLANTNET_API_KEY` et `WIKIPEDIA_USER_AGENT` |

## 5. Contrat API

### 5.1 `POST /v1/identifications`

- **Auth** : requise (cookie Better Auth ou Bearer)
- **Content-Type** : `multipart/form-data` (RFC 7578)
- **Champs** :
  - `photo` (file, requis) — `image/jpeg`, ≤ 2 Mo
  - `date_taken` (string ISO 8601, optionnel) — date de prise de vue
  - `gps_lat` (string décimal, optionnel) — latitude WGS84, -90..90
  - `gps_lng` (string décimal, optionnel) — longitude WGS84, -180..180
- **Body limit Hono** : `JPEG_BODY_LIMIT_BYTES` = 3 Mo (cf. Lot 4)

**Success — 201 Created** :

```json
{
  "id": "0190a1b2-c3d4-7eef-89ab-cdef01234567",
  "top_match": {
    "species_id": "uuid",
    "common_name": "Coquelicot",
    "scientific_name": "Papaver rhoeas",
    "family": "Papaveraceae",
    "confidence": 0.8421,
    "reference_photo_url": "https://bs.plantnet.org/image/m/xxx.jpg",
    "description": "Le coquelicot est une plante annuelle…"
  },
  "alternatives": [
    { "species_id": "uuid", "common_name": "…", "scientific_name": "…", "family": "…", "confidence": 0.12, "reference_photo_url": "…", "description": null },
    { "species_id": "uuid", "common_name": "…", "scientific_name": "…", "family": "…", "confidence": 0.04, "reference_photo_url": "…", "description": null }
  ],
  "confidence_threshold": 0.70,
  "auto_pickable": true
}
```

Notes :
- `description` est `null` tant que l'enrichissement Wikipedia n'a pas eu lieu. Le mobile peut rappeler `GET /v1/species/:id` plus tard pour récupérer la version enrichie.
- `auto_pickable = top_match.confidence >= 0.70`. Le mobile applique sa logique UX.
- L'id est généré côté serveur (uuid7).

**Errors** (enveloppe standard `{ error: { code, message, details? } }`) :

| Status | Code | Cas |
|---|---|---|
| 400 | `MISSING_FIELD` | Champ `photo` absent |
| 400 | `INVALID_CONTENT_TYPE` | `photo.type !== 'image/jpeg'` |
| 400 | `INVALID_JPEG` | Magic bytes ≠ `FF D8 FF` |
| 400 | `FILE_TOO_LARGE` | buffer > 2_000_000 bytes |
| 400 | `INVALID_EXIF` | `gps_lat` / `gps_lng` / `date_taken` malformé |
| 401 | `UNAUTHORIZED` | Auth manquante / invalide |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 3 Mo (Hono `bodyLimit`) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type non `multipart/form-data` |
| 422 | `NO_MATCH` | PlantNet a répondu 200 avec `results: []` |
| 429 | `QUOTA_EXCEEDED` | 30 identifications dépassées pour le user aujourd'hui |
| 502 | `PLANTNET_UNAVAILABLE` | PlantNet 5xx, 429, ou timeout — quota refundé |
| 500 | `STORAGE_ERROR` | Garage `putObject` throw |

### 5.2 `GET /v1/species/:id`

- **Auth** : requise
- **Params** : `id` (uuid)

**Success — 200 OK** :

```json
{
  "id": "uuid",
  "common_name": "Coquelicot",
  "scientific_name": "Papaver rhoeas",
  "family": "Papaveraceae",
  "description": "Le coquelicot…",
  "reference_photo_url": "https://bs.plantnet.org/image/m/xxx.jpg",
  "wikipedia_url": "https://fr.wikipedia.org/wiki/Papaver_rhoeas"
}
```

`description` / `wikipedia_url` peuvent être `null` si l'enrichissement n'a pas eu lieu ou a 404'd. `reference_photo_url` est la dernière URL PlantNet vue (peut être stale en V2 si la photo est retirée par PlantNet — accepté en MVP).

**Errors** :
- 401 `UNAUTHORIZED`
- 404 `NOT_FOUND` si species inconnue

### 5.3 Persistance

**`plantnet_usage`** (Lot 2, déjà créé) :
- PK composite `(user_id, day)`
- `count` initialisé à 1 lors du premier appel du jour (via UPSERT)
- Les jours antérieurs sont conservés ; cron Lot 8 fera `DELETE WHERE day < current_date - 7`

**`species`** (Lot 2, déjà créé) :
- Unique index sur `scientific_name`
- Lazy upsert sur identification
- `wikipedia_fetched_at` est le marqueur "Wikipedia tenté avec succès". NULL = non tenté ou échec serveur ; non-NULL = tenté (qu'on ait trouvé ou non)

**`identifications`** (Lot 2, déjà créé) :
- `photo_status = 'temp'` à la création
- `expires_at = now() + 24h`
- `plantnet_raw_response` stocke la réponse PlantNet complète (jsonb)
- `top_match_species_id` + `top_match_confidence` pour quick-access
- `exif_metadata` = `{ date_taken?, gps_lat?, gps_lng? }` (jsonb)

## 6. Flux détaillés

### 6.1 Happy path `POST /v1/identifications`

```
1. authMiddleware → user.id, sinon 401
2. Hono parse multipart (bodyLimit 3 Mo, sinon 413)
3. Récupère content-type, photo (File), exif fields
4. content-type !startsWith 'multipart/form-data' → 415
5. !(photo instanceof File) → 400 MISSING_FIELD
6. photo.type !== 'image/jpeg' → 400 INVALID_CONTENT_TYPE
7. buffer = new Uint8Array(await photo.arrayBuffer())
8. validateJpeg(buffer) → 400 INVALID_JPEG ou FILE_TOO_LARGE
9. zod parse { date_taken?, gps_lat?, gps_lng? } → 400 INVALID_EXIF sinon
10. await quota.incrementOrThrow(user.id) → 429 si > 30
11. try {
      results = await plantnet.identify(buffer)
    } catch (PlantnetTimeoutError | PlantnetUnavailableError | PlantnetQuotaExhaustedError) {
      await quota.refund(user.id)
      throw AppError('PLANTNET_UNAVAILABLE', 502)
    }
12. if results.length === 0 → throw AppError('NO_MATCH', 422) (PAS de refund)
13. identificationId = uuid7()
    await garage.putObject({ bucket:'specimens', key:`${user.id}/${identificationId}.jpg`, body:buffer, contentType:'image/jpeg' })
14. For each result (top + alternatives):
      const { species, isNew } = await speciesService.upsertFromPlantnet(result)
      if isNew: scheduleEnrichment(species.id)
15. db.insert(identifications).values({
      id: identificationId,
      userId: user.id,
      photoUrl: `${user.id}/${identificationId}.jpg`,
      photoStatus: 'temp',
      plantnetRawResponse: rawResponse,
      topMatchSpeciesId: speciesByIndex[0].id,
      topMatchConfidence: results[0].score.toFixed(4),
      exifMetadata: { date_taken, gps_lat, gps_lng } (filtré pour undefined),
      expiresAt: new Date(Date.now() + 24*3600*1000),
    })
16. return 201 {
      id,
      top_match: { species_id, common_name, scientific_name, family, confidence, reference_photo_url, description },
      alternatives: [ { ... }, { ... } ],
      confidence_threshold: 0.70,
      auto_pickable: results[0].score >= 0.70,
    }
```

### 6.2 Enrichissement Wikipedia (background)

```
scheduleEnrichment(speciesId):
  queueMicrotask(async () => {
    try { await enrichSpecies(speciesId) }
    catch (err) { logger.warn({ err, speciesId }, 'wikipedia.enrich.failed') }
  })

enrichSpecies(speciesId):
  const sp = await db.select().from(species).where(eq(species.id, speciesId))
  if (!sp) return
  let summary: WikiSummary | null
  try {
    summary = await wikipedia.fetchSummary(sp.scientificName)
  } catch (WikipediaUnavailableError) {
    return  // pas de fetched_at → un futur cron pourra retenter
  }
  await db.update(species).set({
    description: summary?.extract ?? null,
    wikipediaUrl: summary?.contentUrls?.desktop?.page ?? null,
    wikipediaFetchedAt: new Date(),  // posé même en cas de 404 (summary = null)
    updatedAt: new Date(),
  }).where(eq(species.id, speciesId))
```

Le `queueMicrotask` garantit que l'enrichissement s'exécute après que la réponse HTTP a été flushée, sans bloquer le client. En cas de crash du process (rare), on perd l'enrichissement — accepté car best-effort.

### 6.3 `GET /v1/species/:id`

```
1. authMiddleware → 401 sinon
2. db.select().from(species).where(eq(species.id, params.id))
3. !row → 404 NOT_FOUND
4. return 200 { id, common_name, scientific_name, family, description, reference_photo_url, wikipedia_url }
```

### 6.4 Quota atomic

```sql
INSERT INTO plantnet_usage (user_id, day, count)
VALUES (:uid, CURRENT_DATE, 1)
ON CONFLICT (user_id, day)
DO UPDATE SET count = plantnet_usage.count + 1
RETURNING count;
```

Si `count > 30` :

```sql
UPDATE plantnet_usage
SET count = count - 1
WHERE user_id = :uid AND day = CURRENT_DATE;
```

Puis `throw AppError('QUOTA_EXCEEDED', ..., 429)`.

Pourquoi pas de transaction explicite : la combinaison UPSERT + RETURNING est atomique en Postgres. Le refund est best-effort (si on a incrémenté à 31 puis crash entre le RETURNING et le UPDATE, le compteur reste à 31 — peu impactant : le user perd un crédit, pas l'inverse).

### 6.5 Edge case — défaillance Garage après quota++ et PlantNet OK

Le flux §6.1 incrémente le quota (étape 10), appelle PlantNet (étape 11), puis upload la photo Garage (étape 13). Si `garage.putObject` throw, on a déjà consommé un crédit PlantNet sans persister d'identification. **MVP : pas de refund dans ce cas** — la réponse est `500 STORAGE_ERROR`, l'utilisateur perd un crédit pour une panne d'infrastructure. Garage outage étant rare en pratique et l'ajout d'un refund nécessitant de catcher au bon endroit, on accepte le coût pour la simplicité. Si ce cas devient récurrent en prod, le Lot 8 (observabilité) pourra ajouter un refund conditionnel.

## 7. Sécurité

- Mêmes contraintes que Lot 4 : magic bytes JPEG, size cap 2 Mo, bodyLimit 3 Mo.
- `PLANTNET_API_KEY` jamais loggé ni renvoyé au client. Send via URL param uniquement.
- `WIKIPEDIA_USER_AGENT` obligatoire (politique Wikipedia REST API : User-Agent identifiant).
- Pas de SSRF : URLs PlantNet/Wikipedia hard-codées dans `lib/*`, jamais issues du client.

## 8. Tests

### 8.1 Unit

- **`lib/plantnet.ts`** : mock `globalThis.fetch`. Cas : response 200 avec results, response 200 avec results vide, 5xx, 429, AbortError (timeout). Vérifie le multipart form (champ `organs=flower`, `images`, `lang=fr`, `nb-results=3`).
- **`lib/wikipedia.ts`** : mock `globalThis.fetch`. Cas : 200 avec extract+content_urls, 404 → null, 5xx → throw, vérifie header `User-Agent` envoyé.
- **`services/quota.ts`** : real DB. 1er appel, 30e appel (count = 30, ok), 31e appel (count = 31 → refund → throw). Refund explicite après un succès.
- **`services/species.ts`** : real DB. Upsert nouveau (`is_new = true`), upsert existant (`is_new = false`, `updated_at` mis à jour). `getById` happy + 404.
- **`services/species-enrichment.ts`** : stub `lib/wikipedia` + real DB. Cas : found → update OK, 404 → fetched_at set, throw → no update, caught par scheduleEnrichment.
- **`services/identification.ts`** : real DB, stub `lib/plantnet` + `lib/wikipedia` + `lib/garage`. Cas : full success, quota exceeded (429 propagé), plantnet timeout (refund vérifié), no_match (PAS de refund), garage fail (mapped 500), db insert fail. Vérifie `scheduleEnrichment` appelée uniquement sur species nouvelles.

### 8.2 Integration

`tests/integration/identifications.test.ts` (real Postgres + real Garage, PlantNet + Wikipedia mockés via swap pattern) :

- 401 sans auth
- 201 happy : top + 2 alternatives, `auto_pickable=true` si `confidence >= 0.70` sinon false
- 422 NO_MATCH (mock retourne results vide)
- 429 QUOTA_EXCEEDED (DB pré-remplie avec count=30)
- 502 PLANTNET_UNAVAILABLE (mock throw)
- 400 INVALID_JPEG (PNG envoyé avec type=image/jpeg)
- 413 PAYLOAD_TOO_LARGE (>3 Mo)
- 415 UNSUPPORTED_MEDIA_TYPE
- DB : `identifications` créé, `photo_status='temp'`, `expires_at` ≈ now+24h, `top_match_species_id` non-null
- Garage : objet présent sous `<uid>/<idId>.jpg`
- Après `await new Promise(r => setTimeout(r, 50))` : species créées ont `wikipedia_fetched_at` non-null
- Quota : 1 après succès, 0 après PLANTNET_UNAVAILABLE (refund), 1 après NO_MATCH (pas de refund)

`tests/integration/species.test.ts` :

- 401 sans auth
- 200 happy (avec description) après enrichissement
- 200 sans description si `wikipedia_fetched_at IS NULL` ou description NULL (404 Wikipedia)
- 404 species inconnue

## 9. Configuration & déploiement

### 9.1 Env vars

```
PLANTNET_API_KEY=<clé personnelle ou clé free tier>
WIKIPEDIA_USER_AGENT=Airbarium/0.1 (contact@airbarium.app)
```

`.env.example` ajoute ces deux lignes. En CI : `PLANTNET_API_KEY=test-key` (les tests swappent l'impl, la valeur n'a pas d'importance).

### 9.2 Bootstrap bucket `specimens`

`src/server.ts` au boot : `await ensureBucket('specimens')` à côté de `ensureBucket('avatars')`, même skip si `NODE_ENV=production` (en prod le bucket vient de Helm).

### 9.3 CI

Aucune dépendance externe nouvelle. Garage et Postgres déjà démarrés par le workflow Lot 4. Les vars `PLANTNET_API_KEY` + `WIKIPEDIA_USER_AGENT` sont à ajouter dans `.github/workflows/ci.yaml` (valeurs factices, le swap pattern dans les tests fait le mock).

## 10. Hors scope (Lot 5)

- Création de `specimens` à partir d'une identification → Lot 6
- Retry `POST /v1/specimens/:id/identify` → Lot 6
- Cleanup cron des `identifications` expirées → Lot 8
- Cleanup des photos Garage orphelines → Lot 8
- Rate limit global API (600/10min/user) → Lot 8
- Retry Wikipedia via cron pour `wikipedia_fetched_at IS NULL` → Lot 8
- Métriques Prometheus sur PlantNet → Lot 8
