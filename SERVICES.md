# VIDA Finance — Railway Microservices

## Production Architecture (`observant-miracle` / `production`)

```
                ┌──────────────────────────────────────────────┐
                │   Railway project: observant-miracle (prod)    │
                │                                                │
Firebase ──────►│  payment-server        :3001                  │
Functions       │  softcredito-adapter   :3002                  │
(Cloud Run,     │  notification-service  :3003                  │
 public URLs)   │  pdf-generator         :3004                  │
                │  ml-service            :3005                  │
                │  underwriting-service  :3003                  │
                │                ↕ private networking            │
                │       Redis (shared)   :6379                   │
                └──────────────────────────────────────────────┘
```

> **Service-to-service calls use Railway private networking** (`*.railway.internal`).
> **Firebase Functions run on Cloud Run** (outside Railway) and therefore call the
> services over their **public** `*.up.railway.app` URLs.

## Services

| Service | Port | Language | Purpose |
|---------|------|----------|---------|
| payment-server | 3001 | Node.js | Conekta webhook receiver + SPEI disbursement BullMQ worker |
| softcredito-adapter | 3002 | Node.js | SoftCrédito SPEI + payroll-deduction API wrapper |
| notification-service | 3003 | Node.js | BullMQ consumer — WhatsApp (Twilio) + email (SendGrid) |
| pdf-generator | 3004 | Node.js | Puppeteer loan contracts + receipts (e-signature via MetaMap) |
| ml-service | 3005 | Python | Scorecard/XGBoost underwriting + Stage 4 autoencoder + Claude judge |
| underwriting-service | 3003 | Node.js | 7-stage credit pipeline: employer screening, identity, bureau (Belvo), KYC (MetaMap), review |
| Redis | 6379 | Redis | BullMQ queues + rate limiting + ML cache |

> **Note on the shared `:3003`:** `notification-service` and `underwriting-service`
> both listen on `3003`. This is **not** a conflict — each runs in its own container
> with its own internal hostname, so the port is namespaced per service.

## Private Networking (Railway internal domains)

```
payment-server.railway.internal:3001
softcredito-adapter.railway.internal:3002
notification-service.railway.internal:3003
pdf-generator.railway.internal:3004
ml-service.railway.internal:3005
underwriting-service.railway.internal:3003
redis.railway.internal:6379
```

## Public Domains & Health Checks

All services expose `GET /health` returning HTTP 200 + JSON
(`{ "status": "ok", "service": "<name>", "redis": true, "ts": "..." }`).

```bash
curl https://payment-server-production-b9b8.up.railway.app/health
curl https://softcredito-adapter-production.up.railway.app/health
curl https://notification-service-production-f49e.up.railway.app/health
curl https://pdf-generator-production-1a31.up.railway.app/health
curl https://ml-service-production-f949.up.railway.app/health
curl https://underwriting-service-production.up.railway.app/health
```

## Deployment

Each service builds from the **monorepo root** using a per-service Dockerfile,
selected by the `RAILWAY_DOCKERFILE_PATH` variable
(e.g. `services/softcredito-adapter/Dockerfile`).

- **GitHub-connected services** auto-deploy on push to `main`.
- **Manual / recovery deploy** (e.g. recreating a deleted service) from the repo root:

  ```bash
  railway link --project <observant-miracle-id> --environment production
  # create the service shell (empty), then set its variables, then:
  railway up --service <name> --ci          # uploads repo root, builds via Dockerfile path
  railway domain --service <name>           # (or MCP generate-domain) for a public URL
  ```

  Shared secrets can be referenced across services to avoid copying values, e.g.
  `REDIS_URL=${{payment-server.REDIS_URL}}`,
  `FIREBASE_SERVICE_ACCOUNT_B64=${{payment-server.FIREBASE_SERVICE_ACCOUNT_B64}}`.

## Per-service environment

Authoritative env contracts live in each `services/<name>/.env.example`. Highlights:

- **softcredito-adapter:** `SOFTCREDITO_API_URL`, `SOFTCREDITO_TOKEN_URL`,
  `SOFTCREDITO_CLIENT_ID`, `SOFTCREDITO_CLIENT_SECRET`, `REDIS_URL`,
  `FIREBASE_SERVICE_ACCOUNT_B64`, `INTERNAL_SECRET`, `PAYMENT_SERVER_URL`
- **underwriting-service:** `EMPLOYER_SAT_PROVIDER=local` + `FIREBASE_STORAGE_BUCKET`,
  `DENUE_API_KEY`, `BELVO_*`, `RISKSEAL_*`, `METAMAP_*`, `KYC_MODE`,
  `ML_SERVICE_URL` (internal), `ML_INTERNAL_SECRET`,
  `SOFTCREDITO_ADAPTER_URL` (internal), `INTERNAL_SECRET`, `ANTHROPIC_API_KEY`
  - **Removed:** `VERIFIK_*` (provider dropped in PR #346) and the legacy individual
    SAT-taxpayer check (covered by MetaMap government check in Stage 4).
- **pdf-generator:** `FIREBASE_STORAGE_BUCKET`, `API_BASE_URL`, MetaMap signing creds.

## Firebase Functions → services (set in `functions/.env` at deploy, from GitHub secrets)

```
SOFTCREDITO_ADAPTER_URL    # https://softcredito-adapter-production.up.railway.app
UNDERWRITING_SERVICE_URL   # https://underwriting-service-production.up.railway.app
PAYMENT_SERVER_URL         # https://payment-server-production-b9b8.up.railway.app
NOTIFICATION_SERVICE_URL   # https://notification-service-production-f49e.up.railway.app
PDF_GENERATOR_URL          # https://pdf-generator-production-1a31.up.railway.app
ML_SERVICE_URL             # https://ml-service-production-f949.up.railway.app
INTERNAL_SECRET            # shared inter-service auth token
REDIS_URL                  # BullMQ queues
ALLOW_STUB_DISBURSEMENT    # 'true' ONLY in local/dev/test — never in production
```

> **Disbursement safety:** a failed or unconfigured SPEI transfer marks the loan
> `disbursement_failed` (and alerts), and never `active` with a `STUB-` reference.
> A simulated disbursement is only produced when `ALLOW_STUB_DISBURSEMENT=true`.

## Redis

Provisioned as a Railway service (`Redis`). Reference its URL via
`${{payment-server.REDIS_URL}}` (or `redis://...@redis.railway.internal:6379`).
