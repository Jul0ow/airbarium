# Lot 8b — Worker cron de purge (+ réconciliation des orphelins Garage)

> Date : 2026-06-13
> Périmètre : sous-lot 8b du lot 8 (RGPD + cron + observabilité + Helm)
> Statut : design validé, prêt pour plan d'implémentation
> Réf. design parent : `docs/superpowers/specs/2026-05-26-airbarium-backend-mvp-design.md` (§4, §7.3, §7.4, §11.3, §13)

---

## 1. Objectif

Implémenter le worker de maintenance périodique : un process Bun **one-shot** (`src/cron.ts`)
qui exécute un cycle de purge puis se termine. L'ordonnancement (toutes les heures) est
délégué à un **CronJob Kubernetes** livré au lot 8e — le worker lui-même ne boucle pas.

Le cycle purge trois catégories de données expirées (§7.4 du design parent) **et** réconcilie
les objets Garage orphelins (le « job de réconciliation » qui était différé hors MVP au
§7.3/§7.4 — désormais inclus dès 8b à la demande).

Sous-lot du lot 8, livrable indépendamment. Hors périmètre : middleware rate-limit (8c),
observabilité `/metrics` (8d), chart Helm / CronJob (8e).

## 2. Décisions de design

| Sujet | Choix | Raison |
|---|---|---|
| Modèle d'exécution | **One-shot run-and-exit** (`runPurgeCycle()` puis `process.exit`) | Testable, idiomatique k8s (CronJob), pas de process long qui dérive. S'écarte du `setInterval` du §4 — évolution assumée. |
| Ordonnancement | Délégué au CronJob k8s (Lot 8e) | Le worker ne connaît pas la cadence. |
| Purges | 3 catégories du §7.4 uniquement | Retry Wikipedia (optionnel V1) hors périmètre. |
| Réconciliation orphelins | **Incluse dans 8b** | Demande explicite : le cron doit nettoyer les objets Garage non référencés. |
| Période de grâce orphelins | **24h** (`ORPHAN_GRACE_MS`, aligné sur `IDENTIFICATION_TEMP_TTL_MS`) | Aucun flux d'upload/création ne dure plus de quelques secondes ; 24h élimine tout risque de réaper un objet en cours d'écriture. |
| Rétentions | Constantes (`config/constants.ts`), pas d'env | Cohérent avec `IDENTIFICATION_TEMP_TTL_MS` existant. |
| Cutoffs temporels | Calculés **en SQL** (`now()`, `current_date`) | Évite la dérive d'horloge app/DB. |
| Sémantique Garage | DELETE DB d'abord, purge Garage best-effort ensuite | Identique au service `account-deletion` (Lot 8a). Orphelins tolérés et rattrapés par la réconciliation. |

## 3. Architecture (2 unités + lib)

```
src/cron.ts                 entrypoint one-shot
   └─> runPurgeCycle()      (src/services/purge.ts) — logique pure, testable, réutilisable
          ├─ purgeExpiredIdentifications()
          ├─ purgeOldSoftDeletedSpecimens()
          ├─ purgeOldPlantnetUsage()
          └─ reconcileOrphans()         ← après les 3 purges
                 └─ listObjects()       (src/lib/garage.ts) — nouvelle capacité ListObjectsV2 paginée
```

- **`src/services/purge.ts`** — toute la logique métier, testable sans process cron. Aucune
  dépendance à Hono. Réutilise `deleteObject` (existant) et `listObjects` (nouveau) de
  `lib/garage.ts`.
- **`src/cron.ts`** — entrypoint fin (non testé directement, comme `src/server.ts`) :
  appelle `runPurgeCycle()`, log le résumé, ferme la connexion DB, `process.exit`.
- **`src/lib/garage.ts`** — ajout de `listObjects`.
- **`src/config/constants.ts`** — ajout des constantes de rétention + grâce.
- **`package.json`** — ajout du script `"cron": "bun src/cron.ts"`.

## 4. `lib/garage.ts` — nouvelle capacité `listObjects`

```ts
export type GarageObject = { key: string; lastModified: Date };
export const listObjects = (input: { bucket: string; prefix?: string }) => Promise<GarageObject[]>
```

- Implémentée via `ListObjectsV2Command`, **paginée** : boucle sur `ContinuationToken` tant que
  `IsTruncated`, accumule toutes les clés (≤ 1000 par page).
- Mappe chaque `Contents[i]` vers `{ key: Contents[i].Key, lastModified: Contents[i].LastModified }`.
- Doit être intégrée au pattern d'injection de test existant (`Impl` + `__setGarageForTests`)
  pour être stubbable comme les autres opérations.

## 5. `services/purge.ts` — `runPurgeCycle` et sous-fonctions

Chaque sous-fonction renvoie des compteurs et **n'interrompt jamais** les autres : une erreur
DB est capturée, loggée en `error`, et le compteur d'erreurs est incrémenté.

### Type de retour

```ts
type CategoryResult = { rowsDeleted: number; garageDeleted: number; garageFailed: number; errored: boolean };
type ReconcileResult = { scanned: number; orphansDeleted: number; garageFailed: number; errored: boolean };
type PurgeCycleResult = {
  expiredIdentifications: CategoryResult;
  oldSoftDeletedSpecimens: CategoryResult;
  oldPlantnetUsage: CategoryResult;
  orphanReconciliation: ReconcileResult;
  hadError: boolean; // true si une catégorie quelconque a `errored`
};
```

### 5.1 `purgeExpiredIdentifications()`

```sql
DELETE FROM identifications
WHERE photo_status = 'temp' AND expires_at < now()
RETURNING photo_url;
```
→ pour chaque `photo_url` retournée : `deleteObject({ bucket: SPECIMENS_BUCKET, key: photo_url })`
best-effort (`Promise.allSettled`, warn par échec, `garageFailed++`).

### 5.2 `purgeOldSoftDeletedSpecimens()`

```sql
DELETE FROM specimens
WHERE deleted_at IS NOT NULL
  AND deleted_at < now() - (interval '1 day' * :SPECIMEN_SOFT_DELETE_RETENTION_DAYS)
RETURNING photo_url;
```
→ même purge Garage best-effort que 5.1 (bucket `specimens`).

### 5.3 `purgeOldPlantnetUsage()`

```sql
DELETE FROM plantnet_usage
WHERE day < (current_date - :PLANTNET_USAGE_RETENTION_DAYS);
```
→ pas d'objet Garage. `rowsDeleted` = nombre de lignes supprimées.

### 5.4 `reconcileOrphans()` — exécutée **après** 5.1–5.3

Pour chaque bucket (`specimens`, `avatars`) :

1. **Construire l'ensemble des clés référencées** depuis la DB :
   - `specimens` : `SELECT photo_url FROM specimens` (**toutes** lignes, y compris soft-deleted
     non encore purgées) `∪ SELECT photo_url FROM identifications`.
   - `avatars` : `SELECT avatar_url FROM users WHERE avatar_url IS NOT NULL`.
   - **Garde-fou** : si une de ces requêtes échoue, log `error`, `errored = true`, et **on ne
     supprime rien sur ce bucket** (jamais de delete sur un ensemble de référence incomplet).
2. `listObjects({ bucket })` ; si l'appel échoue → log `error`, `errored = true`, bucket ignoré.
3. Pour chaque objet listé : si `key ∉ référencées` **ET** `Date.now() - lastModified.getTime() > ORPHAN_GRACE_MS`
   → `deleteObject` best-effort (warn par échec, `garageFailed++`), sinon `orphansDeleted++`.
   `scanned` compte tous les objets listés.

Notes :
- La réconciliation tourne après les purges, donc les objets des lignes fraîchement supprimées
  sont déjà partis ; elle ne ramasse que les *vrais* orphelins (delete échoué d'une purge,
  d'une suppression de compte 8a, ou rename temp→promoted avorté).
- Les buckets sont scannés **sans préfixe** (un orphelin peut être sous n'importe quel
  `<user_id>/`).

### 5.5 `runPurgeCycle()`

Exécute 5.1 → 5.2 → 5.3 → 5.4 en séquence, agrège dans `PurgeCycleResult`, pose
`hadError = true` si une catégorie a `errored`, log une ligne `info` de résumé avec tous les
compteurs. Renvoie le résultat (ne fait **pas** de `process.exit` — c'est le rôle de `cron.ts`).

## 6. `src/cron.ts` — entrypoint

```
1. log info "cron: purge cycle starting"
2. result = await runPurgeCycle()
3. fermer la connexion DB (rawClient.end()) pour permettre une sortie propre
4. process.exit(result.hadError ? 1 : 0)
```

`exit(1)` quand une catégorie a levé une erreur DB / `listObjects` a échoué → le CronJob k8s
marque le run en échec et appliquera sa politique de retry. Les échecs `deleteObject`
individuels restent best-effort (warn) et **ne** déclenchent **pas** `exit(1)`.

## 7. Constantes ajoutées (`src/config/constants.ts`)

```ts
export const SPECIMEN_SOFT_DELETE_RETENTION_DAYS = 30;
export const PLANTNET_USAGE_RETENTION_DAYS = 7;
// Aligné sur IDENTIFICATION_TEMP_TTL_MS : un objet Garage non référencé plus vieux que ce
// délai est forcément un vrai orphelin (aucun flux d'upload ne dure aussi longtemps).
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
```

## 8. Observabilité

Logs structurés `pino` uniquement (le `logger` existant). Une ligne `info` par catégorie avec
ses compteurs + une ligne de résumé. Erreurs en `error`, échecs Garage individuels en `warn`.

Les **compteurs Prometheus** du cron (purge par catégorie, orphelins) sont **explicitement
reportés au lot 8d** (`/metrics`). 8b ne touche pas aux métriques.

## 9. Tests (intégration, Postgres + Garage réels)

`tests/integration/cron-purge.test.ts` (helpers DB + Garage existants ; Garage stubbable via
`__setGarageForTests`) :

**Purges**
1. **Identifications temp expirées** : seed une identification `temp` avec `expires_at` passé
   (+ objet Garage réel) → purgée (ligne absente, objet absent). Une identification `temp` avec
   `expires_at` futur et une `promoted` → **intactes** (lignes + objets présents).
2. **Specimens soft-deleted** : seed un specimen `deleted_at` = J-31 (+ objet) → purgé ; un
   `deleted_at` = J-5 et un actif (`deleted_at` NULL) → **intacts**.
3. **plantnet_usage** : seed une ligne `day` = J-10 → purgée ; `day` = aujourd'hui → **intacte**.

**Réconciliation orphelins**
4. objet ancien (LastModified > 24h, fabriqué/forcé) **non référencé** → supprimé.
5. objet **référencé** par un specimen / une identification / un avatar existant → **intact**
   même s'il est ancien.
6. objet **non référencé mais récent** (< 24h) → **intact** (grâce respectée).
7. **garde-fou** : si la construction de l'ensemble de référence échoue (simuler une erreur DB
   ou stub), aucun objet n'est supprimé sur ce bucket et `errored = true`.

**Cycle & résilience**
8. `runPurgeCycle()` renvoie les compteurs agrégés attendus ; `hadError = false` sur un run
   nominal.
9. **résilience Garage** : `deleteObject` stubbé qui throw → les lignes DB sont quand même
   supprimées, le cycle se termine, `garageFailed` est compté, `hadError` reste `false` (un
   échec Garage best-effort n'est pas une erreur de cycle).

Le simuler du seuil de grâce (test 6) suppose de pouvoir contrôler le `lastModified` renvoyé :
réalisable en stubbant `listObjects` via `__setGarageForTests` pour renvoyer des objets avec un
`lastModified` choisi, tout en laissant `deleteObject` réel — ou inversement. Le plan
d'implémentation précisera le montage exact.

`src/cron.ts` n'est pas testé directement (entry fin, comme `src/server.ts`).

## 10. Fichiers touchés

| Fichier | Nature |
|---|---|
| `src/lib/garage.ts` | **modif** — ajout `listObjects` (+ type `GarageObject`, intégration `Impl`/stub) |
| `src/services/purge.ts` | **nouveau** — `runPurgeCycle` + 4 sous-fonctions |
| `src/cron.ts` | **nouveau** — entrypoint one-shot |
| `src/config/constants.ts` | **modif** — 3 constantes |
| `package.json` | **modif** — script `cron` |
| `tests/integration/cron-purge.test.ts` | **nouveau** |
| `tests/unit/lib/garage.test.ts` | **modif** — couverture `listObjects` (pagination) si testable au niveau lib |
| `README.md` | **modif** — section cron + commande `bun run cron` + statut lot 8b |

Pas de migration Drizzle (aucun changement de schéma). Pas de nouvelle dépendance
(`@aws-sdk/client-s3` fournit déjà `ListObjectsV2Command`).

## 11. Hors scope 8b

- Retry Wikipedia best-effort (optionnel V1, §8.2).
- Métriques Prometheus `/metrics` du cron → Lot 8d.
- CronJob Kubernetes / chart Helm → Lot 8e.
- Batching / suppression par lots des objets Garage (`DeleteObjects`) — volume MVP faible,
  `deleteObject` unitaire suffit.
- Boucle `setInterval` longue durée — remplacée par le modèle one-shot + CronJob.
