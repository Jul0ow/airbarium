# Lot 8d — Observabilité (`/metrics` Prometheus + health probes) — Design

> Date : 2026-06-14
> Périmètre : lot 8d du backend MVP — instrumentation Prometheus et sondes de santé
> Statut : design validé, prêt pour le plan d'implémentation

---

## 1. Contexte

Le lot 8 est le lot de finition du MVP. 8a (réconciliation Garage), 8b (cron de purge), 8c (rate limiting Postgres) sont mergés. Le lot 8d livre la tranche **observabilité** du design backend §10 : un endpoint `/metrics` au format Prometheus et des sondes liveness/readiness à la Kubernetes.

État actuel :
- `/v1/health` existe mais ne sonde que Postgres (DB-only).
- `/metrics` n'existe pas, aucune instrumentation de métriques nulle part.
- Le critère « done » du MVP (§15) exige explicitement que le quota PlantNet (30/jour) soit observable dans `/metrics`.

Le câblage Kubernetes qui consomme ces surfaces (probes dans le `Deployment`, Pushgateway pour le `CronJob`) arrive au lot final 8e.

## 2. Décisions (brainstorming 2026-06-14)

| Sujet | Choix | Raison |
|---|---|---|
| Librairie métriques | **prom-client** | Pur JS (pas de binaire natif → OK NixOS), nommé dans le design §3 |
| Familles de métriques | Histogramme HTTP, compteur d'issue PlantNet, compteur d'ingestion sync offline, métriques Node/process par défaut, **+ groupe business** (`users_total`, `specimens_total`) | Couvre §10.2 + valeur dashboard ; `db_pool_active` **abandonné** (postgres.js n'expose pas proprement l'état du pool) |
| Sondes santé | `/v1/health` reste **liveness** (DB-only, inchangé) ; nouveau `/v1/health/ready` pour **readiness** (DB + Garage) | §10.3 : un blip Garage/PlantNet transitoire ne doit pas redémarrer le pod ; un Garage down doit le retirer de l'ingress |
| Métriques du cron | Poussées vers un **Pushgateway** Prometheus, conditionné à une variable optionnelle `PUSHGATEWAY_URL` | Le cron est un process court (CronJob) qui ne peut pas être scrapé ; gateway non requis en local/CI/tests quand la variable est absente |

## 3. Architecture

```
Requête → requestId → httpLogger → metrics() histogramme → secureHeaders → cors → handler
GET /metrics  (racine, public, HORS /v1) → rend le registre API
GET /v1/health        → liveness, DB seul (inchangé)
GET /v1/health/ready  → readiness, DB + Garage
cron.ts → runPurgeCycle() → (si PUSHGATEWAY_URL) pushPurgeMetrics() → Pushgateway
```

**Deux registres prom-client distincts** pour que le process cron court ne tire jamais les collecteurs HTTP/business de l'API :
- `src/lib/metrics.ts` — **registre API** : métriques par défaut, histogramme HTTP, compteur PlantNet, compteur sync, gauges business, helpers d'enregistrement.
- `src/lib/cron-metrics.ts` — **registre cron** + `pushPurgeMetrics()`.

Les helpers `recordPlantnet` / `recordSyncIngest` vivent dans `lib/metrics.ts` et sont importés par des modules du chemin API (`lib/plantnet.ts`, `services/quota.ts`, `services/specimens.ts`) — aucun n'est sur le chemin d'import du cron.

## 4. Inventaire des métriques (préfixe `airbarium_`, unité de base : seconde)

| Métrique | Type | Labels | Source |
|---|---|---|---|
| `airbarium_http_request_duration_seconds` | Histogram (buckets par défaut) | `method`, `route`, `status_code` | `middleware/metrics.ts` — son `_count` subsume le « compteur par status » du §10.2 |
| `airbarium_plantnet_requests_total` | Counter | `outcome` = `success`\|`no_match`\|`error`\|`quota_exceeded` | frontière d'appel + porte du quota |
| `airbarium_sync_ingest_total` | Counter | `result` = `identified`\|`unidentified` | branche offline de `services/specimens.ts` |
| `airbarium_users_total` | Gauge (`collect()` async) | — | `SELECT count(*) FROM users WHERE deleted_at IS NULL` |
| `airbarium_specimens_total` | Gauge (`collect()` async) | — | `SELECT count(*) FROM specimens WHERE deleted_at IS NULL` |
| métriques process/node par défaut | — | — | `collectDefaultMetrics({ register })` (une fois, au chargement du module) |

### 4.1 Placement des issues PlantNet (séparation de principe)

- `quota_exceeded` est une issue de **porte** (aucun appel émis) → enregistrée dans `services/quota.ts` `incrementOrThrow`, juste avant le throw `QUOTA_EXCEEDED`. C'est la métrique du critère §15 et elle est testable (le quota utilise la vraie DB, pas la lib mockée).
- `success` / `no_match` / `error` décrivent le **résultat de l'appel** → enregistrées dans `src/lib/plantnet.ts` `defaultImpl.identifyRaw` en enveloppant le corps : `try { … record(results.length ? 'success' : 'no_match'); return … } catch (err) { record('error'); throw err }`. Centralise les trois issues d'appel pour online + sync offline + retry en un seul endroit.

### 4.2 Métriques business — pourquoi des gauges au scrape

Prometheus modélise « totaux » et « aujourd'hui » différemment :
- **Totaux stables** (`users_total`, `specimens_total`) → gauges calculées **au moment du scrape** via un `collect()` exécutant un `SELECT count(*)` peu coûteux. Faible cardinalité, utiles en dashboard.
- **« Photos aujourd'hui »** → ne pas calculer une fenêtre journalière dans l'app. On s'appuie sur les **compteurs monotones** (ingestion sync, issues PlantNet) et on demande la fenêtre côté requête avec `increase(metric[1d])`. Une gauge qui se remet à zéro à minuit casse le modèle et survit mal aux redémarrages.

## 5. Sondes de santé

- `/v1/health` (liveness) : inchangé — `SELECT 1` sur Postgres uniquement, 200/503.
- `/v1/health/ready` (readiness) : sonde DB **et** Garage. Garage est sondé via un nouveau `pingGarage()` (`HeadBucket` sur le bucket `specimens`) ajouté à l'`Impl` de `lib/garage.ts` (donc mockable via `__setGarageForTests`). Réponse `{ status, db, garage }`, 200 si les deux OK sinon 503.

## 6. Métriques du cron via Pushgateway

`src/lib/cron-metrics.ts` possède son propre `Registry` et expose `pushPurgeMetrics(result: PurgeCycleResult)` :
- gauges `airbarium_purge_rows_deleted{category}`, `airbarium_purge_errored`, `airbarium_purge_last_run_timestamp_seconds`, renseignées depuis le résultat du cycle de purge ;
- `new Pushgateway(url, [], reg).pushAdd({ jobName: 'airbarium-cron' })` ;
- enveloppé dans un try/catch : un échec de push log un warn et ne fait **jamais** échouer le cron.

`src/cron.ts` n'appelle `pushPurgeMetrics` (avant `process.exit`) que si `PUSHGATEWAY_URL` est définie. Sinon, le cron continue à logger ses comptes de purge en JSON structuré (comportement du lot 8b), seule surface d'observabilité du batch en l'absence de gateway.

`PUSHGATEWAY_URL` est ajoutée à `config/env.ts` en `z.string().url().optional()`.

## 7. Tests

- **Unit** (`lib/metrics.ts`) : les helpers incrémentent les compteurs ; le rendu texte du registre contient chaque nom de métrique. Reset prom-client (`register.resetMetrics()`) entre les cas.
- **Integration** :
  - gauges business reflètent les lignes seedées ;
  - histogramme HTTP : deux requêtes vers `/v1/specimens/:id` (ids différents) produisent **une seule** série de labels (garde-fou cardinalité — `routePath` rend bien le motif, pas le chemin brut) ;
  - `/metrics` : 200 `text/plain`, contient l'histogramme et les gauges business ;
  - `quota_exceeded` apparaît dans `/metrics` après épuisement du quota 30/jour (critère §15) ;
  - sync ingest : POST offline → `identified` (match stub) / `unidentified` (no_match/error stub) ;
  - readiness : DB+Garage up → 200 ; `pingGarage` qui throw → 503 `garage:"down"` ; liveness toujours 200.
  - cron : `PUSHGATEWAY_URL` définie → `pushAdd` appelé (client mocké) avec les valeurs de catégorie ; absente → non appelé, exit 0.

## 8. Risques

- **Cardinalité de `c.req.routePath`** : le seul vrai piège. Le test de cardinalité doit prouver que le label est le **motif** de route. Si le middleware au niveau app voit `/*`, dériver depuis `c.req.matchedRoutes`.
- **Registre global prom-client** singleton de module : reset entre tests, ou assertion par delta.
- **`collectDefaultMetrics` une seule fois** (throw si ré-enregistré) — appel au chargement du module, jamais par requête.
- `/metrics` s'auto-compte dans l'histogramme (derrière `app.use('*')`) — acceptable et standard.

## 9. Hors scope

- Tracing distribué OpenTelemetry (V2, §10.4).
- `db_pool_active` (postgres.js n'expose pas le pool ; abandonné).
- Composant Pushgateway en local/CI (uniquement câblé en cluster via `PUSHGATEWAY_URL`).
- Manifests Helm / `CronJob` / config des probes côté cluster → lot 8e.
