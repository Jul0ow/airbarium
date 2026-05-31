# Airbarium — Lot 3 design : Auth, mailer, /me

> Date : 2026-05-31
> Périmètre : Lot 3 du roadmap backend MVP (cf. `2026-05-26-airbarium-backend-mvp-design.md` §14)
> Statut : design validé, prêt pour plan d'implémentation

---

## 1. Vue d'ensemble

Lot 3 pose la couche authentification du MVP. À sa sortie, l'API accepte des sign-up / sign-in / sign-out, génère et vérifie des emails de confirmation et de reset, expose `GET /v1/me` + `PATCH /v1/me`, et protège toute route non publique via un middleware unique.

Ce design complète la spec backend MVP (`2026-05-26-airbarium-backend-mvp-design.md`) en figeant les choix laissés ouverts pour ce lot : politique de vérification email, stratégie de rate-limit auth, mapping entre Better Auth et notre table `users` issue du Lot 2.

---

## 2. Décisions tranchées

| Sujet | Choix | Source |
|---|---|---|
| Vérification email obligatoire pour utiliser l'API ? | **Non** — verification email envoyé au sign-up, mais sign-in et accès aux routes protégées autorisés sans clic. Le clic flippe `users.email_verified = true`. | Lot 3 brainstorm |
| Rate limit sur `/v1/auth/*` | **Better Auth built-in rate limiter (storage = memory)** activé dès Lot 3 avec les seuils de spec §9.3 (sign-in 10/15 min, sign-up 3/h). Lot 8 swap vers un `secondaryStorage` adossé à `rate_limit`. | Lot 3 brainstorm |
| Mapping `users.avatar_url` ↔ Better Auth `image` | **Pas de champ `image`** côté Better Auth. `avatarUrl` reste géré directement par Drizzle (Lot 4 wire le PUT). `avatarUrl` et `deletedAt` enregistrés en `additionalFields` pour le typage. | §4.2 ci-dessous |
| Password hasher | **`Bun.password` (Argon2id)** override du scrypt par défaut de Better Auth. | Spec MVP §9.1 |
| Support Bearer pour mobile | **`bearer()` plugin Better Auth activé dès Lot 3** (cookie + Bearer en parallèle). | Spec MVP §9.1 |
| Templates emails | **Inline TS** (`src/lib/emails/*.ts`), un fichier par template. | Spec MVP §8.4 |
| `DELETE /v1/me` (RGPD) | **Hors Lot 3** — pris en Lot 8 (couplage avec cron de purge Garage). | Roadmap |
| `PUT/DELETE /v1/me/avatar` | **Hors Lot 3** — Lot 4 (besoin du client Garage). | Roadmap |
| 2FA / OAuth Google-Apple | **Hors MVP** — V2. | Spec MVP §16 |

---

## 3. Stack ajoutée

| Dépendance | Pourquoi | Notes |
|---|---|---|
| `better-auth` | Cœur du lot | Adapter Drizzle officiel + plugin `bearer` |
| `@better-auth/cli` (dev) | Génère les schémas Drizzle de `account`, `session`, `verification` | One-shot ; les fichiers générés sont commités, pas regénérés au runtime |
| `nodemailer` | Mailer SMTP, compatible Bun | Transporter singleton, idempotent |

Aucune autre dépendance runtime n'est introduite. Le projet reste sur Hono / Drizzle / postgres-js / zod déjà en place.

---

## 4. Modèle de données

### 4.1 Tables ajoutées (migration `0001_*.sql`)

Trois tables Better Auth, schémas générés via `@better-auth/cli generate` puis commités sous `src/db/schema/` (snake_case forcé par `casing: 'snake_case'`).

#### `account`

| Colonne | Type | Notes |
|---|---|---|
| id | text PK | identifiant interne BA (cuid-like) |
| user_id | uuid FK users ON DELETE CASCADE | |
| provider_id | text NOT NULL | `'credential'` pour email/password |
| account_id | text NOT NULL | l'email pour le provider `credential` |
| password | text | hash Argon2id (NULL pour les providers OAuth en V2) |
| created_at, updated_at | timestamptz NOT NULL | |

Index : `(user_id)` + `(provider_id, account_id)` unique (un email = un compte credential).

#### `session`

| Colonne | Type | Notes |
|---|---|---|
| id | text PK | |
| user_id | uuid FK users ON DELETE CASCADE | |
| token | text UNIQUE NOT NULL | utilisé pour `Authorization: Bearer <token>` côté mobile |
| expires_at | timestamptz NOT NULL | now() + 30 j |
| ip_address | text | nullable |
| user_agent | text | nullable |
| created_at, updated_at | timestamptz NOT NULL | |

Index : `(user_id)` + `(token)` unique.

#### `verification`

| Colonne | Type | Notes |
|---|---|---|
| id | text PK | |
| identifier | text NOT NULL | email pour verify-email, user_id pour reset-password |
| value | text NOT NULL | token signé |
| expires_at | timestamptz NOT NULL | 24 h pour verify, 1 h pour reset |
| created_at, updated_at | timestamptz NOT NULL | |

Index : `(identifier)`.

**FK cascade :** `account.user_id` et `session.user_id` cascade vers `users` ⇒ Lot 8 `DELETE /v1/me` purge la session active et le hash sans logique supplémentaire.

### 4.2 Mapping Better Auth ↔ `users`

La table `users` du Lot 2 n'est **pas** modifiée. Better Auth est configuré pour :
- Utiliser la table nommée `users` (par défaut il attend `user`) via `user.modelName = 'users'`
- **Ne pas** déclarer de champ `image` (Better Auth ne gère pas l'avatar — Lot 4 écrit `avatarUrl` directement via Drizzle)
- Enregistrer `avatarUrl` et `deletedAt` comme `additionalFields` (typés en lecture, jamais en écriture)

Conséquence : aucune migration n'est nécessaire sur `users` ; Better Auth lit/écrit `id`, `email`, `email_verified`, `name`, `created_at`, `updated_at` ; le reste lui est transparent.

### 4.3 `tests/helpers/db.ts` — `truncateAll`

Ordre `TRUNCATE` mis à jour (enfants → parents) :

```
verification, session, account,
rate_limit, plantnet_usage, specimens, identifications, species, users
```

`RESTART IDENTITY CASCADE` couvre déjà la cascade, mais on liste explicitement pour rester lisible.

---

## 5. API REST

### 5.1 Routes auth — `/v1/auth/*`

Toutes montées via le handler Better Auth :

```
POST   /v1/auth/sign-up                  { email, password, name } → 201 { user, session }
POST   /v1/auth/sign-in                  { email, password }       → 200 { user, session }
POST   /v1/auth/sign-out                                            → 200 {}
GET    /v1/auth/session                                              → 200 { user, session } | 401
POST   /v1/auth/send-verification-email  { email }                  → 200 {}
GET    /v1/auth/verify-email?token=…                                → 302 / 200
POST   /v1/auth/forget-password          { email }                  → 200 {}
POST   /v1/auth/reset-password           { token, newPassword }     → 200 {}
```

Format de réponse et codes d'erreur conformes à Better Auth (divergence acceptée vis-à-vis de l'enveloppe `{ error: { code, message } }` de §6.1 — documentée dans CLAUDE.md). Le SDK client (web V2 ou mobile direct fetch) consomme directement la shape Better Auth.

### 5.2 Routes profil — `/v1/me`

```
GET    /v1/me   → 200 { id, email, email_verified, name, avatar_url, created_at }
                  → 401 si non authentifié
PATCH  /v1/me   { name?: string (1..100, trimmed) }
                  → 200 { id, email, email_verified, name, avatar_url, created_at }
                  → 400 si name invalide
                  → 401 si non authentifié
```

**Validation `PATCH /v1/me` :**
- `name` : `z.string().trim().min(1).max(100)`
- Tout autre champ : ignoré (pas de `.strict()` pour laisser évoluer le mobile sans casser le backend)
- `updated_at` bumpé par le service via `.set({ updatedAt: new Date() })`
- `email` : non modifiable en MVP (V2 : flow de re-vérification)
- `avatar_url` : non modifiable ici (Lot 4 expose `PUT /v1/me/avatar`)

### 5.3 `/v1/health` & route 404

Inchangés en Lot 3. La sonde Garage arrive en Lot 4, PlantNet en Lot 5.

---

## 6. Sécurité, sessions, rate limiting

### 6.1 Sessions

- Durée : **30 jours** (`session.expiresIn = 60 * 60 * 24 * 30`)
- Rolling refresh : `updateAge = 60 * 60 * 24` — le `expires_at` est repoussé au plus une fois par jour pour éviter l'amplification d'écritures.
- Cookie : `httpOnly`, `sameSite='lax'`, `secure=NODE_ENV==='production'`, `path='/'`
- Bearer : header `Authorization: Bearer <session.token>` lu par le plugin `bearer()`. Le token Bearer est renvoyé dans `body.session.token` à la réponse de sign-in/sign-up ; il référence la même row `session` que le cookie ⇒ pas de stockage parallèle, sign-out invalide les deux.

### 6.2 Password hashing

Override de Better Auth :

```ts
emailAndPassword: {
  enabled: true,
  password: {
    hash: (pw) => Bun.password.hash(pw, { algorithm: 'argon2id' }),
    verify: ({ hash, password }) => Bun.password.verify(password, hash),
  },
}
```

Pas de tuning des paramètres Argon2 en Lot 3 — les défauts de `Bun.password` (memoryCost ~64 MiB, timeCost 2) sont OK pour le MVP.

### 6.3 Rate limiting

Built-in Better Auth en `storage: 'memory'`, configuré au plus près de spec §9.3 :

```ts
rateLimit: {
  enabled: true,
  window: 60,             // base window 60s
  max: 100,               // default 100/min/IP
  customRules: {
    '/sign-in': { window: 60 * 15, max: 10 },  // 10 / 15 min
    '/sign-up': { window: 60 * 60, max: 3 },   // 3 / heure
  },
}
```

Le storage memory est volontaire en Lot 3 : un seul réplica en dev, deux en prod (le risque résiduel est qu'un attaquant exploite le round-robin pour doubler son quota — acceptable jusqu'au Lot 8 où l'on bascule sur la table `rate_limit`).

### 6.4 CORS & trusted origins

Better Auth a sa propre liste `trustedOrigins`. On la fait correspondre à la liste CORS Hono :

```
['http://localhost:8081', 'http://localhost:19006', 'https://app.airbarium.app']
```

Mismatch ⇒ Better Auth refuse l'origin avant même que la requête atteigne notre handler — bon comportement, mais à garder synchronisé. Test d'intégration sign-in vérifie le `Set-Cookie` depuis `localhost:8081`.

### 6.5 Headers sécurité

Inchangés (déjà posés en Lot 1 via `secureHeaders`).

---

## 7. Architecture & arborescence

### 7.1 Fichiers ajoutés

```
src/
├── auth/
│   └── better-auth.ts            # source unique de vérité — exporte `auth`
├── lib/
│   ├── mailer.ts                 # transporter singleton + sendMail()
│   └── emails/
│       ├── verify-email.ts       # { subject, html, text } pour verification
│       └── reset-password.ts     # idem pour reset
├── middleware/
│   └── auth.ts                   # authMiddleware() → 401 si pas de session
├── routes/
│   └── me.ts                     # GET + PATCH /v1/me
├── services/
│   └── profile.ts                # getMe(userId), updateMe(userId, { name })
├── schemas/
│   └── me.ts                     # PatchMeSchema = z.object({ name: …? })
├── db/
│   └── schema/
│       ├── account.ts            # généré par @better-auth/cli, snake_case
│       ├── session.ts            # idem
│       └── verification.ts       # idem
└── utils/
    └── auth-secret.ts            # script bun pour `auth:secret`

tests/
├── helpers/
│   ├── mailer.ts                 # installMockMailer() — spy + queue
│   └── auth.ts                   # signUpTestUser(), authedFetch()
├── unit/
│   ├── lib/
│   │   ├── mailer.test.ts
│   │   └── emails.test.ts
│   └── services/
│       └── profile.test.ts
└── integration/
    ├── auth/
    │   ├── sign-up.test.ts
    │   ├── sign-in.test.ts
    │   ├── verify-email.test.ts
    │   └── reset-password.test.ts
    └── me.test.ts
```

### 7.2 Fichiers modifiés

| Path | Changement |
|---|---|
| `src/app.ts` | Monte `auth.handler` sur `/v1/auth/*` avant `app.route('/v1', routes)`; étend `AppEnv` avec `Variables: { user, session }` |
| `src/routes/index.ts` | Ajoute `routes.route('/', me)` |
| `src/config/env.ts` | Ajoute `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SMTP_URL`, `MAIL_FROM`, `APP_URL` au schéma Zod |
| `src/db/schema/index.ts` | Re-export des 3 nouvelles tables BA |
| `src/app-env.ts` | `Variables` augmenté de `user: User`, `session: Session` |
| `tests/helpers/db.ts` | `truncateAll` étendu aux 3 tables BA |
| `.env.example` | Promotion des 5 vars Lot 3 hors du bloc commenté |
| `package.json` | Nouvelle dépendance + 2 scripts : `auth:secret`, BA CLI à la demande |
| `CLAUDE.md` | Note sur la shape d'erreur BA divergente de l'enveloppe maison |
| `README.md` | Bloc "Quickstart Lot 3" (env, MailHog) |

### 7.3 Principes de découpage rappelés (cf. CLAUDE.md)

- **Routes minces** : `routes/me.ts` parse Zod → délègue à `services/profile.ts` → format snake_case
- **Service réutilisable** : `services/profile.ts` testable sans Hono
- **Lib boundary** : `lib/mailer.ts` mocké au boundary dans les tests d'intégration auth
- **Schemas Zod partagés** : `schemas/me.ts` réutilisable côté tests

---

## 8. Flux clés

### 8.1 Sign-up + verification

```
mobile  POST /v1/auth/sign-up { email, password, name }
api     1. Better Auth : valide payload, vérifie unicité email
        2. Bun.password.hash → account.password
        3. INSERT users + account (transaction Drizzle)
        4. Création session (cookie + token Bearer dans response)
        5. emailVerification.sendOnSignUp = true ⇒ callback déclenché
            → mailer.sendMail({ subject, html avec ${url} fourni par BA, text })
            → l'URL pointe vers `${APP_URL}/v1/auth/verify-email?token=…`
        6. Réponse 201 { user, session }
mobile  Stocke session.token, ouvre l'app (user.email_verified = false n'empêche rien)

…plus tard, sur le device de l'user (deep link mobile ou web) :
        GET /v1/auth/verify-email?token=…
api     1. Better Auth lookup `verification` (identifier=email, value=token)
        2. UPDATE users SET email_verified = true WHERE id = ...
        3. DELETE verification row
        4. Redirige vers APP_URL ou 200 selon la config (par défaut 302 + Location)
```

**En cas de mailer KO** : la sign-up reste réussie (200/201), le mailer log un `error`. L'user peut redéclencher via `POST /v1/auth/send-verification-email` plus tard.

### 8.2 Sign-in (cookie + Bearer)

```
mobile  POST /v1/auth/sign-in { email, password }
api     1. Lookup account WHERE account_id=email AND provider_id='credential'
        2. Bun.password.verify(password, account.password) → bool
        3. Si OK : INSERT session, retourne { user, session } + Set-Cookie
mobile  Stocke session.token côté Keychain/SecureStore
        Appels ultérieurs : Authorization: Bearer <session.token>
```

**Rate limit** : 10 tentatives / 15 min / IP — la 11e renvoie 429 directement par BA.

### 8.3 Forget password / reset

```
POST /v1/auth/forget-password { email }
  → BA crée une row verification (TTL 1h)
  → callback sendResetPassword({ user, url, token }) → mailer
  → mailer envoie un email pointant vers `${APP_URL}/reset-password?token=…`
  → réponse 200 {} (toujours, qu'on connaisse l'email ou non — anti-énumération)

POST /v1/auth/reset-password { token, newPassword }
  → BA lookup verification, hash nouveau password, UPDATE account
  → DELETE verification row
  → INVALIDATE sessions existantes de l'user (config BA : revokeSessionsOnPasswordReset = true)
  → réponse 200 {}
```

### 8.4 GET /v1/me

```
GET /v1/me  Cookie OU Authorization: Bearer <token>
  → authMiddleware résout la session via auth.api.getSession({ headers })
  → si pas de session : 401 { error: { code: 'UNAUTHORIZED', message: '…' } }
  → si OK : c.var.user posé
  → handler getMe(c.var.user.id) → service Drizzle SELECT
  → réponse snake_case :
    {
      id, email, email_verified, name,
      avatar_url,            // NULL jusqu'au Lot 4
      created_at             // ISO 8601 UTC
    }
```

### 8.5 PATCH /v1/me

```
PATCH /v1/me  { "name": "  Alice  " }
  → authMiddleware → c.var.user
  → zValidator('json', PatchMeSchema) : name = "Alice" (trim)
  → updateMe(userId, { name: 'Alice' })
    → UPDATE users SET name = 'Alice', updated_at = now() WHERE id = userId
    → SELECT … RETURNING
  → réponse 200 même shape que GET
  
PATCH /v1/me  { "name": "   " }
  → 400 { error: { code: 'VALIDATION_ERROR', message: 'name must be 1..100 chars' } }
```

---

## 9. Tests

### 9.1 Découpe

| Couche | Fichier | Mailer | DB |
|---|---|---|---|
| Unit | `tests/unit/lib/mailer.test.ts` | mock `nodemailer.createTransport` | — |
| Unit | `tests/unit/lib/emails.test.ts` | — | — |
| Unit | `tests/unit/services/profile.test.ts` | — | stub Drizzle (léger) |
| Integration | `tests/integration/auth/sign-up.test.ts` | spy via `installMockMailer()` | réelle |
| Integration | `tests/integration/auth/sign-in.test.ts` | spy | réelle |
| Integration | `tests/integration/auth/verify-email.test.ts` | spy (capture token depuis args) | réelle |
| Integration | `tests/integration/auth/reset-password.test.ts` | spy | réelle |
| Integration | `tests/integration/me.test.ts` | — | réelle |

### 9.2 Helper `installMockMailer`

`tests/helpers/mailer.ts` expose :

```ts
export function installMockMailer(): { sent: SentMail[]; restore: () => void };
```

Patch `sendMail` du module `lib/mailer` pour pousser dans `sent[]`. Tests font `beforeEach(() => mocks = installMockMailer())` puis `afterEach(() => mocks.restore())`. La pile est inspectée par les tests verify/reset pour récupérer le `token` que Better Auth a fourni à la callback.

### 9.3 Helper `auth.ts`

```ts
export async function signUpTestUser(app, { email, password, name }): Promise<{ user, sessionToken }>;
export function authedFetch(app, sessionToken): typeof app.request;  // wraps in Bearer
```

Réutilisé par les tests intégration des Lots suivants (specimens, identifications).

### 9.4 Couverture minimale Lot 3

- Sign-up : email unique violé → 400 ; payload invalide → 400 ; succès → 201 + mailer appelé 1× avec le bon `to` et URL contenant `${APP_URL}/v1/auth/verify-email?token=`
- Sign-in : mauvais password → 401 ; succès → 200 + Set-Cookie + body.session.token
- Sign-in rate limit : 11e tentative consécutive → 429
- Verify email : token valide → flag flippé ; token expiré → 4xx
- Forget password → reset password → ancien password 401 / nouveau 200
- GET /v1/me sans auth → 401 ; avec session → 200 + shape correcte
- PATCH /v1/me { name: 'X' } → 200 + persisté ; name vide → 400

---

## 10. Dev workflow & secrets

### 10.1 Variables d'environnement

`src/config/env.ts` ajoute :

```
BETTER_AUTH_SECRET   string, min 32 chars              required
BETTER_AUTH_URL      url                               required, e.g. http://localhost:3000
SMTP_URL             string starting smtp:// or smtps://  required
MAIL_FROM            string, format "Name <email>"     required
APP_URL              url                               required, e.g. http://localhost:8081
```

Le bloc Lot 3 de `.env.example` est promu hors du commentaire « Added in later lots ». Une valeur par défaut adaptée à `docker-compose.yaml` est fournie pour chaque var pointant vers une ressource locale (`SMTP_URL=smtp://localhost:1025`, `BETTER_AUTH_URL=http://localhost:3000`, `APP_URL=http://localhost:8081`, `MAIL_FROM="Airbarium <noreply@airbarium.app>"`). `BETTER_AUTH_SECRET` reste vide dans `.env.example` ⇒ l'utilisateur doit le générer via `bun run auth:secret` au premier setup.

### 10.2 Script `auth:secret`

```bash
bun run auth:secret
# imprime un hex 64 chars (32 bytes) à coller dans BETTER_AUTH_SECRET
```

Implémentation : `src/utils/auth-secret.ts` = `console.log(crypto.randomBytes(32).toString('hex'))`. Pas de side effect, idempotent. Exposé via `package.json`.

### 10.3 Quickstart README

Ajout d'un paragraphe Lot 3 :

```
1. Génère ton BETTER_AUTH_SECRET : `bun run auth:secret`
2. Copie le retour dans .env (BETTER_AUTH_SECRET=…)
3. docker compose up -d (mailhog inclus)
4. bun run db:migrate (applique aussi la migration 0001 BA)
5. bun run dev
6. Sign-up : curl exemple
7. Verifie ton email sur http://localhost:8025
```

---

## 11. Risques / points de vigilance

1. **Drift du schéma BA** — Si `@better-auth/cli generate` réécrit nos fichiers en `camelCase`, on hand-edit pour rester `snake_case`. Garde-fou : `bun run db:generate` exécuté après le commit BA ne doit produire aucun diff. À couvrir par un check manuel dans la Task « génère la migration 0001 ».
2. **Cookie SameSite en dev cross-port** — Mobile via Bearer n'est pas concerné, mais une future web preview sur `localhost:19006` pourrait casser si on bascule `sameSite=strict`. On reste sur `lax`. Couvert par le test sign-in (vérifie `Set-Cookie; SameSite=Lax`).
3. **Mailer KO ne casse pas la sign-up** — La sign-up commit en DB même si SMTP échoue (l'user peut re-déclencher). Log `error` sur le mailer ⇒ visible en Prometheus / observability quand Lot 8 ajoutera les compteurs.
4. **Format d'erreur Better Auth ≠ enveloppe maison** — Les routes `/v1/auth/*` ne renvoient pas `{ error: { code, message } }` mais la shape Better Auth (`{ message, code }`). Acceptable (le SDK BA s'y attend) mais à documenter dans CLAUDE.md.
5. **Quota Argon2 sur CPU mutualisé** — `Bun.password.hash` par défaut consomme ~64 MiB et ~50 ms par hash. À 100 sign-up/min ça reste OK ; en cas de DDoS on s'appuie sur le rate-limit sign-up (3/h/IP).
6. **`additionalFields` typing pour Better Auth** — Sans la déclaration, `auth.api.getSession()` retournerait un `user` sans `avatarUrl` / `deletedAt`. Test : `tests/unit/services/profile.test.ts` confirme que la fonction `getMe` compile et retourne `avatar_url`.

---

## 12. Hors scope explicite

Rappel pour ne pas dériver :

- `DELETE /v1/me` → Lot 8 (besoin du cron Garage purge)
- `PUT/DELETE /v1/me/avatar` → Lot 4 (besoin du client Garage)
- DB-backed rate limiter → Lot 8
- Audit log des actions sensibles → V2
- OAuth Google/Apple → V2
- 2FA, WAF, IP allowlisting → V2
- Re-vérification email lors d'un changement d'email → V2
- `optionalAuth()` middleware (toutes les routes hors `/auth/*` et `/health` sont strictement protégées en MVP) → V2

---

## 13. Critères de done Lot 3

- [ ] `bun test` vert : 8+ fichiers de tests (unit mailer/emails/profile, intégration auth/me)
- [ ] `bun run typecheck` & `bun run lint` propres
- [ ] Migration `0001_*.sql` appliquée sur DB fraîche, 3 tables BA créées, `\dt` montre `users / account / session / verification / species / specimens / identifications / plantnet_usage / rate_limit / __drizzle_migrations`
- [ ] Sign-up via curl crée l'user, MailHog reçoit l'email
- [ ] Clic du lien vérifie l'email (flag flippé en DB)
- [ ] Sign-in retourne cookie + Bearer token, GET /v1/me passe avec l'un ou l'autre
- [ ] PATCH /v1/me change le nom et bump `updated_at`
- [ ] Forget/reset password roundtrip OK end-to-end via MailHog
- [ ] CI verte sur la PR
