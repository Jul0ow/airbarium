# Airbarium — Lot 7 : Sync offline + retry identify — Design

> Date : 2026-06-11
> Périmètre : backend MVP, Lot 7 du roadmap (CLAUDE.md)
> Statut : design validé, prêt pour plan d'exécution
> Dépendances : Lots 1–6 mergés (PR #8 / `1743ee7`)

---

## 1. Vue d'ensemble

Lot 6 a livré le flux **online** de `specimens` : le mobile a du réseau, identifie via `POST /v1/identifications`, puis crée le specimen via `POST /v1/specimens` (JSON, `identification_id` requis). Lot 7 couvre les deux cas où ce chemin idéal casse :

1. **Sync offline** — le mobile a accumulé des photos hors-ligne (UUIDv7 générés localement, JPEG en SQLite). À la reconnexion, il pousse chaque specimen via `POST /v1/specimens` en **multipart** (photo brute, `identification_source='none'`, pas d'`identification_id`). Le serveur tente une identification synchrone à la place de l'utilisateur.

2. **Retry identify** — un specimen resté `identification_source='none'` (PlantNet KO ou quota épuisé au moment de la sync) peut être ré-identifié à la demande via `POST /v1/specimens/:id/identify`.

Endpoints livrés (préfixés `/v1`) :

| Méthode | Path | Rôle |
|---|---|---|
| POST | `/specimens` (multipart) | Crée un specimen offline depuis une photo brute, identification synchrone best-effort |
| POST | `/specimens/:id/identify` | Retry d'identification pour un specimen `source='none'` |

Le flux online de Lot 6 (`POST /specimens` JSON) reste **inchangé**.

---

## 2. Décisions structurantes

Synthèse des choix actés lors du brainstorming. Chaque ligne tranche un point laissé ouvert dans la spec MVP §7.2 / §7.3.

| Sujet | Choix retenu | Raison |
|---|---|---|
| Endpoint offline | `POST /v1/specimens` **unique**, bifurcation par Content-Type : `application/json` → flux online (Lot 6), `multipart/form-data` → flux offline. Sinon 415. | Conforme spec MVP §6.5. Côté mobile c'est la même action ("ajouter une fleur") ; seul le contexte réseau au moment de la photo diffère. |
| Identification offline | **Synchrone, bloquante, timeout 10s** (réutilise le timeout existant de `identifyRaw`). | Conforme spec MVP §7.2. L'utilisateur n'étant pas présent, le serveur identifie à sa place. Réponse 201 portant le specimen final (identifié ou non). |
| Seuil 0.70 en offline | **PAS appliqué.** Le top match est retenu quelle que soit sa confidence, `source='plantnet_auto'`, snapshot avec la confidence brute. | Conforme spec MVP §7.2 : demander à l'utilisateur de choisir a posteriori serait une UX confuse. Le mobile peut afficher un warning visuel si confidence basse, sans bloquer. |
| PlantNet KO / quota / no_match en offline | **Swallow** : specimen inséré avec `source='none'`, FK + snapshot NULL, **201 retournée**. Quota remboursé **uniquement** sur erreur ≠ 200 PlantNet (timeout / 5xx / quota global). **Pas de refund sur no_match** (résultats vides = 200 légitime). | Un batch de 50 specimens ne doit jamais échouer parce que PlantNet hoquette sur une photo. Le mobile retentera via `/:id/identify`. Convention quota alignée sur Lot 5 (`services/identification.ts`, MVP §8.1). |
| Refacto de `create()` | **Aucune.** Embranchement après l'idempotence (step 1 commun), puis discriminant `'identification_id' in input` → branche online (Lot 6 inchangé) ; sinon → branche offline. | Minimise les risques de régression sur le flux Lot 6 figé. Historique git lisible. |
| Promotion photo | En offline il n'y a pas de promotion : la photo est uploadée directement sous `<userId>/<specimenId>.jpg`. Pas d'`identifications` temp consommée. | Le specimen offline ne dérive pas d'une `identifications`. La clé Garage est la clé finale dès l'upload. |
| Idempotence offline | Premier `SELECT * WHERE id = body.id` partagé avec online. Match `user_id = me` → 200 + specimen existant, body ignoré (no-op total, **pas de ré-upload Garage**). Match cross-user → 409 `ID_CONFLICT`. | Conforme spec MVP §6.5 / §7.2 (ack idempotent FIFO). UUIDv7 client-generated permet le retry réseau sans dédup serveur. |
| Concurrence offline | Race sur le PK (deux POST concurrents même `id`) → 23505, on re-SELECT et on retourne le specimen existant (idempotent), comme Lot 6. La photo Garage du perdant reste orpheline. | Accepté : objet orphelin nettoyé par le cron Lot 8. Préférable à un verrou applicatif. |
| `POST /:id/identify` — éligibilité | Valide **uniquement si** `identification_source === 'none'` ET specimen vivant (`deleted_at IS NULL`). Sinon 409 `ALREADY_IDENTIFIED` (déjà identifié) ou 404 `SPECIMEN_NOT_FOUND`. | Conforme spec MVP §5.2 / §7.2 : une identification posée est immuable. |
| `POST /:id/identify` — seuil | **PAS appliqué** (même règle qu'offline-sync). Top match retenu → `source='plantnet_auto'`. | Conforme spec MVP §7.2 dernière phrase. |
| `POST /:id/identify` — quota | `incrementOrThrow(userId)` AVANT l'appel PlantNet → 429 `QUOTA_EXCEEDED` propagé. **Refund** sur 502 (panne upstream) et photo manquante (échec interne avant appel PlantNet). **Pas de refund sur 422 NO_MATCH** (résultats vides = 200 légitime, quota consommé à juste titre). | Cohérent avec `services/identification.ts` (Lot 5) : décrément seulement sur erreur ≠ 200 PlantNet (MVP §8.1). |
| `POST /:id/identify` — photo manquante | Clé Garage absente alors que le specimen existe → 500 `PHOTO_NOT_FOUND`, quota remboursé. | État incohérent (donnée perdue). Fail loud plutôt que silencieux. |
| Wrapper d'erreurs | Existant `{ error: { code, message, details? } }` via `AppError`. Codes nouveaux : `ALREADY_IDENTIFIED`, `PHOTO_NOT_FOUND`. Réutilisés : `UNSUPPORTED_MEDIA_TYPE`, `MISSING_FIELD`, `INVALID_CONTENT_TYPE`, `ID_CONFLICT`, `QUOTA_EXCEEDED`, `PLANTNET_UNAVAILABLE`, `NO_MATCH`, `PAYLOAD_TOO_LARGE`. | Cohérent avec Lots 3-6. |

---

## 3. Contrat API détaillé

### 3.1 `POST /v1/specimens` — flux offline (multipart)

**Discrimination** : si `Content-Type` commence par `multipart/form-data`, branche offline. Si `application/json`, branche online (Lot 6, inchangée). Sinon → 415 `UNSUPPORTED_MEDIA_TYPE`.

**Body** (`multipart/form-data`) :

| Champ | Type | Contraintes |
|---|---|---|
| `id` | string | UUID, requis. Client-generated UUIDv7. |
| `photo` | file | `image/jpeg`, requis, ≤ 2 Mo, magic bytes JPEG validés. |
| `identification_source` | string | doit valoir `'none'`, requis. |
| `collected_at` | string | ISO 8601 avec offset, requis. |
| `lat` | string→number | optionnel, `[-90, 90]`. |
| `lng` | string→number | optionnel, `[-180, 180]`. |
| `location_label` | string | optionnel, 1–256 chars. |
| `user_notes` | string | optionnel, 1–2000 chars. |

`identification_id` et `chosen_species_id` sont **refusés** (schéma `.strict()`).

**Algorithme** :

```
1. authMiddleware → 401 sinon
2. bodyLimit JPEG_BODY_LIMIT_BYTES (3 Mo, marge sur 2 Mo logique) → 413 PAYLOAD_TOO_LARGE sinon
3. Content-Type multipart → parseBody ; sinon JSON (Lot 6) ou 415
4. photo absente / non-File → 400 MISSING_FIELD
   photo.type !== 'image/jpeg' → 400 INVALID_CONTENT_TYPE
   validateJpeg(buffer) → 400 (magic bytes) sinon
5. CreateSpecimenOfflineFormSchema.safeParse(champs) → 400 sinon
6. service.create(userId, { id, photo, identification_source:'none', collected_at, ... }) :
   a. idempotence : SELECT * FROM specimens WHERE id = input.id
      - match user_id = me → return { specimen, wasCreated:false }  (200)
      - match user_id != me → 409 ID_CONFLICT
   b. putObject(bucket=specimens, key=`<userId>/<id>.jpg`, body=photo, image/jpeg)
   c. INSERT specimens (id, userId, photoUrl=key, identificationSource='none',
                        collectedAt, lat?, lng?, locationLabel?, userNotes?)
      FK (identificationId, speciesId) NULL, snapshot NULL.
      - 23505 specimens_pkey → re-SELECT idempotent (loser de race) → 200
   d. tryIdentifyOffline(userId, inserted, photoBuffer) — best-effort, voir §4.1
   e. return { specimen: toSpecimenResponse(final), wasCreated:true }
7. 201 (création) ou 200 (idempotent replay)
```

### 3.2 `POST /v1/specimens/:id/identify` — retry

**Body** : vide (aucun). Pas de validator.

**Réponses** : 200 specimen mis à jour | 404 | 409 | 429 | 422 | 502 | 500.

**Algorithme** :

```
1. authMiddleware → 401 sinon
2. parseSpecimenIdOr404(:id) → 404 SPECIMEN_NOT_FOUND si UUID malformé (uniformité Lot 6)
3. service.retryIdentify(userId, id) — voir §4.2
4. 200 + toSpecimenResponse(updated)
```

---

## 4. Algorithmes des services

### 4.1 `tryIdentifyOffline(userId, specimen, photoBuffer): Promise<Specimen>`

Best-effort : ne throw jamais. Retourne le specimen mis à jour (si identifié) ou inchangé (si KO).

```
try:
  await incrementOrThrow(userId)            // QUOTA_EXCEEDED → catch → specimen inchangé
  const { results } = await identifyRaw(photoBuffer)   // timeout 10s
  if results.length === 0:
    return specimen                          // no_match (200 légitime), pas de refund, reste 'none'
  const top = results[0]
  const pair = await upsertFromPlantnet({ scientificName, commonName, family, referencePhotoUrl })
  if pair.isNew: scheduleEnrichment(pair.species.id)
  const [updated] = UPDATE specimens
    SET speciesId = pair.species.id,
        identifiedName = top.commonName,
        scientificName = top.scientificName,
        family = top.family,
        confidenceScore = top.score.toFixed(4),
        identificationSource = 'plantnet_auto',
        updatedAt = now()
    WHERE id = specimen.id
    RETURNING *
  return updated ?? specimen
catch (err):
  // incrementOrThrow throw QUOTA_EXCEEDED → déjà refund interne, rien à faire
  // identifyRaw throw Timeout/Unavailable/QuotaExhausted → refund
  if err instanceof (PlantnetTimeoutError | PlantnetUnavailableError | PlantnetQuotaExhaustedError):
    await refund(userId)
  return specimen                            // reste 'none'
```

Note : `incrementOrThrow` se rembourse lui-même quand il throw `QUOTA_EXCEEDED` (il a incrémenté puis dépassé le seuil). Les autres erreurs proviennent de PlantNet **après** un incrément réussi → on rembourse explicitement.

### 4.2 `retryIdentify(userId, id): Promise<SpecimenResponse>`

```
a. const [s] = SELECT * FROM specimens WHERE id, user_id = me, deleted_at IS NULL
   if !s → 404 SPECIMEN_NOT_FOUND
b. if s.identificationSource !== 'none' → 409 ALREADY_IDENTIFIED
c. await incrementOrThrow(userId)           // 429 QUOTA_EXCEEDED propagé tel quel
d. let photoBuffer
   try:
     photoBuffer = await getObject({ bucket: SPECIMENS_BUCKET, key: s.photoUrl })
   catch (S3 NoSuchKey / NotFound):
     await refund(userId)
     → 500 PHOTO_NOT_FOUND
e. let results
   try:
     ({ results } = await identifyRaw(photoBuffer))
   catch (err):
     await refund(userId)
     if err instanceof PlantnetQuotaExhaustedError: logger.error('plantnet.global_quota_exhausted')
     → 502 PLANTNET_UNAVAILABLE
f. if results.length === 0:
     → 422 NO_MATCH       // pas de refund : 200 légitime, quota consommé (Lot 5 convention)
g. const top = results[0]
   const pair = await upsertFromPlantnet(top)
   if pair.isNew: scheduleEnrichment(pair.species.id)
h. const [updated] = UPDATE specimens
     SET speciesId, identifiedName, scientificName, family, confidenceScore,
         identificationSource = 'plantnet_auto', updatedAt = now()
     WHERE id = s.id AND user_id = me AND identification_source = 'none'
     RETURNING *
   if !updated:   // un autre retry concurrent a déjà identifié
     re-SELECT WHERE id, user_id, deleted_at IS NULL → return toSpecimenResponse(reSelected)
   return toSpecimenResponse(updated)
```

---

## 5. Validation des entrées

- **Multipart** : `validateJpeg` (magic bytes `FF D8 FF`) + check `photo.type === 'image/jpeg'`, comme `POST /identifications` (Lot 5).
- **`bodyLimit`** route-level à `JPEG_BODY_LIMIT_BYTES` (3 Mo, marge sur le 2 Mo logique), appliqué **avant** auth, comme Lot 5.
- **Champs offline** : `CreateSpecimenOfflineFormSchema` (Zod `.strict()`). `lat`/`lng` via `z.coerce.number()` (multipart = strings). `identification_source` = `z.literal('none')`.
- **Source online refusée en multipart** : `identification_source='plantnet_auto'|'plantnet_picked'` envoyé en multipart → 400 (le schéma offline attend `'none'`).

---

## 6. Structure de code

### Nouveaux fichiers

| Path | Responsabilité |
|---|---|
| `src/schemas/specimens-offline.ts` | `CreateSpecimenOfflineFormSchema` — parse/valide les champs multipart du flux offline. |
| `tests/unit/services/specimens-offline.test.ts` | Couvre `create()` branche offline + `retryIdentify()` : happy, KO PlantNet, quota, idempotence. |

### Fichiers modifiés

| Path | Change |
|---|---|
| `src/lib/garage.ts` | Ajouter `getObject({ bucket, key }): Promise<Uint8Array>` via `GetObjectCommand` + `transformToByteArray()`. Stub dans `__setGarageForTests`. Erreur S3 NotFound laissée remonter (le service la traduit en `PHOTO_NOT_FOUND`). |
| `src/services/specimens.ts` | `CreateInput = CreateOnlineInput \| CreateOfflineInput`. `create()` : idempotence en step 1, puis discriminant `'identification_id' in input`. Branche offline + helper `tryIdentifyOffline`. Nouvelle export `retryIdentify`. |
| `src/routes/specimens.ts` | `POST /specimens` : dispatch Content-Type (JSON Lot 6 inchangé / multipart offline / 415). `bodyLimit` route-level. Nouvelle route `POST /specimens/:id/identify`. |
| `tests/integration/specimens.test.ts` | Sections "offline sync" + "retry identify". |
| `README.md` | Section Lot 7 quickstart. |

### Réutilisés sans modification

`middleware/auth.ts`, `services/quota.ts` (`incrementOrThrow`, `refund`), `services/species.ts` (`upsertFromPlantnet`), `services/species-enrichment.ts` (`scheduleEnrichment`), `lib/plantnet.ts` (`identifyRaw` + erreurs typées), `utils/jpeg.ts`, `utils/errors.ts`, `config/constants.ts` (`SPECIMENS_BUCKET`), schéma `specimens` (enum `identification_source` inclut déjà `'none'`).

---

## 7. Hors scope (Lot 7)

- Worker async fire-and-forget pour l'identification offline (rejeté : le mobile veut le specimen final dans la réponse de sync).
- Pré-refacto de `services/specimens.ts:create()` en helpers `createOnline`/`createOffline` (rejeté : gros diff sur du code Lot 6 figé).
- Cron de purge des specimens soft-deleted > 30j + photos Garage orphelines → Lot 8.
- Cascade Garage du `DELETE /v1/me` (RGPD) → Lot 8.
- Rate limit global API (600/10min/user) → Lot 8.
- Métriques Prometheus offline-sync / retry → Lot 8.
- Multi-device optimistic locking → V2.

---

## 8. Critères de "done" du Lot 7

- [ ] `POST /v1/specimens` multipart crée un specimen offline et l'identifie en synchrone (PlantNet mock) — testé en intégration.
- [ ] PlantNet KO / quota / no_match en offline → 201 specimen `source='none'` ; quota remboursé sur erreur ≠ 200 (timeout/5xx/quota), pas de refund sur no_match — testé.
- [ ] Idempotence multipart (replay même `id`) → 200, pas de double upload — testé.
- [ ] `POST /v1/specimens/:id/identify` identifie un specimen `source='none'` → 200 — testé.
- [ ] Retry sur specimen déjà identifié → 409 `ALREADY_IDENTIFIED` — testé.
- [ ] Retry avec quota épuisé → 429 ; PlantNet KO → 502 avec refund vérifié en DB — testé.
- [ ] Le flux online Lot 6 (`POST /specimens` JSON) reste vert (non-régression).
- [ ] `typecheck` + `lint` + `bun test` propres.
- [ ] README à jour (CLAUDE.md rule).
