# Lot 8e — Chart Helm + CronJob Kubernetes + Dockerfile

> Date : 2026-06-14
> Périmètre : dernier lot du MVP backend Airbarium. Packaging de déploiement.
> Dépend de : lots 1–8d (tous livrés et mergés dans `main`)
> Statut : design validé, prêt pour plan d'implémentation

---

## 1. Objectif

Rendre le backend Airbarium **déployable de bout en bout** sur un cluster Kubernetes :

1. Une **image Docker** unique servant l'API (`bun run start`) et le worker de purge (`bun run cron`).
2. Un **chart Helm minimal** (`deploy/helm/airbarium-api/`) déployant l'API, le CronJob de purge, les migrations DB, et l'exposition HTTP.

À la fin du lot, le critère « done » du MVP « le chart Helm déploie une instance fonctionnelle sur le cluster cible » (design global §15) est satisfait.

### Décisions tranchées (brainstorming 2026-06-14)

| Sujet | Choix | Raison |
|---|---|---|
| Ambition du chart | **Minimal déployable** (Dockerfile inclus) | Roadmap §14 « chart Helm minimal » ; pas de HPA/PDB/NetworkPolicy en MVP |
| Structure | **Chart unique** API + CronJob | Même image, même config env ; design §13 nomme `deploy/helm/airbarium-api/` |
| Modèle du cron | **CronJob Kubernetes** | `src/cron.ts` est one-shot (`process.exit`) → un Deployment crashlooperait. Déjà acté dans le README (lot 8b) |
| Exposition HTTP | **Gateway API `HTTPRoute`** (togglable) | Choix opérationnel laissé ouvert au design §12.2 ; standard montant |
| Migrations DB | **Job Helm en hook** `pre-install`/`pre-upgrade` | Garantit le schéma avant le démarrage des pods API (point non couvert par le design global) |
| Dépendances (Postgres, Garage, Gateway) | **Hors chart, documentées comme prérequis** | CloudNativePG / chart Garage officiel ne sont pas in-cluster en MVP (design §12.2) |

---

## 2. Image Docker

### 2.1 Dockerfile (racine du repo, multi-stage Bun)

- **Base** : `oven/bun:<pin>-alpine`, où `<pin>` est aligné sur la version `bun` du devShell Nix (vérifier `bun --version` dans `nix develop` au moment de l'implémentation ; figer une version mineure, pas `latest`).
- **Stage `deps`** : copie `package.json` + `bun.lock`, exécute `bun install --frozen-lockfile`.
  - On installe **toutes** les dépendances (pas de pruning `--production`) : le Job de migration exécute `bun run db:migrate` (`drizzle-kit`), qui est une devDependency.
- **Stage runtime** :
  - Copie depuis `deps` : `node_modules/`.
  - Copie du repo : `src/`, `drizzle.config.ts`, `package.json`, `tsconfig.json`. (`src/db/migrations/` est inclus dans `src/`.)
  - User non-root : l'image `oven/bun` fournit l'utilisateur `bun` ; `USER bun`.
  - `ENV NODE_ENV=production` (surchargeable par le ConfigMap).
  - `EXPOSE 3000` (informatif ; le port réel vient de `PORT`).
  - `CMD ["bun", "run", "start"]` (= `bun src/server.ts`).
- Le **CronJob** et le **Job de migration** surchargent `command`/`args` (`bun run cron`, `bun run db:migrate`) — même image, aucun rebuild spécifique.

### 2.2 `.dockerignore`

Exclut : `node_modules`, `.git`, `.github`, `tests`, `docs`, `.claude`, `compose`, `deploy`, `*.md`, `.env*`, `.direnv`, `result`.

### 2.3 Lint

`hadolint Dockerfile` doit passer sans warning (hors règles explicitement ignorées et justifiées par un commentaire `# hadolint ignore=...`).

---

## 3. Chart Helm

### 3.1 Layout

```
deploy/helm/airbarium-api/
├── Chart.yaml
├── values.yaml
├── .helmignore
├── ci/
│   └── values-ci.yaml          # valeurs factices complètes pour helm template/lint en CI
└── templates/
    ├── _helpers.tpl
    ├── configmap.yaml
    ├── secret.yaml
    ├── serviceaccount.yaml
    ├── deployment-api.yaml
    ├── service.yaml
    ├── cronjob.yaml
    ├── job-migrate.yaml
    ├── httproute.yaml
    └── NOTES.txt
```

### 3.2 `Chart.yaml`

- `apiVersion: v2`, `type: application`
- `name: airbarium-api`
- `version` : version du **chart** (SemVer, démarre à `0.1.0`)
- `appVersion` : version de l'**application** (= tag d'image par défaut)
- `description`, `kubeVersion: ">=1.29.0-0"` (Gateway API `v1` stable depuis 1.29)

### 3.3 Templates

**`_helpers.tpl`** — helpers standard : `airbarium-api.name`, `.fullname`, `.chart`, `.labels`, `.selectorLabels`, `.serviceAccountName`, et un helper `.image` (`{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}`).

**`configmap.yaml`** — variables d'env **non sensibles**. Clés émises :
`NODE_ENV`, `PORT`, `LOG_LEVEL`, `BETTER_AUTH_URL`, `APP_URL`, `MAIL_FROM`, `GARAGE_ENDPOINT`, `GARAGE_REGION`, `WIKIPEDIA_USER_AGENT`.
- `PUSHGATEWAY_URL` n'est émise **que si non vide** (voir §3.4, point critique).

**`secret.yaml`** — variables d'env **sensibles**, type `Opaque`, via `stringData`. Clés :
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `GARAGE_ACCESS_KEY`, `GARAGE_SECRET_KEY`, `PLANTNET_API_KEY`, `SMTP_URL`.
- Rendu **uniquement si** `secret.create == true`. Si `secret.existingSecret` est fourni, aucun Secret n'est créé et les workloads référencent ce Secret existant (compat sealed-secrets / external-secrets, design §9.5).

**`serviceaccount.yaml`** — rendu si `serviceAccount.create == true`. Utilisé par le Deployment, le CronJob et le Job de migration.

**`deployment-api.yaml`** :
- `replicas: {{ .Values.api.replicaCount }}` (def 2)
- `image` via helper, `imagePullPolicy`, `imagePullSecrets`
- `containerPort` = `.Values.config.PORT`
- `envFrom` : `configMapRef` + `secretRef` (le Secret créé ou `existingSecret`)
- **livenessProbe** : `GET /v1/health` (DB uniquement — un PlantNet/Garage transitoire ne doit pas redémarrer le pod, design §10.3)
- **readinessProbe** : `GET /v1/health/ready` (DB + Garage)
- `resources` requests/limits depuis values
- `securityContext` : `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem` configurable (def true ; un `emptyDir` `/tmp` est monté si besoin)
- `podAnnotations`, `nodeSelector`, `tolerations`, `affinity` configurables (passthrough)

**`service.yaml`** : `ClusterIP`, `port: {{ .Values.service.port }}` (def 80) → `targetPort` = PORT.

**`cronjob.yaml`** :
- `schedule: {{ .Values.cron.schedule | quote }}` (def `"0 * * * *"`, horaire)
- `concurrencyPolicy: Forbid`
- `startingDeadlineSeconds`, `successfulJobsHistoryLimit` (def 3), `failedJobsHistoryLimit` (def 3)
- `jobTemplate` : même image, `command: ["bun","run","cron"]`, `restartPolicy: OnFailure`, même `envFrom`, mêmes `resources`/`securityContext`/ServiceAccount
- Le cron `exit 1` en cas d'échec DB → le Job retente selon `backoffLimit`/`restartPolicy` (comportement déjà documenté lot 8b)

**`job-migrate.yaml`** — rendu si `migrations.enabled` (def true) :
- annotations :
  - `helm.sh/hook: pre-install,pre-upgrade`
  - `helm.sh/hook-weight: "-5"`
  - `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`
- `command: ["bun","run","db:migrate"]`
- `restartPolicy: Never`, `backoffLimit: {{ .Values.migrations.backoffLimit }}` (def 3)
- même `envFrom` (a besoin de `DATABASE_URL` + `BETTER_AUTH_SECRET` car `drizzle.config.ts` importe l'env Zod-validé)

**`httproute.yaml`** — rendu si `httpRoute.enabled` (def false) :
- `apiVersion: gateway.networking.k8s.io/v1`, `kind: HTTPRoute`
- `parentRefs` (def `[]` — name/namespace/sectionName de la Gateway), `hostnames` (def `[]`)
- une règle `backendRefs` → le Service, port `service.port`
- `helm template` rend ce manifeste sans CRD installée ; l'`apply` réel suppose les CRD Gateway API + une `Gateway` provisionnée

**`NOTES.txt`** — post-install : rappel de fournir les secrets, comment vérifier le rollout, où est exposée l'API selon `httpRoute.enabled`.

### 3.4 `values.yaml` (structure)

```yaml
image:
  repository: ghcr.io/jul0ow/airbarium-api   # à confirmer par l'utilisateur
  tag: ""                                     # def = .Chart.AppVersion
  pullPolicy: IfNotPresent
imagePullSecrets: []

api:
  replicaCount: 2
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: 500m, memory: 256Mi }
  podAnnotations: {}
  nodeSelector: {}
  tolerations: []
  affinity: {}

cron:
  schedule: "0 * * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 120
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  backoffLimit: 1
  resources:
    requests: { cpu: 50m, memory: 128Mi }
    limits:   { cpu: 250m, memory: 256Mi }

migrations:
  enabled: true
  backoffLimit: 3

service:
  type: ClusterIP
  port: 80

httpRoute:
  enabled: false
  parentRefs: []      # [{ name, namespace, sectionName }]
  hostnames: []

serviceAccount:
  create: true
  name: ""
  annotations: {}

podSecurityContext:
  runAsNonRoot: true
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }

# Variables d'env NON sensibles -> ConfigMap
config:
  NODE_ENV: "production"
  PORT: "3000"
  LOG_LEVEL: "info"
  BETTER_AUTH_URL: ""
  APP_URL: ""
  MAIL_FROM: "Airbarium <noreply@airbarium.app>"
  GARAGE_ENDPOINT: ""
  GARAGE_REGION: "garage"
  WIKIPEDIA_USER_AGENT: "Airbarium/1.0 (contact@airbarium.app)"
  PUSHGATEWAY_URL: ""   # optionnel : omis du ConfigMap si vide

# Variables d'env SENSIBLES -> Secret (NE JAMAIS committer de vraies valeurs)
secret:
  create: true
  existingSecret: ""    # si défini, on référence ce Secret au lieu d'en créer un
  data:
    DATABASE_URL: ""
    BETTER_AUTH_SECRET: ""
    GARAGE_ACCESS_KEY: ""
    GARAGE_SECRET_KEY: ""
    PLANTNET_API_KEY: ""
    SMTP_URL: ""
```

### 3.5 Point critique — `PUSHGATEWAY_URL` optionnel

`src/config/env.ts` valide `PUSHGATEWAY_URL` en `z.string().url().optional()`. Une **chaîne vide** (`""`) n'est ni `undefined` ni une URL valide → la validation Zod **échoue au démarrage** (`process.exit(1)`) pour l'API, le CronJob *et* le Job de migration.

⇒ Le template `configmap.yaml` doit **omettre entièrement la clé** `PUSHGATEWAY_URL` quand `.Values.config.PUSHGATEWAY_URL` est vide. Jamais émettre `PUSHGATEWAY_URL: ""`.

La même prudence s'applique à toute future variable d'env optionnelle ajoutée au schéma.

---

## 4. Prérequis de déploiement (documentés, hors chart)

Le README documentera que le chart suppose, sur le cluster cible :

- **PostgreSQL 17** — via l'opérateur CloudNativePG (`Cluster` CR). `DATABASE_URL` pointe vers le Service du cluster CNPG. (Design §12.2.)
- **Garage** (S3) — via le chart Helm officiel Deuxfleurs. `GARAGE_ENDPOINT`/`GARAGE_*` câblés vers son Service. (Design §12.2.)
- **Gateway API** — CRD installées + une `Gateway` provisionnée si `httpRoute.enabled=true`.
- **Prometheus Pushgateway** — optionnel ; `PUSHGATEWAY_URL` câblé si la collecte des métriques de purge du cron est souhaitée (lot 8d).
- **SMTP provider** — `SMTP_URL`/`MAIL_FROM` vers Brevo/Postmark/etc. (pas de MailHog en prod).

---

## 5. Outillage & vérification

Pas de tests `bun` pour des manifestes YAML. La vérification du lot repose sur du lint/rendu statique.

### 5.1 Ajouts au devShell Nix (`flake.nix`)

Ajouter au `buildInputs` du devShell : `kubernetes-helm`, `kubeconform`, `hadolint`. (Pas de `nix profile` — outils fournis par le flake, cf. conventions projet.)

### 5.2 Commandes de vérification

```bash
hadolint Dockerfile
helm lint deploy/helm/airbarium-api
helm template airbarium deploy/helm/airbarium-api -f deploy/helm/airbarium-api/ci/values-ci.yaml \
  | kubeconform -strict -summary -ignore-missing-schemas
```

- `values-ci.yaml` fournit des valeurs factices **complètes et valides** (URLs réelles, secret `create: true`, `httpRoute.enabled: true`) pour exercer tous les templates.
- `-ignore-missing-schemas` couvre l'`HTTPRoute` (CRD hors schémas standard kubeconform).

### 5.3 CI (`.github/workflows/ci.yaml`)

Ajouter un job `helm` (indépendant du job de tests) :
- installe `helm`, `kubeconform`, `hadolint` (via actions dédiées ou `nix develop`),
- exécute les trois commandes de §5.2.

Le build/push de l'image Docker vers un registre est **hors périmètre de ce lot** (pas de pipeline de release en MVP) ; le Dockerfile et le `hadolint` suffisent au critère « déployable ».

---

## 6. Documentation (`README.md`)

Conformément à la règle projet (« pas de PR de lot mergée sans passage README ») :

- Section **Déploiement** : build de l'image (`docker build -t ...`), `helm install`/`upgrade` avec un fichier de secrets, toggles principaux (`httpRoute.enabled`, `secret.existingSecret`, `cron.schedule`).
- **Prérequis cluster** (§4) : CloudNativePG, Garage, Gateway API, Pushgateway optionnel.
- Mise à jour du **statut roadmap** : lot 8e livré → **MVP backend complet** (lots 1–8 terminés). Mettre à jour la ligne de statut dans `CLAUDE.md` (`## 8-lot roadmap`) en cohérence.

---

## 7. Périmètre exclu (rappel)

Hors de ce lot, conformément à « chart minimal » :

- HorizontalPodAutoscaler, PodDisruptionBudget, NetworkPolicy
- ServiceMonitor / PrometheusRule (Prometheus Operator)
- Charts in-cluster pour Postgres / Garage (référencés comme prérequis)
- Pipeline CI de build/push d'image et de release du chart
- Overlays staging/prod séparés (un seul `values.yaml` + surcharges par `-f`)

---

## 8. Critères de « done » du lot 8e

- [ ] `Dockerfile` multi-stage construit une image qui démarre l'API et exécute le cron (vérifié localement : `docker run ... bun run start` répond sur `/v1/health`).
- [ ] `hadolint Dockerfile` passe.
- [ ] `helm lint` passe et `helm template -f ci/values-ci.yaml | kubeconform` valide tous les manifestes.
- [ ] Le template `configmap.yaml` n'émet jamais `PUSHGATEWAY_URL=""` (vérifié par `helm template` avec la valeur vide).
- [ ] Le Job de migration porte les hooks `pre-install,pre-upgrade` et le CronJob l'`command` `bun run cron`.
- [ ] `flake.nix` fournit `helm`, `kubeconform`, `hadolint`.
- [ ] Job CI `helm` ajouté et vert.
- [ ] README + CLAUDE.md mis à jour (déploiement, prérequis, statut roadmap MVP complet).
