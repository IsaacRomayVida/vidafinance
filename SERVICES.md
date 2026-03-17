# VIDA Finance — Railway Microservices

## Staging Architecture

```
                ┌─────────────────────────────────────────┐
                │        Railway Staging Project           │
                │                                         │
Firebase ──────►│  payment-server      :3001              │
Functions      │  softcredito-adapter :3002              │
(Cloud Run)    │  notification-service :3003             │
               │  pdf-generator       :3004              │
               │  ml-service          :3005              │
               │                ↕ private networking     │
               │       Redis (shared)  :6379             │
               └─────────────────────────────────────────┘
```

## Services

| Service | Port | Railway Name | Language | Purpose |
|---------|------|--------------|----------|---------|
| payment-server | 3001 | vida-payment-server | Node.js | Conekta webhook receiver + SPEI disbursement BullMQ worker |
| softcredito-adapter | 3002 | vida-softcredito | Node.js | SoftCrédito SPEI + payroll deduction API wrapper |
| notification-service | 3003 | vida-notifications | Node.js | BullMQ consumer — WhatsApp (Twilio) + email (SendGrid) |
| pdf-generator | 3004 | vida-pdf-generator | Node.js | BullMQ consumer — Puppeteer loan contracts + receipts |
| ml-service | 3005 | vida-ml-service | Python | XGBoost/LightGBM underwriting + Claude LLM judge |
| Redis | 6379 | vida-redis | Redis 7 | BullMQ queues + rate limiting + ML cache |

## Private Networking (Railway Internal Domains)

```
vida-payment-server.railway.internal:3001   → vida-payment-server
vida-softcredito.railway.internal:3002      → vida-softcredito
vida-notifications.railway.internal:3003    → vida-notifications
vida-pdf-generator.railway.internal:3004    → vida-pdf-generator
vida-ml-service.railway.internal:3005       → vida-ml-service
vida-redis.railway.internal:6379            → vida-redis
```

## Health Check Endpoints

All services expose `GET /health` returning HTTP 200 + JSON:
```json
{ "status": "ok", "service": "<name>", "redis": true, "ts": "..." }
```

Verify with:
```bash
curl https://vida-payment-server.railway.app/health
curl https://vida-softcredito.railway.app/health
curl https://vida-notifications.railway.app/health
curl https://vida-pdf-generator.railway.app/health
curl https://vida-ml-service.railway.app/health
```

## Deployment Order

1. Create Railway project `vida-staging`
2. Add Redis service first (`vida-redis`, image: `redis:7.2-alpine`)
3. Add all 5 microservices linked to this repo (point each to the right `services/<name>/` subdirectory)
4. **Add GitHub secrets** (see list below) — then run the automated setup:

   ```bash
   # Option A — GitHub Actions (recommended)
   # 1. Add RAILWAY_TOKEN + other secrets to GitHub repo Settings → Secrets → Actions
   # 2. Go to Actions → "Setup Railway Environment Variables" → Run workflow → service: all

   # Option B — Local script
   RAILWAY_TOKEN=<token> \
   FIREBASE_SERVICE_ACCOUNT_B64=<base64> \
   INTERNAL_SECRET=<secret> \
   CONEKTA_WEBHOOK_SECRET=<secret> \
   SOFTCREDITO_CLIENT_ID=<id> \
   SOFTCREDITO_CLIENT_SECRET=<secret> \
   TWILIO_ACCOUNT_SID=<sid> \
   TWILIO_AUTH_TOKEN=<token> \
   SENDGRID_API_KEY=<key> \
   ANTHROPIC_API_KEY=<key> \
   MIFIEL_APP_ID=<id> \
   MIFIEL_APP_SECRET=<secret> \
   bash scripts/setup-railway-env.sh
   ```

5. Deploy services — push to `main`/`develop` triggers auto-deploy, or use:
   `Actions → "Deploy Railway Services" → Run workflow → service: all`

## Required GitHub Secrets

```
# Firebase
FIREBASE_SERVICE_ACCOUNT_KEY              # service account JSON for Firebase deploys (GOOGLE_APPLICATION_CREDENTIALS)

# Railway
RAILWAY_TOKEN                             # Railway production project deploy token
RAILWAY_TOKEN_STAGING                     # Railway staging project deploy token

# Application
CONEKTA_API_KEY
CONEKTA_WEBHOOK_SECRET
INTERNAL_SECRET                           # shared inter-service auth token
SOFTCREDITO_CLIENT_ID
SOFTCREDITO_CLIENT_SECRET
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
SENDGRID_API_KEY
ANTHROPIC_API_KEY
REDIS_URL                                 # for Firebase Functions
SOFTCREDITO_ADAPTER_URL                   # https://vida-softcredito.railway.app
PAYMENT_SERVER_URL                        # https://vida-payment-server.railway.app
NOTIFICATION_SERVICE_URL                  # https://vida-notifications.railway.app
PDF_GENERATOR_URL                         # https://vida-pdf-generator.railway.app
ML_SERVICE_URL                            # https://vida-ml-service.railway.app
```

## Redis Service Configuration (Railway)

```toml
# Add to Railway as a new service named vida-redis
[deploy]
image = "redis:7.2-alpine"
```

Redis URL via Railway variable reference: `${{Redis.REDIS_URL}}`
Private URL: `redis://vida-redis.railway.internal:6379`
