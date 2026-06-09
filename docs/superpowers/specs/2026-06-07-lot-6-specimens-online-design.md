# Airbarium — Lot 6 : Specimens online — Design

> Date : 2026-06-07
> Périmètre : backend MVP, Lot 6 du roadmap (CLAUDE.md)
> Statut : design validé, prêt pour plan d'exécution
> Dépendances : Lots 1–5 mergés (PR #7 / `b0e13b0`)

---

## 1. Vue d'ensemble

Lot 6 transforme une `identifications` (créée par Lot 5) en `specimens` permanent. C'est le passage de l'image jetable temporaire au cœur métier de la bibliothèque utilisateur.

Le périmètre est volontairement restreint au **flux online** : le client envoie un `id` UUIDv7 généré côté mobile + un `identification_id` existant + un `chosen_species_id` choisi parmi les candidats PlantNet. Tout ce qui ne nécessite pas d'identification préalable (sync offline, retry identification) est explicitement repoussé en Lot 7.

Endpoints livrés (préfixés `/v1`) :

| Méthode | Path | Rôle |
|---|---|---|
| POST | `/specimens` | Crée un specimen depuis une identification, idempotent sur `id` |
| GET | `/specimens` | Liste paginée cursor-based, filtrée |
| GET | `/specimens/stats` | Compteurs `{ total, distinct_species }` |
| GET | `/specimens/:id` | Specimen complet avec `photo_url` pré-signé |
| PATCH | `/specimens/:id` | Mise à jour partielle (`user_notes`, `location_label`) |
| DELETE | `/specimens/:id` | Soft delete |

---

## 2. Décisions structurantes

Synthèse des choix actés lors du brainstorming. Chaque ligne tranche un point laissé ouvert dans la spec MVP §6.5 / §7.1.

| Sujet | Choix retenu | Raison |
|---|---|---|
| Périmètre | Online uniquement (`identification_id` requis, `source ≠ 'none'`) | Aligne sur CLAUDE.md roadmap. Lot 7 ajoute la branche offline-sync. |
| Promotion photo Garage | Pas de `copyObject`. `specimens.photo_url = identifications.photo_url` (même clé `<uid>/<idId>.jpg`). On flip uniquement `photo_status='promoted'` + `promoted_at=now()`. | Évite une classe d'erreurs S3 (copy puis delete, partial state) et supprime le besoin d'ajouter `copyObject` à `lib/garage.ts`. La clé Garage reste opaque côté mobile (URL pré-signée). |
| Idempotence POST | Lookup `(id, user_id)`. Match → 200 + specimen existant, **on ignore tout le reste du body**. Match d'un autre user → 409 `ID_CONFLICT`. | Conforme spec MVP §6.5. UUIDv7 client-generated permet retry réseau sans dédup côté serveur, no-op total = sémantique idempotente stricte. |
| Cursor pagination | Composite (`{ k, v, id }` base64). `k` = colonne de tri, `v` = valeur, `id` = tie-breaker. Predicate `WHERE (k, id) <op> (cursor.v, cursor.id)`. | Stable même quand plusieurs specimens partagent un `collected_at` (import en masse, sync offline batch). Couvre les 3 sort options en encodant la colonne. |
| Filtres GET list | Combinables en AND. Tous optionnels. | Standard, attendu par les clients. Aucun coût SQL significatif. |
| 404 cross-user | Specimen non trouvé OU appartenant à un autre user → 404 (sauf POST qui retourne 409 sur `id` collision). | Pas de leak d'existence d'IDs. POST traite le cas spécialement parce que l'idempotence le justifie. |
| PATCH semantics | Champ absent (undefined) = pas touché. `null` explicite = clear (set NULL). `""` (empty string) → 400. | JSON distingue undefined / null, on respecte cette sémantique. Empty string est ambigu (clear ou erreur ?) → strict. |
| DELETE | Soft (`deleted_at = now()`). Photo Garage conservée jusqu'au cron Lot 8 (purge 30j). Idempotent : 204 même si déjà soft-deleted. | Conforme spec MVP §5.1. Préserve les données pour ML futur. |
| `/stats` | `count(*)` + `count(DISTINCT species_id) FILTER (WHERE species_id IS NOT NULL)`, scope `user_id = :me AND deleted_at IS NULL`. | Utilise l'index partiel `specimens_user_species_active_idx` (Lot 2). Une seule requête. |
| Validation seuil | `top_match_confidence >= 0.70` ⇒ `chosen == top_match_species_id` ET `source == 'plantnet_auto'`. Sinon ⇒ `source == 'plantnet_picked'`. Sinon 400 `THRESHOLD_VIOLATED`. | Conforme spec MVP §7.1 validations. Le seuil 0.70 est `CONFIDENCE_THRESHOLD` (extrait Lot 5). |
| Pool de candidats | Recompute depuis `identifications.plantnet_raw_response.results[].species.scientificNameWithoutAuthor`, SELECT `species` par scientific_name. | Pas de table `identification_alternatives` à créer : le jsonb suffit. Coût : un SELECT supplémentaire par POST, négligeable. |
| Snapshot fields | À l'INSERT : `identified_name = chosen.common_name`, `scientific_name`, `family` extraits de `species`, `confidence_score = raw.results[i].score` (pour `i` correspondant à `chosen`). Figés à jamais (spec §5.3). | Stabilité historique : si Wikipedia met à jour `species.description`, les specimens passés gardent leur identité validée. |
| `photo_url` en sortie | Toujours pré-signé via `getPresignedUrl(SPECIMENS_BUCKET, key, 3600)`. Jamais la clé brute. | Conforme CLAUDE.md (`Presigned S3 URLs — 1h`). |
| Wrapper d'erreurs | Existant `{ error: { code, message, details? } }` via `AppError`. Pas de nouveau type. Codes ajoutés : `ID_CONFLICT`, `THRESHOLD_VIOLATED`, `INVALID_CHOICE`, `INVALID_CURSOR`, `ALREADY_PROMOTED`, `IDENTIFICATION_EXPIRED`, `INVALID_PATCH`. | Cohérent avec Lots 3-5. |

---

## 3. Contrat API détaillé

### 3.1 `POST /v1/specimens`

**Body** (JSON, `Content-Type: application/json`) :

```jsonc
{
  "id": "0190d8a4-...",                          // UUIDv7 client-generated, requis
  "identification_id": "0190d8a4-...",            // UUID requis (Lot 6 = flux online uniquement)
  "chosen_species_id": "0190d8a4-...",            // UUID requis, ∈ {top_match ∪ alternatives} de l'identification
  "identification_source": "plantnet_auto"        // enum, requis. Lot 6 refuse 'none'.
                          | "plantnet_picked",
  "collected_at": "2026-06-07T10:00:00Z",         // ISO 8601, requis
  "lat": 48.8566,                                 // optionnel, [-90, 90]
  "lng": 2.3522,                                  // optionnel, [-180, 180]
  "location_label": "Jardin du Luxembourg",       // optionnel, ≤ 256 chars
  "user_notes": "Au pied du chêne ouest"          // optionnel, ≤ 2000 chars
}
```

**Algorithme** :

1. `requireUser(c)` → 401 sinon.
2. **Idempotence** : `SELECT * FROM specimens WHERE id = body.id LIMIT 1`.
   - Match `user_id = me` → 200 + specimen existant (response identique à POST réussi). Ignore tous les autres champs.
   - Match `user_id != me` → 409 `ID_CONFLICT`.
3. **Source = 'none' refusé** → 400 `OFFLINE_SOURCE_NOT_ALLOWED` (Lot 7 le débloquera).
4. **Charger identification** : `SELECT * FROM identifications WHERE id = body.identification_id`.
   - Aucun row OU `user_id != me` → 404 `IDENTIFICATION_NOT_FOUND`.
   - `photo_status != 'temp'` → 409 `ALREADY_PROMOTED`.
   - `expires_at <= now()` → 410 `IDENTIFICATION_EXPIRED`.
5. **Pool candidats** : extraire `scientificNameWithoutAuthor` de chaque `plantnet_raw_response.results[].species`. `SELECT id, scientific_name FROM species WHERE scientific_name IN (...)`. Construire `poolById = Set<species.id>`.
   - `chosen_species_id ∉ poolById` → 400 `INVALID_CHOICE`.
6. **Règle du seuil** :
   - Si `top_match_confidence >= 0.70` :
     - `chosen_species_id == top_match_species_id` requis, sinon 400 `THRESHOLD_VIOLATED`.
     - `identification_source == 'plantnet_auto'` requis, sinon 400 `THRESHOLD_VIOLATED`.
   - Sinon (`top_match_confidence < 0.70`) :
     - `identification_source == 'plantnet_picked'` requis, sinon 400 `THRESHOLD_VIOLATED`.
7. **Snapshot** : identifier la `result` qui correspond à `chosen_species_id` via le mapping pool. Extraire `common_name`, `family`, et `score` (= `confidence_score`). `scientific_name = species.scientific_name`.
8. **Transaction** (Drizzle `db.transaction`) :
   - `INSERT INTO specimens (id, user_id, identification_id, species_id, photo_url, identified_name, scientific_name, family, confidence_score, identification_source, lat, lng, location_label, user_notes, collected_at)` avec `photo_url = identification.photo_url`.
   - `UPDATE identifications SET photo_status = 'promoted', promoted_at = now() WHERE id = :idn`.
9. Return 201 `toSpecimenResponse(specimen)`.

**Réponse 201** :

```jsonc
{
  "id": "...",
  "identification_id": "...",
  "species_id": "...",
  "photo_url": "https://garage/...?X-Amz-Signature=...",  // pré-signé 1h
  "identified_name": "Coquelicot",
  "scientific_name": "Papaver rhoeas",
  "family": "Papaveraceae",
  "confidence_score": 0.9234,
  "identification_source": "plantnet_auto",
  "lat": 48.8566,
  "lng": 2.3522,
  "location_label": "Jardin du Luxembourg",
  "user_notes": "Au pied du chêne ouest",
  "collected_at": "2026-06-07T10:00:00Z",
  "created_at": "2026-06-07T10:05:12Z",
  "updated_at": "2026-06-07T10:05:12Z"
}
```

(`deleted_at` jamais retourné — un specimen soft-deleted n'apparaît plus dans aucun endpoint.)

### 3.2 `GET /v1/specimens`

**Query** :

| Param | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string | — | base64 JSON `{k, v, id}`. Malformed → 400 `INVALID_CURSOR`. |
| `limit` | int | 20 | borne [1, 100] |
| `sort` | enum | `collected_at_desc` | `collected_at_desc` \| `created_at_desc` \| `name_asc` |
| `q` | string | — | ≤ 100. Match `identified_name ILIKE %q%`. |
| `family` | string | — | ≤ 100. Match exact sur `family` (snapshot). |
| `date_from` | ISO date | — | Borne inclusive sur `collected_at`. |
| `date_to` | ISO date | — | Borne inclusive sur `collected_at`. |

**Algorithme** :

1. `requireUser(c)`.
2. Décoder `cursor` si présent → `{k, v, id}` ou 400.
3. Build WHERE : `user_id = me AND deleted_at IS NULL` + chaque filtre AND-é.
4. Build ORDER BY selon `sort` :
   - `collected_at_desc` → `ORDER BY collected_at DESC, id DESC`, cursor predicate `(collected_at, id) < (v, cursor_id)`
   - `created_at_desc` → `ORDER BY created_at DESC, id DESC`, predicate idem
   - `name_asc` → `ORDER BY identified_name ASC NULLS LAST, id ASC`, predicate `(identified_name, id) > (v, cursor_id)`. **NULLs** : `identified_name` peut être NULL (snapshot d'une `species` dont PlantNet n'a pas retourné de `commonName`). Si le `limit`-ième row a `identified_name = NULL`, on renvoie `next_cursor = null` (clamp) — les rows NULL ne sont pas paginables en MVP. Acceptable parce que (a) les rows NULL sont rares et (b) elles sont toujours visibles sur la dernière page disponible.
5. `LIMIT limit + 1`. Si plus de `limit` rows → calculer `next_cursor` depuis le `limit`-ième row, trim au limit, retourner. Sinon `next_cursor: null`.

**Réponse 200** :

```jsonc
{
  "data": [ /* specimens ... */ ],
  "next_cursor": "base64..." | null
}
```

### 3.3 `GET /v1/specimens/stats`

**Réponse 200** :

```jsonc
{ "total": 42, "distinct_species": 18 }
```

Scope : `user_id = :me AND deleted_at IS NULL`. `distinct_species` ignore les rows `species_id IS NULL` (pas applicable Lot 6 : tous les specimens créés ont `species_id`, mais code défensif pour Lot 7).

### 3.4 `GET /v1/specimens/:id`

`requireUser` + lookup `(id, user_id, deleted_at IS NULL)`. 404 sinon. Retourne specimen avec `photo_url` pré-signé fraîchement régénéré.

### 3.5 `PATCH /v1/specimens/:id`

**Body** :

```jsonc
{ "user_notes": "...",        // optionnel : string ≤ 2000, null pour clear, omis = pas touché
  "location_label": "..." }   // optionnel : string ≤ 256, null pour clear, omis = pas touché
```

Au moins un champ requis (sinon 400 `INVALID_PATCH`). Empty string `""` interdit (400). UPDATE `updated_at = now()` toujours. Retourne specimen complet.

### 3.6 `DELETE /v1/specimens/:id`

`requireUser` + `UPDATE specimens SET deleted_at = now() WHERE id = :id AND user_id = :me AND deleted_at IS NULL`. Retourne 204. Si specimen n'existe pas du tout (cross-user inclus) → 404. Si déjà soft-deleted → 204 (idempotent).

---

## 4. Structure de code

### 4.1 Nouveaux fichiers

| Path | Responsabilité |
|---|---|
| `src/services/specimens.ts` | Business logic : `create`, `getById`, `list`, `patch`, `softDelete`, `stats`. Helper `toSpecimenResponse(specimen)` pour la transformation snake_case + presigned URL. |
| `src/routes/specimens.ts` | 6 routes Hono, `authMiddleware` global. Parse JSON Zod, délègue, format réponse. |
| `src/schemas/specimens.ts` | Zod : `createSpecimenBody`, `patchSpecimenBody`, `listQuery`. |
| `src/utils/cursor.ts` | `encodeCursor({key, value, id})` / `decodeCursor(str): {...} \| null`. Base64 JSON opaque. |
| `tests/unit/utils/cursor.test.ts` | Round-trip, malformed, edge cases. |
| `tests/unit/services/specimens.test.ts` | Real DB, stub `lib/garage.getPresignedUrl`. Tous chemins du service. |
| `tests/integration/specimens.test.ts` | End-to-end via `buildTestApp` + PlantNet/Wikipedia mockés. |

### 4.2 Fichiers modifiés

| Path | Change |
|---|---|
| `src/routes/index.ts` | `routes.route('/', specimens)` après `species`. |
| `README.md` | Section `## Lot 6 — Specimens quickstart`. |

### 4.3 Fichiers réutilisés sans modification

- `src/middleware/auth.ts` — `authMiddleware()`, `requireUser(c)`
- `src/lib/garage.ts` — `getPresignedUrl`, `__setGarageForTests`
- `src/db/schema/{specimens,identifications,species}.ts` — schémas complets depuis Lot 2
- `src/config/constants.ts` — `CONFIDENCE_THRESHOLD`, `SPECIMENS_BUCKET`
- `src/utils/{uuid,errors}.ts`
- `tests/helpers/{app,db,auth,garage,plantnet}.ts`

---

## 5. Validations & erreurs

| HTTP | Code | Cas |
|---|---|---|
| 200 | — | POST replay (idempotent) ; GET / PATCH succès |
| 201 | — | POST création |
| 204 | — | DELETE |
| 400 | `OFFLINE_SOURCE_NOT_ALLOWED` | POST avec `identification_source = 'none'` (Lot 7) |
| 400 | `INVALID_CHOICE` | POST `chosen_species_id` hors pool |
| 400 | `THRESHOLD_VIOLATED` | POST seuil 0.70 incohérent |
| 400 | `INVALID_CURSOR` | GET list cursor malformé |
| 400 | `INVALID_PATCH` | PATCH sans champ valide |
| 400 | (Zod) | Body invalide (champ manquant, type, longueur) |
| 401 | — | Session manquante / invalide |
| 404 | `SPECIMEN_NOT_FOUND` | GET/PATCH/DELETE id inexistant ou cross-user |
| 404 | `IDENTIFICATION_NOT_FOUND` | POST `identification_id` inexistant ou cross-user |
| 409 | `ID_CONFLICT` | POST `id` existant pour un autre user |
| 409 | `ALREADY_PROMOTED` | POST sur une identification déjà consommée |
| 410 | `IDENTIFICATION_EXPIRED` | POST sur une identification `expires_at <= now()` |

---

## 6. Tests

### 6.1 Unit (`tests/unit/`)

**`utils/cursor.test.ts`** :
- Encode → decode round-trip (3 sortBy variants)
- Decode malformed (non-base64, base64 non-JSON, JSON sans `k`/`v`/`id`) → null
- Decode `null`/`undefined`/`""` → null

**`services/specimens.test.ts`** (real DB, stub Garage) — couvre :
- `create` happy `plantnet_auto` (high confidence)
- `create` happy `plantnet_picked` (low confidence, chosen != top)
- `create` idempotent (replay même user → existing, sans re-side-effect)
- `create` 409 ID_CONFLICT (replay other user)
- `create` 400 OFFLINE_SOURCE_NOT_ALLOWED
- `create` 404 IDENTIFICATION_NOT_FOUND (foreign + inexistant)
- `create` 409 ALREADY_PROMOTED
- `create` 410 IDENTIFICATION_EXPIRED
- `create` 400 INVALID_CHOICE
- `create` 400 THRESHOLD_VIOLATED (3 sous-cas : high+picked, high+wrong-chosen, low+auto)
- `create` vérifie en DB : snapshot rempli, `identifications.photo_status='promoted'`, `promoted_at` non-null
- `getById` 200 + 404 cross-user + 404 soft-deleted
- `list` 3 pages cursor (collected_at_desc), incl. 2 specimens avec collected_at identique
- `list` filtres q / family / dates AND-és
- `list` sort variants
- `patch` happy + 404 + null = clear + empty string 400 + sans champs 400
- `softDelete` happy + idempotent + 404 inexistant
- `stats` 0 + N specimens avec doublons d'espèces

### 6.2 Integration (`tests/integration/specimens.test.ts`)

Pattern :
- `beforeAll` : `setupTestDb`, `setupTestGarage` (specimens bucket), install mocks plantnet+wikipedia
- `beforeEach` : `truncateAll`, sign-up fresh user, capture bearer
- Helper local `createIdentification({ topConfidence })` : POST `/v1/identifications` avec PlantNet mocké
- Helper local `createSpecimen({ ... })` : POST `/v1/specimens`

Cas couverts :
- 401 sur les 6 routes sans bearer
- 201 POST happy `plantnet_auto` + DB checks
- 201 POST happy `plantnet_picked`
- 200 POST replay (idempotent)
- 409 POST autre user
- 400 OFFLINE_SOURCE_NOT_ALLOWED
- 400 INVALID_CHOICE
- 400 THRESHOLD_VIOLATED
- 410 IDENTIFICATION_EXPIRED (manuellement set `expires_at` à -1h en DB)
- 409 ALREADY_PROMOTED (replay POST avec un nouveau specimen `id` sur une identification déjà consommée)
- GET `/v1/specimens/:id` 200 + photo_url contient `X-Amz-Signature`
- GET `/v1/specimens/:id` 404 cross-user
- GET `/v1/specimens` 3 pages, sort par défaut + name_asc + created_at_desc
- GET `/v1/specimens` filtres seuls + combinés
- GET `/v1/specimens` cursor malformé → 400
- GET `/v1/specimens/stats` avant et après soft-delete
- PATCH 200 + null clear + 404 cross-user + 400 sans champ
- DELETE 204 + GET list ne retourne plus + GET /:id 404 + DELETE 204 idempotent

---

## 7. Verification

1. **Setup** : `docker compose up -d` ; `nix develop --command bun run db:migrate` (pas de nouvelle migration attendue).
2. **`nix develop --command bun test`** → toutes suites Lot 1-6 vertes.
3. **`nix develop --command bun run typecheck && bun run lint`** → propre.
4. **Smoke local** :
   ```bash
   nix develop --command bun run dev
   # Sign-up, capture bearer
   # POST /v1/identifications avec une JPEG → identification_id + top_match.species_id
   # POST /v1/specimens (uuid7 client-side, identification_id, chosen_species_id, source, collected_at) → 201
   # Replay même POST → 200 idempotent
   # GET /v1/specimens → liste
   # GET /v1/specimens/stats → {total:1, distinct_species:1}
   # PATCH user_notes → 200 ; DELETE → 204 ; GET /:id → 404
   ```
5. **CI verte** sur la PR (mêmes vars d'env que Lot 5).

---

## 8. Hors scope (Lot 7-8)

- Branche `identification_source = 'none'` (offline-sync sans `identification_id`, upload photo direct via multipart) → **Lot 7**
- `POST /v1/specimens/:id/identify` (retry identification quand `source='none'`) → **Lot 7**
- Cron de purge des specimens soft-deleted > 30j + photos Garage orphelines → **Lot 8**
- Cascade Garage du `DELETE /v1/me` (RGPD) → **Lot 8**
- Rate limit global API (600/10min/user) → **Lot 8**
- Métriques Prometheus specimens → **Lot 8**
- Reverse geocoding (`location_label` reste input user libre en MVP) → V2
- Optimistic locking / multi-device — un PATCH sans `If-Match` est last-write-wins (conforme spec MVP §7.2)

---

## 9. Risques & mitigations

| Risque | Mitigation |
|---|---|
| Course condition POST replay : 2 requêtes simultanées avec même `id` | UNIQUE constraint sur `specimens.id` (PK) → INSERT échoue avec 23505 sur la 2e. Le service rattrape et retourne le résultat du SELECT idempotent. |
| Course condition POST sur même `identification_id` : 2 specimens créés à partir de la même identification | La transaction inclut le UPDATE `photo_status='temp' → 'promoted'`. Si 2 POST concurrents, le 2e voit `photo_status='promoted'` et lève 409 `ALREADY_PROMOTED`. Possible amélioration : `UPDATE ... WHERE photo_status='temp' RETURNING *`, si 0 row → 409. |
| `plantnet_raw_response` schema drift (PlantNet change la shape) | Le pool des candidats utilise un schéma stable (`results[].species.scientificNameWithoutAuthor`). Si futurement PlantNet change, on bumpe la version PlantNet API et on adapte le mapping côté `lib/plantnet`. |
| Cursor compromis (utilisateur forge un cursor pointant sur les rows d'un autre user) | Le WHERE inclut systématiquement `user_id = :me`. Le cursor ne fait que filtrer les rows déjà scopés au user. Sécurité OK. |
| Index manquant pour `name_asc` sort | Acceptable en MVP (volume utilisateur faible, sort sur champ non-NULL ILIKE indexé indirectement). En V2 : ajouter `CREATE INDEX ... ON specimens (user_id, identified_name) WHERE deleted_at IS NULL`. |
| Snapshot drift (PlantNet rename `commonNames[0]` plus tard) | Le snapshot est figé au moment du POST — par construction, drift impossible sur les specimens existants. Les nouveaux specimens captureront le nouveau nom, comportement attendu. |

---

## 10. Done = ?

À l'issue du lot :

- [ ] Les 6 endpoints répondent et sont couverts par au moins un test d'intégration
- [ ] La règle du seuil 0.70 est testée dans les 4 quadrants (auto+top, auto+other, picked+low, picked+high)
- [ ] L'idempotence POST est testée (même user → no-op, autre user → 409)
- [ ] Le soft delete + cron-deferred photo cleanup est testé (specimen disparaît mais photo reste, vérifié via Garage list)
- [ ] `bun test` + `bun run typecheck` + `bun run lint` verts
- [ ] CI verte sur PR
- [ ] README mis à jour avec section Lot 6 + status roadmap
- [ ] Lot 7 démarrable : `services/specimens.create` accepte une voie `source='none'` derrière un flag (sera ajoutée à ce moment-là)
