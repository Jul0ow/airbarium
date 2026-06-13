# Lot 8c — Rate limiting backed by Postgres — Design

> Date : 2026-06-13
> Périmètre : lot 8c du roadmap (sous-découpage du lot 8)
> Statut : design validé, prêt pour le plan d'implémentation

---

## 1. Contexte et objectif

Le design MVP (§9.3) impose que tout le rate limiting soit adossé à Postgres ("Pas de Redis en MVP : compteurs en Postgres avec une table `rate_limit`"). État actuel :

- **Quota PlantNet** (30/jour/user) — livré via `plantnet_usage` + `src/services/quota.ts`.
- **Limites sign-in / sign-up** — livrées, mais **en mémoire** dans Better Auth (`src/auth/better-auth.ts`). Avec 2 réplicas en prod, chaque réplica compte séparément : l'allocation effective vaut ~2× la spec (ex. 6 sign-ups/h au lieu de 3). La protection anti-brute-force est plus faible que prévu.
- **Limite API globale** (600 req / 10 min / user, fenêtre glissante) — **non implémentée**. La table `rate_limit` (`src/db/schema/rate-limit.ts` : `key`, `windowStart`, `count`, `expiresAt`) a été créée au lot 2 pour exactement ça et reste inutilisée.

Le lot 8c comble les deux manques :

1. Construire le **middleware de limite API globale** (fenêtre glissante à buckets, adossée Postgres) sur la table `rate_limit` existante.
2. Rendre les limites des routes d'auth de Better Auth **adossées Postgres** pour qu'elles soient correctes entre réplicas.
3. Brancher le nettoyage des deux tables dans le cron one-shot du lot 8b, et purger les lignes de rate-limit globales d'un user à la suppression de compte.

## 2. Décisions structurantes

| Sujet | Choix | Raison |
|---|---|---|
| Portée | Limite globale **+** migration des limites d'auth vers Postgres | §9.3 exige Postgres pour tout ; correction du biais multi-réplica |
| Algorithme limite globale | Fenêtre glissante à **buckets de 1 minute** | Correspond à la spec ("granularité 1 min") et à la PK `(key, windowStart)` existante |
| Mode dégradé (erreur DB) | **Fail-open** : log warn + laisse passer | Une panne du limiteur ne doit pas faire tomber l'API ; posture best-effort du projet ; l'auth a sa propre barrière |
| Nettoyage des tables | Étendre le cron one-shot du lot 8b (`runPurgeCycle`) | Un seul job de rétention, cohérent avec les 3 purges existantes |
| Stockage limites d'auth | `rateLimit.storage = 'database'` de Better Auth | Géré par BA ; schéma de table **propre à BA** (`id`, `key`, `count`, `lastRequest`), incompatible avec `rate_limit` → table dédiée |

## 3. Architecture

```
Requête → secureHeaders / CORS / requestId / logger (app.ts, inchangé)
        → sous-router authentifié : authMiddleware() → globalRateLimit() → handler
                                     (pose c.user)      (lit c.user, fenêtre Postgres)
        → /v1/auth/* : handler Better Auth, désormais rateLimit.storage='database'
                       (table auth_rate_limit)
```

- Le limiteur global est **clé par user** (`global:<userId>`) : il doit s'exécuter **après** `authMiddleware` qui pose `c.get('user')`. Les sous-routers `me`, `species`, `specimens`, `identifications` sont 100 % authentifiés → on remonte l'auth au niveau du router et on chaîne le limiteur juste après. `health` reste public et inchangé.
- La logique vit dans un **service** (`src/services/rate-limit.ts`), testable sans Hono (même schéma que `quota.ts`) ; le middleware n'est qu'un wrapper fin.
- Le limiteur d'auth reste **dans** Better Auth : on bascule le stockage en `database` et on enregistre la table.

## 4. Modèle de données

### 4.1 `rate_limit` (existante, réutilisée)

`key` (text), `windowStart` (timestamptz), PK `(key, windowStart)`, `count` (int), `expiresAt` (timestamptz), index sur `expiresAt`. Usage limite globale : un bucket par `(global:<userId>, minute)`.

### 4.2 `auth_rate_limit` (nouvelle, gérée par BA)

Schéma imposé par Better Auth :

| Colonne | Type | Notes |
|---|---|---|
| id | text PK | UUIDv7 via `advanced.database.generateId` |
| key | text UNIQUE NOT NULL | clé BA (IP / chemin) |
| count | integer NOT NULL default 0 | |
| lastRequest | bigint NOT NULL | epoch ms |

## 5. Algorithme de la limite globale

- `GLOBAL_RATE_LIMIT_MAX = 600`, `GLOBAL_RATE_LIMIT_WINDOW_MS = 600_000`, `GLOBAL_RATE_LIMIT_BUCKET_MS = 60_000`.
- À chaque requête authentifiée : `bucket = floor(now / 60s)` ; upsert `(key, windowStart=bucket)` `count += 1`, `expiresAt = bucket + 10 min`.
- Somme glissante : `SELECT sum(count) FROM rate_limit WHERE key = :key AND windowStart > now() - 10 min`.
- `allowed = sum <= 600`. Sinon → 429 `RATE_LIMITED` + en-tête `Retry-After: 60`.
- **Increment-then-check** : les requêtes rejetées sont quand même comptées (standard, décourage le matraquage).
- **Fail-open** : toute exception de la requête → `log.warn` + `next()`.

## 6. Nettoyage (cron lot 8b)

- `DELETE FROM rate_limit WHERE expiresAt < now()`.
- `DELETE FROM auth_rate_limit WHERE lastRequest < (now - AUTH_RATE_LIMIT_MAX_WINDOW_MS)` où `AUTH_RATE_LIMIT_MAX_WINDOW_MS = 1 h` (plus grande fenêtre BA = sign-up). Au-delà, une ligne ne peut plus influencer aucune limite.
- Les deux purges rejoignent `runPurgeCycle` et son agrégat `hadError`.

## 7. Suppression de compte (RGPD)

Dans la transaction de `deleteAccount`, ajouter `DELETE FROM rate_limit WHERE key = 'global:<userId>'`. La table `auth_rate_limit` (clé IP/chemin, sans lien fort au user, auto-expirée par le cron) est laissée telle quelle.

## 8. Tests

- **Service limite globale** (intégration, buckets seedés directement) : somme 599 → autorisé ; +1 → refusé ; buckets > 10 min exclus ; users distincts isolés.
- **Middleware** (intégration) : route de test derrière `authMiddleware()+globalRateLimit()`, table seedée au plafond → 429 + `Retry-After` + `code: RATE_LIMITED`. Fail-open : service patché pour throw → 200.
- **Auth Postgres** (intégration) : après une requête d'auth, une ligne existe dans `auth_rate_limit` (prouve le stockage DB ; en test, sign-up est plafonné à 1000 donc pas d'assertion de 429).
- **Cron** : étendre `cron-purge.test.ts` (bucket `rate_limit` expiré + ligne `auth_rate_limit` > 1 h supprimés ; lignes fraîches conservées, borne stricte).
- **Suppression de compte** : étendre `me-delete.test.ts` (bucket `global:<userId>` purgé).
- **Routes** : tests existants verts (auth toujours appliquée) ; une route déplacée renvoie toujours 401 sans session.

## 9. Hors scope

- Limite sliding sur les routes d'auth (on conserve l'algorithme natif BA, seul le stockage change).
- En-têtes `X-RateLimit-*` détaillés (seul `Retry-After` est exposé).
