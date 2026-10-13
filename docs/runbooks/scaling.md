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

**What a run needs** (true for any target; each item is a step below):

1. **A seeded user pool.** `requestLoan` needs an `employee` ID token, an `employees/{uid}`
   document with `metamapStatus: 'verified'` and a readable credit line, and an `active` employer
   with a free slot. `tests/load/seed/seed-load-pool.mjs` creates all of it; the k6 script
   recomputes the same ids from `POOL_SIZE` (`tests/load/seed/pool.js`), so no file is passed
   between the two. Without `POOL_SIZE` (or the legacy single-uid `AUTH_TOKEN`) k6 refuses at init.
2. **App Check.** `requestLoan` has `enforceAppCheck: true`. A deployed target with neither
   `APP_CHECK_DEBUG_TOKEN` nor `APP_CHECK_TOKEN` is refused at init (it used to run and collect
   100% 401s).
3. **Providers switched off on the target** — see "Keeping bureau / RiskSeal out of it".
4. **Redis reachable from the target's functions** (`REDIS_URL`). The 3/day limiter fails
   closed: without Redis every request is `UNAVAILABLE`.

#### uid-pool arithmetic

One iteration = one `requestLoan` call = **one uid, used once**. Two rules in
`functions/src/index.ts` set that:

- `rl:loan:<uid>` allows 3 calls per uid per 24 h, and counts every call, accepted or not.
- A uid with a loan in `pending` / `under_review` / `approved` / `disbursement_queued` / `active`
  is refused a second one (`DUPLICATE_LOAN_APPLICATION`). So a uid yields **one** accepted request,
  not three; calls two and three only exercise the refusal path, and k6 counts them as failures.

The earlier estimate of ~2,800 uids divided the 2x stage by the 3/day limit. That ignores the
open-loan rule: the last stage alone can make 7,560 calls, so 2,800 uids run dry partway through it.

How many iterations a profile can make: the script runs `ceil(target / 10)` VUs per stage, ramped
linearly from the previous stage, and a VU cannot loop faster than once per 5 s (it sleeps 5–7 s).
`iterationUpperBound()` in `tests/load/seed/pool.js` computes the ceiling, and
`pool.test.mjs` fails if this table or the default pool size falls behind `tests/load/config.js`:

| Profile | Iterations, upper bound | Pool to seed |
|---|---|---|
| `smoke` | 132 | `--count 200` |
| `full` | 12,420 (360 + 1,080 + 3,420 + 7,560 per stage) | `--count 12500` (the default: 12,500) |

Expect roughly 8,000–10,000 real iterations in `full` (6 s mean sleep plus request latency). When
the pool runs out k6 **aborts** rather than wrapping round. Employers get `maxActiveSlots` equal to
their member count (50 each, `maxActiveSlotsSource: 'ops_override'`), so the employer slot cap is
never the thing being measured.

Two consequences worth knowing before reading a result:

- **Same-day re-runs.** Teardown deletes the loans but cannot reset the Redis counters. After
  teardown + re-seed a uid can be used again (twice more that day). Otherwise skip the used members:
  `--env POOL_OFFSET=<members already used>` and a correspondingly larger `--count`.
- **The `2x_target` stage ramps to 28 VUs; it does not hold them.** Peak is about 240 requests/min
  at the very end of the run, and 280/min is never sustained. Proving "2x for 30 minutes" needs a
  hold stage in `tests/load/config.js`, and 280/min × 30 min = 8,400 more uids.

#### Keeping bureau / RiskSeal out of it

`requestLoan` reaches external providers only through two URLs in the functions environment:
`UNDERWRITING_SERVICE_URL` (the 6-stage pipeline) and `ML_SERVICE_URL` (the inline gate). There
is **no single "load-test mode" switch**, and `/api/health` does not report how the target is
configured — the script's old "verify mock mode" step only ever re-read the health endpoint. The
operator checks the target's variables by hand before the run. What exists today:

| Provider | Reached from | Switch that exists | Notes |
|---|---|---|---|
| Whole pipeline | `functions/src/index.ts` (`if (uwUrl && intSecret)`) | leave `UNDERWRITING_SERVICE_URL` **unset** on the target's functions | No bureau, RiskSeal, MetaMap or Belvo call is possible. Simplest safe setup. |
| RiskSeal | `underwriting-service/src/riskseal-client.js` | `RISKSEAL_MOCK=true` | Deterministic mock (score 72, passes) unless the RFC ends `XXX`/`YYY`; pool RFCs never do. |
| MetaMap | `underwriting-service/src/metamap-client.js` | `METAMAP_MOCK=true` | |
| Credit bureau (via SoftCrédito) | `softcredito-adapter` `POST /bureau/query` | `BUREAU_MODE=offline` on the adapter (`lib/bureauFallback.js`) | Never calls the bureau; returns a neutral synthetic record marked `_fallback`. |
| Belvo | `underwriting-service/src/belvo-client.js` | leave `BELVO_BASE_URL` unset with `NODE_ENV` ≠ `production` | Falls back to `sandbox.belvo.com` — still a third party, but not live data. |
| DENUE / REPSE (and the other `gov-apis.js` lookups) | `underwriting-service/src/gov-apis.js` | **none** | DENUE and REPSE throw when their URL is unset; the check is recorded as `skipped` and escalates to Stage 5. The other lookups in that file were not analysed. |
| ML service (and the LLM keys it holds) | `ML_SERVICE_URL` | **none** | Point it at a non-production ml-service, or leave it unset. |

Gaps, stated plainly: none of the three switches is refused in production (they take effect
wherever they are set; `.github/workflows/railway-setup-env.yml` pins production's
`RISKSEAL_MOCK` to `false`); the gov lookups and the ML service have no mock; and
nothing lets a run confirm the target's settings from outside.

Two workable setups:

- **A — functions only (recommended first).** `UNDERWRITING_SERVICE_URL` unset. With
  `ML_SERVICE_URL` also unset the inline gate fails closed and every accepted loan is
  `under_review` with a `review_queue` row. This measures auth, the limiter, Firestore and the
  loan transaction. It is what the emulator check in step 2 runs.
- **B — full pipeline.** A non-production underwriting-service with `RISKSEAL_MOCK=true`,
  `METAMAP_MOCK=true`, no `BELVO_BASE_URL`, and a non-production softcredito-adapter with
  `BUREAU_MODE=offline`. Outcomes will skew to manual review because the gov lookups are skipped.

`requestLoan` itself sends no notification, and pool members have no phone and a
`@loadtest.invalid` address, so nothing in a run can reach a real person.

#### Needs a human first (console and credential actions — not automated, not done)

**H1. A non-production target.** None exists today (see above). Required of it:

- a Firebase project that is not `vida-finance`, with the functions deployed from the commit under test;
- Firebase Auth → Sign-in method → **Email/Password enabled** (k6 signs pool members in with a password);
- `firestore.indexes.json` deployed (`firebase deploy --only firestore:indexes --project <id>`);
- `REDIS_URL` set for the functions, and the provider settings from the section above;
- a service-account key **for that project** for the seed (roles: Firebase Authentication Admin,
  Cloud Datastore User). Creating it is an IAM action for a project owner.

**H2. An App Check debug token on that project.**

1. Firebase console → the non-production project → **App Check** → **Apps** → the web app →
   ⋮ → **Manage debug tokens** → **Add debug token** → generate → name it `k6-load-test-<date>` → save.
   (The web app must already be registered with App Check.)
2. Copy the token. It is a secret: keep it out of the repo and out of shell history files.
3. From Project settings → General → Your apps, note the **App ID** (`1:…:web:…`) and the
   **Web API key**.
4. The debug token is *not* what goes in the header. k6 exchanges it
   (`…/v1/projects/<project>/apps/<app id>:exchangeDebugToken`) for an App Check token and
   re-exchanges at 80% of its lifetime, so the 2-hour `full` profile outlives the 1-hour token.
   To check the token by hand first (one request to the App Check API, not to the app):

   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d "{\"debug_token\":\"$APP_CHECK_DEBUG_TOKEN\"}" \
     "https://firebaseappcheck.googleapis.com/v1/projects/$FIREBASE_PROJECT_ID/apps/$FIREBASE_APP_ID:exchangeDebugToken?key=$FIREBASE_API_KEY"
   # → {"token":"eyJ…","ttl":"3600s"}
   ```

5. **Delete the debug token in the console when the run is over.**

The exchange path has unit tests for the request it builds but has **never been run against a
real project** — the smoke run in step 5 is its first real test.

#### Environment variables the k6 script reads

| Variable | Meaning |
|---|---|
| `TARGET_URL` | Functions base URL; validated by `tests/load/target.js` (table above). `STAGING_URL` is the old name. |
| `LOAD_TEST_TARGET_ENV=staging` | Required for any remote host that is not production. |
| `POOL_SIZE` | The `--count` the pool was seeded with. |
| `POOL_OFFSET` | First pool index to use (default 0). |
| `LOAD_TEST_PASSWORD` | The password the pool was seeded with. |
| `FIREBASE_API_KEY` | Web API key of the target project (sign-in, and the App Check exchange). |
| `APP_CHECK_DEBUG_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | Debug token and what is needed to exchange it. |
| `APP_CHECK_TOKEN` | Alternative: an already-exchanged token. Expires; smoke profile only. |
| `FIREBASE_AUTH_EMULATOR_HOST` | Emulator only: sign in against the Auth emulator instead of Google. |
| `PROFILE` | `smoke` or `full` (default). |
| `AUTH_TOKEN` | Legacy, no pool: one uid, so one accepted request and then refusals. |

#### Order of operations

**0. Install k6** (v0.38 or newer; not installed on the dev machine as of 2026-10-13).
macOS: `brew install k6`. Other systems: <https://grafana.com/docs/k6/latest/set-up/install-k6/>.
Check with `k6 version`. Because k6 is not installed here, the script changes in this section are
covered by node tests of the module k6 imports (`tests/load/seed/pool.js`) but **k6 itself has not
run them yet** — the emulator run in step 2 is the place to find out.

**1. Dry run** — prints the plan; reads and writes nothing, needs no credentials:

```bash
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --dry-run
```

**2. Rehearse on the emulator** (nothing leaves the machine; always a `demo-*` project):

```bash
# seed + idempotency + teardown against real Firestore/Auth emulators
firebase emulators:exec --only firestore,auth --project demo-vida-load \
  "node tests/load/seed/emulator-rehearsal.mjs"

# the real requestLoan accepting pool members (needs a local Redis and a built functions/lib)
redis-server --port 6390 --save '' &
(cd functions && npm ci && npm run build)
REDIS_URL=redis://127.0.0.1:6390 TARGET_URL=http://127.0.0.1:5001/demo-vida-load/us-central1 \
  firebase emulators:exec --only functions,firestore,auth --project demo-vida-load \
  "node tests/load/seed/emulator-requestloan-check.mjs"
```

To drive k6 itself at the emulator, start it with `firebase emulators:start --only
functions,firestore,auth --project demo-vida-load` (same `REDIS_URL`), seed with
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node
tests/load/seed/seed-load-pool.mjs --count 200`, then:

```bash
k6 run --env TARGET_URL=http://127.0.0.1:5001/demo-vida-load/us-central1 \
       --env FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
       --env LOAD_TEST_PASSWORD=loadtest-emulator-only-password \
       --env POOL_SIZE=200 --env PROFILE=smoke tests/load/pipeline-load-test.js
```

**3. Seed the non-production target** (after H1):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=<key for STAGING_PROJECT>
export LOAD_TEST_PASSWORD="$(openssl rand -base64 24)"   # keep it for k6; never commit it
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --count 12500
```

The seed refuses: the production project (hard-coded, no flag overrides it), any project id
containing `prod`, a key that belongs to a different project, a missing `--project` when no
emulator is configured (`GCLOUD_PROJECT` is not enough), and a half-configured emulator. It is
idempotent — every id is `loadtest-emp-NNNNNN` / `loadtest-employer-NNNN` — and re-running it
restores every member's credit line.

**4. Check the target** — `curl <TARGET_URL>/api/health`, and the provider variables above.

**5. Smoke** (after H2):

```bash
k6 run --env TARGET_URL=https://us-central1-<STAGING_PROJECT>.cloudfunctions.net \
       --env LOAD_TEST_TARGET_ENV=staging \
       --env FIREBASE_PROJECT_ID=<STAGING_PROJECT> --env FIREBASE_APP_ID=<app id> \
       --env FIREBASE_API_KEY=<web api key> --env APP_CHECK_DEBUG_TOKEN=<debug token> \
       --env LOAD_TEST_PASSWORD="$LOAD_TEST_PASSWORD" \
       --env POOL_SIZE=12500 --env PROFILE=smoke tests/load/pipeline-load-test.js
```

Read the report before going on: `loans_succeeded` should be close to `loans_submitted`. All 401
means App Check or sign-in; `UNAVAILABLE` means Redis; `rate_limited_requests` climbing means the
members were already used today.

**6. Stages.** Either teardown + re-seed (steps 7 and 3), or keep going past the members the
smoke used: same command without `PROFILE=smoke`, plus `--env POOL_OFFSET=132`.
(12,500 − 132 is 52 short of the theoretical 12,420 ceiling; seed `--count 12600` to rule out
an abort in the last minute.)

**7. Teardown:**

```bash
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --teardown --dry-run   # what is in scope
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --teardown
```

It deletes pool accounts (uid **and** email must match), `employees/loadtest-emp-*`,
`employers/loadtest-employer-*`, loans whose `employeeId` is a pool uid (with
`underwritingDetail`), their `review_queue` rows, and `audit_log` rows whose `actorUid` is a pool
uid. Every row is re-checked before it is deleted, and a row that is not load-test data stops the
teardown. It does **not** touch Redis (`rl:loan:*` expire after 24 h), `ml_decisions`, or anything
a provider stored.

**8. Afterwards.** Delete the debug token (H2.5) and the service-account key; commit the report.

**Production.** The pool cannot be seeded there, by design. A production smoke (checklist B8)
therefore has only the legacy `AUTH_TOKEN` mode with a hand-made load-test employee, which gives
one accepted request and then refusals — a reachability check, not a load test. It stays a human
decision with ops sign-off:

```bash
k6 run --env TARGET_URL=https://us-central1-vida-finance.cloudfunctions.net \
       --env LOAD_TEST_ALLOW_PRODUCTION=I-HAVE-OPS-SIGN-OFF \
       --env APP_CHECK_TOKEN=<exchanged token> --env AUTH_TOKEN=<id token of the load-test employee> \
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
