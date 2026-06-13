# Lot 8a — RGPD : suppression de compte `DELETE /v1/me`

> Date : 2026-06-12
> Périmètre : sous-lot 8a du lot 8 (RGPD + cron + observabilité + Helm)
> Statut : design validé, prêt pour plan d'implémentation
> Réf. design parent : `docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md` (§2, §6.3, §7.3, §16)

---

## 1. Objectif

Implémenter la suppression de compte RGPD : `DELETE /v1/me` purge **complètement et
définitivement** toutes les données de l'utilisateur (Postgres + Garage). C'est un **hard
delete** — aucune rétention, aucune conservation pour entraînement ML.

Le lot 8 d'origine empaquetait RGPD + cron + rate-limit + observabilité + Helm. Il est
découpé en sous-lots indépendants livrables séparément. **8a couvre uniquement la
suppression de compte.** Les autres pièces (cron `8b`, rate-limit `8c`, observabilité `8d`,
Helm `8e`) font l'objet de specs distinctes.

## 2. Décision RGPD : hard delete, pas de rétention ML

Rappel des décisions du design parent, pour lever toute ambiguïté :

- **§2** : « Suppression de compte → **Hard delete** complet (DB + Garage) en MVP. La
  conservation anonymisée pour ML sera ajoutée en V2 avec consentement explicite. »
- **§16 (hors scope MVP)** : « Anonymisation et conservation des photos pour ML après
  suppression de compte. »

Conséquence : conserver des photos géolocalisées (lat/lng + EXIF) après une demande de
suppression constituerait un traitement de données personnelles sans base légale. Par
défaut on purge **tout**. La rétention ML deviendra un opt-in conçu proprement en V2 (base
légale, anonymisation, dissociation du `user_id`).

**Distinction importante avec le soft delete de spécimen** :

| Action | Photo Garage |
|---|---|
| `DELETE /v1/specimens/:id` (soft delete spécimen seul) | conservée, purgée par le cron 8b après 30 j |
| `DELETE /v1/me` (suppression de compte) | **purgée immédiatement**, y compris les photos des spécimens soft-deleted |

8a doit donc capturer et purger **toutes** les `photo_url` de l'utilisateur, y compris
celles des spécimens dont `deleted_at IS NOT NULL`.

## 3. Contrat API

```
DELETE /v1/me            (authentifié : cookie Better Auth OU Authorization: Bearer <token>)
  -> 204 No Content      suppression effectuée
  -> 401 Unauthorized    pas de session valide (middleware auth existant, inchangé)
```

- Conforme au contrat documenté au §6.3 du design parent (`DELETE /v1/me`).
- Renvoie notre enveloppe d'erreur standard `{ error: { code, message } }` en cas d'échec
  d'auth (via le middleware existant), **pas** la shape native Better Auth.
- **Pas de re-authentification ni de confirmation par mot de passe** : le spec ne l'exige
  pas en MVP. À reconsidérer en V2 si besoin de durcissement.
- **Idempotence de fait** : un second `DELETE /v1/me` avec la même session échoue en 401
  (la session a été cascade-deleted, le token/cookie ne référence plus rien).

## 4. Choix d'implémentation : route custom (pas Better Auth `deleteUser`)

On implémente une **route custom** `DELETE /v1/me` plutôt que d'activer le mécanisme natif
`user.deleteUser` de Better Auth.

Raisons :
- **Conformité au contrat** : le design documente `DELETE /v1/me`. Le mécanisme BA expose
  `POST /v1/auth/delete-user` (path différent, le mobile devrait appeler autre chose) et
  renvoie la shape d'erreur native BA, pas notre enveloppe `{ error }`.
- **Contrôle de l'ordre** : on doit capturer les clés Garage **avant** le `DELETE` cascadé,
  puis purger Garage hors transaction. Une route custom donne ce contrôle explicite.
- **Le cascade DB fait déjà le gros du travail** (voir §5) — le mécanisme BA n'apporterait
  pas de simplification ici.

## 5. État de la base : le cascade DB est déjà câblé

Vérifié dans `src/db/schema/` — toutes les tables possédées par l'utilisateur ont déjà
`onDelete: 'cascade'` sur `userId` :

| Table | FK vers `users.id` | Comportement |
|---|---|---|
| `specimens` | `userId` | `onDelete: 'cascade'` |
| `identifications` | `userId` | `onDelete: 'cascade'` |
| `plantnet_usage` | `userId` | `onDelete: 'cascade'` |
| `account` (Better Auth) | `userId` | `onDelete: 'cascade'` |
| `session` (Better Auth) | `userId` | `onDelete: 'cascade'` |
| `verification` (Better Auth) | aucune FK | keyé par `identifier` (email/token) — **pas** cascadé |

Donc `DELETE FROM users WHERE id = :me` purge automatiquement specimens, identifications,
plantnet_usage, account et session. **Aucune migration de schéma n'est nécessaire pour 8a.**

`verification` n'a pas de FK : ses lignes contiennent l'email de l'utilisateur dans
`identifier` (PII). On les supprime explicitement par `identifier = :email`.

## 6. Architecture

- **Route fine** — `src/routes/me.ts` :
  ```
  route.delete('/me', authMiddleware(), handler)
  ```
  Le handler : récupère le user authentifié → délègue au service → clear le cookie de
  session sur la réponse → `c.body(null, 204)`. Aucune logique métier dans la route (règle
  d'architecture du projet).

- **Service** — `src/services/account-deletion.ts` :
  ```
  export async function deleteAccount(userId: string, userEmail: string): Promise<void>
  ```
  Orchestration testable sans Hono, réutilise `deleteObject` de `lib/garage.ts`. Pas de
  nouvelle capacité ajoutée à `lib/garage.ts` (la lib garde seulement `deleteObject`
  unitaire — décision de purge par énumération, voir §7).

## 7. Flux détaillé (suit §7.3 du design parent)

```
deleteAccount(userId, userEmail):

  1. Transaction Postgres (db.transaction) :
       a. specimenKeys      = SELECT photo_url FROM specimens
                              WHERE user_id = :userId            -- TOUTES, y compris deleted_at NOT NULL
       b. identificationKeys = SELECT photo_url FROM identifications
                              WHERE user_id = :userId            -- temp + promoted
       c. avatarKey         = SELECT avatar_url FROM users WHERE id = :userId
       d. DELETE FROM verification WHERE identifier = :userEmail -- PII email, pas de FK
       e. DELETE FROM users WHERE id = :userId
                              -- cascade -> specimens, identifications, plantnet_usage,
                              --            account, session
     (la capture a/b/c se fait AVANT le DELETE e : sinon impossible de savoir quoi purger)

  2. Purge Garage, HORS transaction, best-effort :
       keys = [...specimenKeys, ...identificationKeys, avatarKey?]  -- dédupliquées, non nulles
       résultats = await Promise.allSettled(keys.map(k => deleteObject({ bucket, key })))
       pour chaque rejet : log.warn({ err, key }, 'account-deletion: garage purge failed')
       -> un échec Garage ne rollback PAS la DB et ne fait PAS échouer la requête

  3. Retour : void. La route renvoie 204.
```

Notes :
- Les `photo_url` stockées en base sont les **clés Garage** (`specimens/<user_id>/<id>.jpg`,
  `avatars/<user_id>.jpg`), pas des URLs présignées. La purge route chaque clé vers le bon
  bucket (`specimens` vs `avatars`).
- **Best-effort assumé** : si Garage est indisponible, la DB est tout de même purgée
  (priorité RGPD : la donnée personnelle structurée disparaît). Les objets Garage orphelins
  résiduels relèveront du **job de réconciliation périodique** — explicitement hors MVP
  (§7.3 du design parent).
- `Promise.allSettled` (et non `Promise.all`) pour qu'un échec de delete sur une clé
  n'empêche pas la suppression des autres.

### Invalidation de session

Le cascade supprime les lignes `session` de l'utilisateur → tout token Bearer mobile devient
immédiatement invalide. Pour un client cookie web, on **clear le cookie de session Better
Auth** sur la réponse 204 (inoffensif pour un client Bearer). On ne peut pas appeler
`auth.api.signOut` *après* le delete (la session n'existe plus) : on clear le cookie
directement sur la réponse Hono.

## 8. Gestion d'erreurs

| Cas | Comportement |
|---|---|
| Non authentifié | 401 via `authMiddleware()` (inchangé) |
| Échec DELETE DB (transaction) | l'erreur remonte → `error-handler` → 500, rien n'est committé |
| Échec delete Garage (1+ clés) | avalé, loggé en `warn`, la requête réussit quand même (204) |
| Second DELETE même session | 401 (session déjà supprimée) |

## 9. Tests

### Intégration — `tests/integration/me-delete.test.ts` (Postgres + Garage réels)

1. **Purge complète** : créer un user authentifié avec
   - ≥ 2 spécimens dont **un soft-deleted** (`deleted_at` non nul),
   - ≥ 1 identification (status `temp` et/ou `promoted`),
   - un avatar,
   - de **vrais objets uploadés dans Garage** pour chaque `photo_url` + l'avatar.
   `DELETE /v1/me` → **204**. Asserts :
   - lignes `users`, `specimens`, `identifications`, `plantnet_usage`, `session`, `account`
     de ce user **absentes** (cascade),
   - lignes `verification` pour cet email absentes,
   - chaque objet Garage (spécimens incl. soft-deleted, identifications, avatar) **absent**
     (`getObject` → erreur / 404),
   - `GET /v1/me` avec l'ancienne session → **401**.
2. **Résilience Garage** : stubber `deleteObject` pour throw → `DELETE /v1/me` renvoie quand
   même **204** et la DB est purgée (best-effort prouvé). Le warn est loggé.
3. **Auth** : `DELETE /v1/me` sans session → **401**.
4. **Isolation** : un second user non concerné conserve toutes ses données après le delete
   du premier (pas de sur-suppression).

### Unitaire — `tests/unit/services/account-deletion.test.ts`

- `deleteAccount` avec `lib/garage.ts` stubbé (`__setGarageForTests`) :
  - vérifie que l'**ensemble exact des clés** attendues est passé à `deleteObject`
    (specimens incl. soft-deleted + identifications + avatar, dédupliquées, sans nulls),
  - vérifie qu'une erreur levée par `deleteObject` est **avalée** (la fonction résout sans
    throw) et n'empêche pas les autres deletes.

## 10. Fichiers touchés

| Fichier | Nature |
|---|---|
| `src/services/account-deletion.ts` | **nouveau** — service `deleteAccount` |
| `src/routes/me.ts` | ajout de `route.delete('/me', …)` + clear cookie |
| `tests/integration/me-delete.test.ts` | **nouveau** |
| `tests/unit/services/account-deletion.test.ts` | **nouveau** |
| `README.md` | ajout de l'endpoint `DELETE /v1/me` dans la liste des routes exposées |

Pas de migration Drizzle (cascade déjà en place). Pas de nouvelle dépendance.

## 11. Hors scope 8a

- Worker cron `8b`, middleware rate-limit `8c`, observabilité `/metrics` + probes health `8d`,
  chart Helm `8e` — sous-lots distincts.
- Export RGPD complet (`GET /me/export`) — hors MVP (§16 du design parent).
- Rétention / anonymisation des photos pour ML — V2 avec consentement explicite (§2, §16).
- Re-authentification / confirmation par mot de passe avant suppression — non requis en MVP.
- Job de réconciliation des objets Garage orphelins — hors MVP (§7.3).
