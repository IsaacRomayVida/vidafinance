# Scaling Runbook

> VIDA Finance v1.7 — Capacity Planning & Scaling Procedures

## Current Architecture Limits

| Component | Default Limit | Current Config | Max Tested |
|-----------|--------------|----------------|------------|
| Firestore writes | 500/sec (default) | 500/sec | 1,000/sec (with quota increase) |
| BullMQ `vida-disbursements` | Unlimited | Default concurrency | 2x target throughput |
| BullMQ `vida-notifications` | Unlimited | Default concurrency | 2x target throughput |
| BullMQ `vida-pdfs` | 2 concurrent | 2 concurrent | 4 concurrent (memory-dependent) |
| BullMQ `vida-underwriting` | Unlimited | Default concurrency | 2x target throughput |
| Redis memory | Railway default | Configured limit | Monitor via Railway dashboard |
| Railway services | Per-plan limits | Standard instances | Scale via Railway dashboard |

---

## BullMQ Concurrency Scaling

### When to Scale
- Queue backlog growing faster than drain rate
- Job processing latency exceeding SLA
- Load test shows bottleneck at current concurrency

### Scaling `vida-disbursements` (payment-server)

1. Check current queue depth and processing rate:
   - Monitor via Railway logs or Redis CLI
2. Increase concurrency in payment-server worker configuration:
   - Update the BullMQ Worker `concurrency` option
   - Typical range: 5–20 concurrent jobs
3. **Caution:** Higher concurrency means more simultaneous SPEI calls to SoftCrédito
   - Verify SoftCrédito rate limits before scaling beyond 10
   - Monitor for 429 (rate limit) responses
4. Redeploy payment-server on Railway

### Scaling `vida-notifications` (notification-service)

1. Notifications are low-risk to scale — they're idempotent
2. Increase BullMQ Worker concurrency:
   - Typical range: 10–50 concurrent jobs
3. Watch for Twilio rate limits:
   - WhatsApp: 80 messages/sec (Business API)
   - SMS: varies by number type
4. SendGrid: 100 emails/sec on current plan
5. Redeploy notification-service on Railway

### Scaling `vida-pdfs` (pdf-generator)

1. **Memory-intensive** — each Puppeteer instance uses ~200MB RAM
2. Current limit: 2 concurrent (to prevent OOM)
3. To increase beyond 2:
   - First scale Railway instance memory (minimum 512MB per concurrent job)
   - Then increase BullMQ concurrency to match
   - Maximum recommended: 4 concurrent on a 2GB instance
4. Monitor memory usage closely after scaling
5. Redeploy pdf-generator on Railway

### Scaling `vida-underwriting` (ml-service)

1. ML inference is CPU-bound (XGBoost/LightGBM) and API-bound (Claude)
2. Increase concurrency in ml-service worker config
3. Watch for:
   - Anthropic API rate limits (check current tier)
   - Redis cache hit rate — higher concurrency benefits from warm cache
   - CPU utilization on Railway instance
4. If CPU-bound, scale Railway instance before increasing concurrency

---

## Firestore Quota Scaling

### Monitoring Current Usage
1. Open Firebase console → Firestore → Usage tab
2. Check writes/sec, reads/sec, and deletes/sec
3. Default limit: 500 writes/sec per database

### Requesting Quota Increase
1. Go to Google Cloud Console → IAM & Admin → Quotas
2. Search for "Cloud Firestore"
3. Select "Write requests per second"
4. Click "Edit Quotas" and request increase
5. Provide justification (expected loan volume, growth projections)
6. Typical approval time: 24–48 hours
7. **Plan ahead** — request quota increase before expected traffic spikes

### Reducing Write Pressure
If quota increase is pending:

1. **Batch writes** — use Firestore batch operations (max 500 ops per batch)
2. **Throttle non-critical writes:**
   - Analytics events → buffer and write in batches
   - Shadow logs (`metamap_shadow_log`) → reduce write frequency
   - Audit logs → ensure critical, but batch where possible
3. **Move high-frequency data to Redis:**
   - Rate limiting counters (already in Redis)
   - ML feature cache (already in Redis)
   - Session data (if applicable)

### Firestore Read Optimization
1. Use composite indexes (defined in `firestore.indexes.json`)
2. Implement pagination for large result sets
3. Cache frequently-read documents in Redis
4. Use Firestore `in` queries instead of multiple single-document reads

---

## Railway Resource Scaling

### Vertical Scaling (Instance Size)

1. Open Railway dashboard → select service
2. Go to Settings → Instance size
3. Scale up memory/CPU as needed:

| Service | Minimum | Recommended | High Load |
|---------|---------|-------------|-----------|
| payment-server | 512MB | 1GB | 2GB |
| softcredito-adapter | 256MB | 512MB | 1GB |
| notification-service | 256MB | 512MB | 1GB |
| pdf-generator | 1GB | 2GB | 4GB |
| ml-service | 1GB | 2GB | 4GB |
| Redis | 256MB | 512MB | 1GB |

4. Railway applies changes with zero-downtime deploy

### Horizontal Scaling (Replicas)

1. Railway supports multiple replicas per service
2. **Stateless services safe to replicate:**
   - softcredito-adapter
   - notification-service (BullMQ handles job distribution)
   - underwriting-service
3. **Requires care when replicating:**
   - payment-server — ensure BullMQ job locking prevents duplicates
   - pdf-generator — memory-heavy, usually vertical scale is better
   - ml-service — model artifacts must be available on all replicas
4. Add replicas via Railway dashboard → service → Settings → Replicas

### Redis Scaling

1. **Memory management:**
   - Set `maxmemory` policy to `allkeys-lru` (evict least-recently-used)
   - Monitor memory usage via Railway dashboard
   - Set alerts at 80% memory utilization
2. **If Redis OOM:**
   - Immediately scale up memory in Railway
   - Flush non-critical caches:
     - ML feature cache (prefix: `ml:cache:*`)
     - Rate limit counters (prefix: `rl:*`)
   - Do NOT flush BullMQ keys (prefix: `bull:*`) — this loses jobs
3. **Connection pooling:**
   - All services use IORedis with connection pooling
   - Default pool size is sufficient for standard load
   - If connection errors occur, increase pool size in service config

---

## Load Testing

### Pre-Scaling Validation

Before scaling for expected traffic:

1. Run load test at 2x target throughput (**never yet run against any deployed environment** — see § Load test below and checklist B8; the v1.7 "validated" claim had no artifact)
2. Monitor all services during test:
   - Response times (p50, p95, p99)
   - Error rates
   - Queue depths
   - Memory/CPU utilization
3. Identify bottleneck and scale that component first
4. Re-run load test to validate improvement

### Load Test Targets

| Metric | Target | 2x Target |
|--------|--------|-----------|
| Loan applications/hour | TBD | 2x TBD |
| Concurrent users | TBD | 2x TBD |
| API response time (p95) | < 500ms | < 1000ms |
| Queue processing latency | < 30s | < 60s |

### Load test — how to run it (B8 / D3)

Script: `tests/load/pipeline-load-test.js` (k6). Target resolution: `tests/load/target.js`.

**What changed, and why it matters.** The script used to default its target to
`https://us-central1-vida-finance.cloudfunctions.net` — the **production** project
(`.firebaserc` default; `/api/health` answers 200 there). A bare `npm run load-test`
therefore sent loan requests at production. There is now **no default**:

| `TARGET_URL` host | Result |
|---|---|
| unset | refuses to start |
| `localhost` / `127.0.0.1` | label `emulator` |
| production (`*vida-finance.cloudfunctions.net`, `vida-finance.web.app`, `*-production*.up.railway.app`) | refuses unless `LOAD_TEST_ALLOW_PRODUCTION=I-HAVE-OPS-SIGN-OFF` → label `production` |
| any other remote host | refuses unless `LOAD_TEST_TARGET_ENV=staging` → label `staging` |

The setup step now **aborts** (it used to "proceed anyway") if `/api/health` is not 200.
Results land in `tests/load/results/<date>-<label>-<profile>-report.md` (committable) and
`…-summary.json` (gitignored raw output). The label is in the file name *and* the report header.
Pinned by `node --test tests/load/target.test.mjs` (CI hard gate).

**Is there a staging environment?** Not a usable one, as of 2026-10-13:
`deploy.yml` deploys `develop` → the project in secret `FIREBASE_PROJECT_ID_STAGING`, but
`develop` is 429 commits behind `main`, its last three deploy runs all **failed**
(latest 2026-05-29, run 26654665135), and no staging URL is recorded in-tree
(`scripts/verify-staging.sh` says the same). So the only non-production target available
today is the local emulator.

**Blockers before any result means anything** (true for staging *and* production):

1. **App Check.** `requestLoan` has `enforceAppCheck: true`. Pass a debug token registered on
   the target project as `APP_CHECK_TOKEN` (sent as `X-Firebase-AppCheck`), or every request
   fails before reaching business logic.
2. **Auth / user pool.** `requestLoan` needs an `employees/{uid}` doc and rate-limits each uid
   to **3 requests/day**. The script's `FIREBASE_API_KEY` sign-in path invents a fresh email per
   iteration (never pre-seeded) and `AUTH_TOKEN` is a single uid. A meaningful 2x run needs a
   seeded pool of load-test employees large enough to stay under 3/day/uid (≈ 280/min × 30 min ⇒
   ~2,800 uids for the 2x stage alone). That seeding does not exist yet.
3. **External side effects.** `requestLoan` calls `underwriting-service`, whose pipeline
   reaches the credit bureau and RiskSeal (`services/underwriting-service/index.js`). On
   production those providers are live and must stay live — the mock flags the script's header
   asks for are a staging-only setting. Do **not** run the full profile against production;
   at most the smoke profile, with a dedicated load-test employer and a cleanup plan for the
   loan and audit documents it creates.

**Commands.**

```bash
# Emulator (local; nothing leaves the machine). Functions emulator on a non-default port.
k6 run --env TARGET_URL=http://127.0.0.1:5011/demo-vida-load/us-central1 \
       --env PROFILE=smoke tests/load/pipeline-load-test.js

# Staging, once it is deployable again (see above)
k6 run --env TARGET_URL=https://us-central1-<STAGING_PROJECT>.cloudfunctions.net \
       --env LOAD_TEST_TARGET_ENV=staging --env APP_CHECK_TOKEN=<debug token> \
       --env AUTH_TOKEN=<id token of a seeded load-test employee> \
       tests/load/pipeline-load-test.js

# PRODUCTION — smoke profile only, only with ops sign-off, only in the window below
k6 run --env TARGET_URL=https://us-central1-vida-finance.cloudfunctions.net \
       --env LOAD_TEST_ALLOW_PRODUCTION=I-HAVE-OPS-SIGN-OFF \
       --env APP_CHECK_TOKEN=<debug token> --env AUTH_TOKEN=<seeded load-test employee> \
       --env PROFILE=smoke tests/load/pipeline-load-test.js
```

**Recommended window (production).** Tue–Thu, 03:00–05:00 `America/Mexico_City`. Avoid:
the two days either side of a quincena (15th and last day of month — payroll deduction and
disbursement peaks); 09:00 (`dailyLoanCheck`); 02:00 on the 15th (`satBlacklistRefresh`).
This is reasoned from the schedules in `functions/src/scheduled/`, not from measured traffic —
check the Cloud Monitoring request graph for the chosen night first.

**Abort thresholds (stop k6 with Ctrl-C immediately if any is hit).** k6's own thresholds
(`tests/load/config.js`) only *grade* the run at the end; these are the live stop rules:

| Signal | Abort when |
|---|---|
| `loan_error_rate` (k6 live output) | > 5% over any 1-minute window |
| `http_req_duration{type:requestLoan}` p95 | > 30 s |
| HTTP 5xx from any service in `scripts/production-endpoints.json` | any sustained > 1 min |
| `rate_limited_requests` | climbing on every iteration (= the user pool is exhausted; the run is measuring the limiter) |
| Real-user impact | any alert from `docs/runbooks/alerting-runbook.md`, or a support report |
| Firestore writes/sec | > 80% of quota (B5) |

After the run: commit `tests/load/results/<date>-<label>-<profile>-report.md`; only a
`production` or `staging` report at the `full` profile can close B8.

---

## Scaling Decision Tree

```
Is response time degraded?
├── Yes → Check which service is slow
│   ├── API (Cloud Functions) → Scale Firebase Functions instances
│   ├── Queue processing → Increase BullMQ concurrency
│   ├── Database → Check Firestore quotas
│   └── External API → Check provider rate limits
└── No → Is queue backlog growing?
    ├── Yes → Increase worker concurrency for that queue
    └── No → Is memory/CPU high?
        ├── Yes → Vertical scale the Railway instance
        └── No → System is healthy, no action needed
```

## Emergency Scaling Checklist

For sudden traffic spikes:

1. [ ] Scale Railway instances to "High Load" tier (see table above)
2. [ ] Increase BullMQ concurrency for all queues by 2x
3. [ ] Increase Redis memory by 2x
4. [ ] Request Firestore quota increase if near limit
5. [ ] Enable Firebase Functions min-instances to reduce cold starts
6. [ ] Monitor for 15 minutes, adjust as needed
7. [ ] Scale back down when traffic normalizes (cost management)
