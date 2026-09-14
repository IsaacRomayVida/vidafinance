# FunPay (vidafinance) — Local Setup

Everything needed to go from a clean Mac to every CI suite passing locally.
Architecture and service map: [README.md](README.md), [SERVICES.md](SERVICES.md).
Agent-facing portal and QA details: [AGENTS.md](AGENTS.md).

> This file used to describe the vanilla-JS SPA on a `develop` branch. Both
> are gone: the site is `public-v2/` (React/Vite), and `develop` is hundreds
> of commits behind `main`. Do not check it out.

---

## 1. Tools

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ (CI uses 24) | Cloud Functions deploy on 22 (`functions/package.json` engines) |
| Python | 3.12 | ml-service only; `uv` is the easiest way to get it |
| Java | 21 | Firestore/Storage emulators (rules tests) |
| PostgreSQL | 16 | registry-service tests (`brew install postgresql@16 && brew services start postgresql@16`) |
| libomp | — | macOS only, required to build `lightgbm` (`brew install libomp`) |
| Firebase CLI | latest | `npm i -g firebase-tools` |
| GitHub CLI | latest | `gh auth login` |
| Railway CLI | latest | only to inspect/deploy services |

## 2. Clone

```bash
gh repo clone IsaacRomayVida/vidafinance
cd vidafinance
```

Work from `main`, or from the branch currently deployed to the review
portal (see §6) when building on what reviewers see.

## 3. Install

Each package has its own lockfile; install them independently.

```bash
npm ci                                     # root: rules/migration tests, husky
(cd functions && npm ci)
(cd public-v2 && npm ci --legacy-peer-deps)
(cd mobile && npm ci)
(cd db/registry && npm ci)
for s in underwriting-service softcredito-adapter payment-server \
         notification-service pdf-generator registry-service; do
  (cd services/$s && npm ci)
done
(cd services/ml-service && uv venv --python 3.12 .venv \
  && uv pip install --python .venv/bin/python \
     -r requirements.txt -r requirements-dev.txt pytest pytest-asyncio)
```

## 4. Run the CI gates locally

These mirror `.github/workflows/ci.yml` and `mobile-ci.yml`.

```bash
# Functions
(cd functions && npm run typecheck && npm run typecheck:tests && npm run lint && npm run test:ci)

# Migration scripts + script decision tests
npm run typecheck:scripts && npm run test:migrations
node --test scripts/*.test.mjs

# Website
(cd public-v2 && npm run lint && npm test && npm run build)

# Mobile
(cd mobile && npm run typecheck && npm test)

# Railway services
for s in underwriting-service softcredito-adapter payment-server notification-service pdf-generator; do
  (cd services/$s && npm test)
done
(cd services/ml-service && .venv/bin/python -m pytest -q)
```

**Registry (needs Postgres):**

```bash
createdb vida_registry_test
export DATABASE_URL="postgres://$USER@localhost:5432/vida_registry_test"
(cd db/registry && npm run migrate:up)
(cd services/registry-service && npm test)
```

**Security rules (needs Java 21):**

```bash
firebase emulators:exec --only firestore,storage --project demo-vida-finance-test "npm run test:rules"
```

If another project's emulators already hold 8080/9199/4400/4500/9150,
run with a copy of `firebase.json` whose `emulators` block uses free ports
(`--config path/to/copy.json`); the tests read the emulator hosts from the
environment `emulators:exec` exports.

## 5. Running things

| What | Command |
|---|---|
| Website dev server | `cd public-v2 && npm run dev` |
| Website as served behind the review portal | `cd public-v2 && VITE_BASE_PATH=/funpay/web/ VITE_LAUNCH_MODE=live npm run build`, then serve `dist/` under `/funpay/web/` |
| Mobile app | `cd mobile && npm start` |
| Functions + Firestore + Auth emulators | `cd functions && npm run build && cd .. && firebase emulators:start` |

Environment contracts live in each package's `.env.example`
(`functions/`, `public-v2/`, `db/registry/`, `services/*/`). None are needed
to build or pass tests. `ALLOW_STUB_DISBURSEMENT=true` is for local/test
only — this is a money system.

There is **no staging environment** (see SERVICES.md). The review portal
and the mobile app run against production Firebase.

## 6. Review portal

Reviewers use **https://alfa.suena.ch/funpay/** (Google sign-in via
Cloudflare Access). The Suena holding portal (`suena-app` repo) proxies
`funpay-alfa.web.app` under `/funpay`. `alfa.funpay.mx` no longer resolves.

Publish a build there:

```bash
gh workflow run deploy-team-portal.yml --ref <branch> \
  -f ref=<branch> -f mode=deploy -f holding_prefix=/funpay -f web_launch_mode=live
```

The footer names the build under review (`/funpay/version.json`).

## 7. Deploying production

Production deploys run from CI on push to `main` (`deploy.yml`); see
[docs/runbooks/deploy.md](docs/runbooks/deploy.md). Canonical production
URLs live only in [scripts/production-endpoints.json](scripts/production-endpoints.json).
Check liveness with `node scripts/check-production-health.mjs`.

## 8. Troubleshooting

| Issue | Fix |
|---|---|
| `lightgbm` build fails: `libomp.dylib … missing` | `brew install libomp`, reinstall ml-service deps |
| Registry tests: 53 failures, connection refused | Postgres not running or `DATABASE_URL` unset / migrations not run |
| `Could not start Firestore Emulator, port taken` | Another emulator suite is running; use alternate ports (§4) |
| Review portal frame is blank, HTTP 200 | Build was not made with `holding_prefix=/funpay` |
| Films or stills missing behind the portal | A public asset is referenced by root path in TSX; wrap it in `publicAsset()` |
| `firebase login` can't open a browser | `firebase login` prints a URL; open it, then `firebase login <code>` |
