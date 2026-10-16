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
| `localhost` / `127.0.0.1` / `[::1]` | label `emulator` — unless the URL path names the production project (`http://127.0.0.1:5001/vida-finance/…`), which is refused: an emulator started under the real project id serves functions that talk to production Firestore and Auth for every emulator that is not running |
| production — Gen-1: `*vida-finance.cloudfunctions.net`; Hosting: `vida-finance.web.app`, `vida-finance.firebaseapp.com`; **Gen-2 (Cloud Run), which never carries the project id:** `<service>-gd5fcu677q-<region code>.a.run.app` (the project's Cloud Run hash, e.g. `requestloan-gd5fcu677q-uc.a.run.app`) and `<service>-447766605132.<region>.run.app` (the project number, e.g. `requestloan-447766605132.us-central1.run.app`); Railway: `*-production*.up.railway.app` | refuses unless `LOAD_TEST_ALLOW_PRODUCTION=I-HAVE-OPS-SIGN-OFF` → label `production`. `npm run load-test*` refuse one step earlier: `tests/load/preflight.mjs` runs before k6 and exits 1 with the instruction instead of a k6 stack trace |
| any other remote host | refuses unless `LOAD_TEST_TARGET_ENV=staging` → label `staging`. A `*.run.app` host that is not one of the two production forms is *unknown*, not safe: the refusal says to confirm which project owns it first |

**The npm preflight reads the shell, not k6's flags.** `npm run load-test`, `load-test:smoke` and
`load-test:full` run `node tests/load/preflight.mjs && k6 run …`. The preflight sees `TARGET_URL`
only as a **shell variable** (`TARGET_URL=… npm run load-test:smoke`). A target passed as
`npm run load-test -- --env TARGET_URL=…` reaches k6 but not the preflight, which then stops with
"TARGET_URL is not set". When calling `k6 run --env …` directly (as the commands below do) there
is no preflight; `target.js` applies the same rules inside k6's init stage.

**Production's Firebase identifiers are refused too, whatever `TARGET_URL` says.**
`FIREBASE_PROJECT_ID=vida-finance` (or the project number `447766605132`, which Google accepts in
place of the id, or any id containing `prod`), a `FIREBASE_APP_ID` of project number
`447766605132`, or production's Web API key in `FIREBASE_API_KEY` stop the run at init:
always for the pool sign-in and for the App Check debug-token exchange, and for any run whose
target is not production. `TARGET_URL` only says where `requestLoan` is called; those three say
which project the pool's passwords and the debug token are sent to. No flag overrides it. The
signed-off production smoke (below) uses `APP_CHECK_TOKEN` + `AUTH_TOKEN` and none of the three.
`FIREBASE_PROJECT_ID` is shape-checked first: anything but lower-case letters, digits and hyphens
(`^[a-z0-9-]+$`) is refused before it is compared with production or put in the exchange URL — a
quoted, padded or upper-case id, `vida%2Dfinance`, `x/../vida-finance`. Write the id bare.

The setup step now **aborts** (it used to "proceed anyway") if `/api/health` is not 200.
Results land in `tests/load/results/<date>T<time>Z-<label>-<profile>-report.md` (committable) and
`…-summary.json` (gitignored raw output). The label is in the file name *and* the report header;
the time (UTC) is there so that a second run on the same day never replaces the first one's files.
An emulator target is written `127.0.0.1`, `localhost` or `[::1]`; any other raw address
(`0.0.0.0`, `127.1`, a LAN IP) is refused, and the production project is refused wherever it
appears in an emulator URL's path.
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
A VU alive for T seconds *starts* `floor(T / 5) + 1` iterations, so the ceiling is VU-seconds / 5
plus one start per VU ever started. `iterationUpperBound()` in `tests/load/seed/pool.js` computes
it, and `pool.test.mjs` fails if this table or the default pool size falls behind
`tests/load/config.js`:

| Profile | Iterations, upper bound | Pool to seed |
|---|---|---|
| `smoke` | 137 | `--count 200` |
| `full` | 12,448 (360 + 1,080 + 3,420 + 7,560 per stage, + 28 VU starts) | `--count 12500` (the default: 12,500) |

k6 ramps in whole VUs, so read these as ceilings to stay above, not predictions. (An earlier version
of this table said 132 / 12,420; it left out the one extra start per VU.)

Expect roughly 8,000–10,000 real iterations in `full` (6 s mean sleep plus request latency). When
the pool runs out k6 **aborts** rather than wrapping round. Employers get `maxActiveSlots` equal to
their member count (`maxActiveSlotsSource: 'ops_override'`), so the employer slot cap is never the
thing being measured.

**Which employer a member belongs to depends on the member's index only**
(`employerIndexFor` in `tests/load/seed/pool.js`): members are dealt round-robin over 50 employers
until each holds 50, then the next 50 employers start. `--count 200` is 50 employers of 4;
`--count 12500` is 250 employers of 50. So **a pool can be grown while loans are open**: a larger
`--count` appends members (and, past each 2,500, employers) and raises slot caps; it moves nobody.
This was not true before 2026-10-13: the assignment was `index % employerCount` with the employer
count derived from `--count`, so seeding 200 and then 12,600 moved almost every member to another
employer under loans that still named the old one. The `--employers` flag, which could do the same
by hand, was removed and is refused with that explanation. The layout itself changed with it
(`--count 200` was 4 employers of 50), so **a pool seeded by the code from before 2026-10-13 must
be torn down before it is seeded again**: seeding the new layout over it moves its members once,
under whatever loans are open. No such pool is known to exist — nothing was ever seeded outside
the emulator — but check `--teardown --dry-run` on a target you did not seed yourself. Two seeds
must not run against one target at the same time (the "never lower a cap" check reads and then
writes; it is not a transaction). A *smaller* `--count` deletes nothing
(the members above it keep their accounts and documents) and never lowers a slot cap; only teardown
removes anything.

Two consequences worth knowing before reading a result:

- **Same-day re-runs.** Teardown deletes the loans but cannot reset the Redis counters. After
  teardown + re-seed a uid can be used again (twice more that day). Otherwise skip the used members:
  `--env POOL_OFFSET=<members already used>` and a correspondingly larger `--count`.
- **The `2x_target` stage ramps to 28 VUs; it does not hold them.** Peak is about 240 requests/min
  at the very end of the run, and 280/min is never sustained. Proving "2x for 30 minutes" needs a
  hold stage in `tests/load/config.js`, and 280/min × 30 min = 8,400 more uids.

#### Keeping bureau / RiskSeal out of it

`requestLoan` reaches external providers only through two URLs in the functions environment:
`UNDERWRITING_SERVICE_URL` (the 6-stage pipeline, used only when `INTERNAL_SECRET` is also set) and
`ML_SERVICE_URL` (the inline gate). There is **no single "load-test mode" switch**, and
`/api/health` does not report how the target is configured, so the k6 script cannot verify any of
this (its old "verify mock mode" step only re-read the health endpoint and has been removed). The
operator checks the target's variables by hand before the run.

**Inventory.** Every outbound call on the `/underwrite` path of
`services/underwriting-service`, read from the code on 2026-10-13. `pool.test.mjs` fails when that
service reads a `*_URL` / `*_MOCK` / `*_MODE` / `*_PROVIDER` / `*_API_KEY` variable, or hard-codes a
host, that this section does not name.

| Provider | Reached from | Switch that exists | Left as it is, a load run… |
|---|---|---|---|
| Whole pipeline | `functions/src/index.ts` (`if (uwUrl && intSecret)`) | leave `UNDERWRITING_SERVICE_URL` **unset** on the target's functions | — nothing below this row is reachable. Simplest safe setup (A). |
| **Anthropic (Stage 5 risk narrative)** | `stages/stage5-review.js` → `https://api.anthropic.com/v1/messages`, directly from the underwriting-service | `ANTHROPIC_API_KEY` **unset on the non-prod underwriting-service**. There is no mock; an unset key returns a canned narrative without a request. | …makes **one paid LLM call per iteration that reaches Stage 5**. For the pool that is every iteration (see "What setup B measures"): up to ~12,448 calls in `full`. `.github/workflows/railway-setup-env.yml` copies the key to Railway when the secret exists. |
| MetaMap (Stage 5 AML, Stage 4 KYC, Stage 0 behavioural) | `metamap-client.js` → `METAMAP_BASE_URL`, default `api.getmati.com` | `METAMAP_MOCK=true` | …creates a real MetaMap verification per iteration (Stage 5 AML, MXN 8 each by the service's own cost table). The mock flags RFCs ending `XXX`/`YYY`/`ZZZ`; pool RFCs end `Lnn`. |
| Stage 4 KYC mode | `stages/stage4-kyc.js` | `KYC_MODE` **unset** (= `real`, which then honours `METAMAP_MOCK`) | `mock_pass` / `mock_fail` skip MetaMap but make Stage 4 approve / reject by itself; neither is wanted in a load run. |
| RiskSeal | `riskseal-client.js` → `RISKSEAL_BASE_URL` / `RISKSEAL_API_URL` with `RISKSEAL_API_KEY` | `RISKSEAL_MOCK=true` | …calls RiskSeal's scoring API once per applicant that reaches Stage 0. Mock: score 72 unless the RFC ends `XXX`/`YYY`. Unset URL without the mock: throws, recorded as skipped. |
| SAT blacklists via SW SAPiens | `stages/employer-a.js` → `sw-client.js` → `SW_BASE_URL`, default `https://services.sw.com.mx` | `EMPLOYER_SAT_PROVIDER` unset or `local` (must **not** be `sw`) | …with `sw`: two paid lookups per employer RFC against the live SAT provider. `local` reads two files from the service's own GCS bucket instead (no third party; a missing bucket is recorded as skipped). |
| DENUE (INEGI), REPSE (STPS) | `gov-apis.js` → `DENUE_API_URL` + `DENUE_API_KEY`, `REPSE_URL` | **no mock.** Unset → the lookup throws, is recorded as `skipped`, and the request escalates to Stage 5. | …if set: live government lookups for a company called `LOAD TEST 0000 — interno, no usar`. DENUE answers "not found" and the employer is **rejected** (`denue_not_found`), cached 24 h. |
| Other government lookups | `gov-apis.js`: `SAT_SOAP_CFDI_URL` (CFDI), `SEP_CEDULAS_URL` (cédulas), `REPUVE_URL`, `CONDUSEF_URL`, and `http://ip-api.com` (geolocation, hard-coded) | none | **Not reachable from `/underwrite` today:** `checkCFDI`, `checkCedula`, `checkREPUVE`, `checkCONDUSEF` and `checkGeolocation` have no caller outside their own tests. Unset behaviour if that changes: cédulas, REPUVE and CONDUSEF catch the failed request and return `skipped`; CFDI rejects (no guard); geolocation has no URL variable and would call `ip-api.com`. Leave the four variables unset. |
| Credit bureau (via SoftCrédito) | Stage 2 → `SOFTCREDITO_ADAPTER_URL` → adapter `POST /bureau/query` | `BUREAU_MODE=offline` **on a non-production adapter** (`lib/bureauFallback.js`) | …queries the real bureau for each applicant that reaches Stage 2. `offline` never calls it and returns a neutral record marked `_fallback`. |
| Belvo | `belvo-client.js` (Stage 0 INFONAVIT, Stage 2 IMSS + AFORE) → `BELVO_BASE_URL` | leave `BELVO_BASE_URL` unset with `NODE_ENV` ≠ `production` → `https://sandbox.belvo.com` | …still sends several requests per applicant that reaches Stages 0 and 2, with synthetic CURPs, to Belvo's sandbox: a third party, though not live data. Whether a load run may do that is Belvo's call, not ours. |
| ML service | functions (`ML_SERVICE_URL`, inline gate) and underwriting-service Stages 0, 2, 4 (same variable) | none. Point it at a non-production ml-service, or leave it unset. | `services/ml-service/main.py` makes its own Anthropic calls when *its* `ANTHROPIC_API_KEY` is set; unset it there too. |
| Underwriting-service state | `index.js` (`FIREBASE_SERVICE_ACCOUNT` / `_B64`), `REDIS_URL` | must be the **non-production** project's service account and a non-production Redis | Stage 5 writes `review_queue` rows with *this* service account. A staging service holding the production key writes the load test's rows into production's ops queue. |
| Alerts | `services/shared/alerting.js` (`SLACK_WEBHOOK_URL`, `PAGERDUTY_ROUTING_KEY`) | unset on the non-production services, or a test channel | …a run that produces 5xx or rate-limit errors pages whoever is on call. |

Document AI (`docai-client.js`) and `payroll-software.js` are not called from the pipeline.
`requestLoan` itself sends no notification, and pool members have no phone and a
`@loadtest.invalid` address, so nothing in a run can reach a real person.

Gaps, stated plainly:

- **None of these switches is refused in production, and none is confirmed from outside.** Each
  takes effect wherever it is set (`railway-setup-env.yml` pins production's `RISKSEAL_MOCK` to
  `false`); a run cannot ask the target what it is configured to do.
- **Anthropic, DENUE, REPSE and the ML service have no mock** — only "unset".
- **This inventory covers the underwriting-service's `/underwrite` path.** In `softcredito-adapter`
  and `ml-service` only the bureau mode and the Anthropic key were read; the rest of those two
  services was not analysed.

**What setup B measures today — less than its name says.** Employer screening runs first. With
DENUE and REPSE unset (the only safe setting) both are `skipped`, the request escalates straight to
Stage 5, and that verdict is cached per employer RFC for 24 h (`employer-a:<rfc>`). With them set,
DENUE rejects the pool's employers. Either way **no pool applicant reaches Stages 0–4**: RiskSeal,
Belvo, the bureau and the ML scores are not exercised at all. A setup-B run is employer screening
(a cache hit after the first request per employer) + Stage 5 (MetaMap AML, the Anthropic call, one
`review_queue` write), and every accepted loan is `under_review`. Getting past employer screening
needs a DENUE/REPSE stub that does not exist; that is a code change, not a configuration.

The two setups:

- **A — functions only. The one that is cleared to run.** `UNDERWRITING_SERVICE_URL` unset. With
  `ML_SERVICE_URL` also unset the inline gate fails closed and every accepted loan is
  `under_review` with a `review_queue` row. This measures auth, the limiter, Firestore and the
  loan transaction. It is what the emulator check in step 2 runs.
- **B — full pipeline. NOT cleared to run.** Do not point a load run at a target whose functions
  have `UNDERWRITING_SERVICE_URL` set until a named person has checked **every row of the table**
  on the deployed services and recorded it in the run report: `ANTHROPIC_API_KEY` unset (both
  services), `METAMAP_MOCK=true`, `KYC_MODE` unset, `RISKSEAL_MOCK=true`,
  `EMPLOYER_SAT_PROVIDER` not `sw`, `DENUE_API_URL` / `REPSE_URL` and the four other gov URLs
  unset, `BUREAU_MODE=offline` on a non-production adapter, `BELVO_BASE_URL` unset, a
  non-production service account and Redis, alerts off. Even then it measures only what the
  paragraph above says, and it leaves the residue listed under step 7.
  Nothing the k6 script guards changes this. It refuses production targets and production
  Firebase identifiers, malformed project ids, a missing App Check token and an expired one it
  cannot refresh — but it cannot see how the target's services are configured, so none of the
  rows above is checked by it. Only a real staging run with that checklist recorded can clear B.

#### Needs a human first (console and credential actions — not automated, not done)

**H1. A non-production target.** None exists today (see above). Required of it:

- a Firebase project that is not `vida-finance` **and whose project id does not contain `prod`**
  (not `vida-prod-test`, not `funpay-preprod`). Decide this when the project is created — a
  project id cannot be changed afterwards. The seed (`tests/load/seed/guard.mjs`) and the k6
  script (`tests/load/target.js`) both treat any id containing `prod` as production and refuse it,
  with no override: over-refusing costs a rename now, under-refusing costs real borrowers.
  The functions are deployed there from the commit under test;
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
   A failed exchange is **not** retried on every iteration: each VU waits 5 s, then 10 s, 20 s …
   up to 5 min before asking again, and keeps using the token it has **while that token is still
   valid**. Once the token's `ttl` has run out, the next request tries the exchange at once and,
   if that fails too, the run is **aborted** — an expired token is never sent (it used to be,
   for as long as the refresh kept failing). With no token at all, a
   400 / 401 / 403 / 404 from the exchange (wrong debug token, app id, key or project) aborts the
   run at once, and so do five failures in a row — otherwise every request would be a 401 that
   uses up a pool member.
   To check the token by hand first (one request to the App Check API, not to the app):

   ```bash
   curl -s -X POST -H 'Content-Type: application/json' \
     -d "{\"debug_token\":\"$APP_CHECK_DEBUG_TOKEN\"}" \
     "https://firebaseappcheck.googleapis.com/v1/projects/$FIREBASE_PROJECT_ID/apps/$FIREBASE_APP_ID:exchangeDebugToken?key=$FIREBASE_API_KEY"
   # → {"token":"eyJ…","ttl":"3600s"}
   ```

5. **Delete the debug token in the console when the run is over.**

The exchange and the pool sign-in have **never been run against a real project** — the smoke
run in step 5 is their first real test. What exists is unit tests (`tests/load/seed/pool.test.mjs`)
that drive both from the run's environment to the outcome through a *mocked* endpoint: the mock
checks each request against the Google REST contract (URL, `key`, body) and answers in Google's
own error format — success, retryable failures (no answer, 429, 5xx: back off, then recover) and
terminal ones (400 / 401 / 403 / 404: abort; a sign-in that gets no answer twice: counted as a
failed sign-in). They prove the script's side of the contract as written down, not that Google
answers that way for the target project, its API-key restrictions or its quotas.

#### Environment variables the k6 script reads

| Variable | Meaning |
|---|---|
| `TARGET_URL` | Functions base URL; validated by `tests/load/target.js` (table above). `STAGING_URL` is the old name. |
| `LOAD_TEST_TARGET_ENV=staging` | Required for any remote host that is not production. |
| `POOL_SIZE` | The `--count` the pool was seeded with. |
| `POOL_OFFSET` | First pool index to use (default 0). |
| `LOAD_TEST_PASSWORD` | The password the pool was seeded with. |
| `FIREBASE_API_KEY` | Web API key of the target project (sign-in, and the App Check exchange). Production's key is refused. |
| `APP_CHECK_DEBUG_TOKEN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | Debug token and what is needed to exchange it. Production's project id and app id are refused; a project id that is not `^[a-z0-9-]+$` is refused. |
| `APP_CHECK_TOKEN` | Alternative: an already-exchanged token. Expires; smoke profile only. |
| `FIREBASE_AUTH_EMULATOR_HOST` | Emulator only: sign in against the Auth emulator instead of Google. |
| `PROFILE` | `smoke` or `full` (default), lower case. Any other value is refused at init (it used to run the full two hours). |
| `AUTH_TOKEN` | Legacy, no pool: one uid, so one accepted request and then refusals. |

#### Order of operations

**0. Install k6** (v0.38 or newer). macOS: `brew install k6`. Other systems:
<https://grafana.com/docs/k6/latest/set-up/install-k6/>. Check with `k6 version`. It was installed
on the dev machine on 2026-10-13 (Homebrew, k6 v2.3.0) and the script ran under it for the first
time that day, against the emulator only — see "Emulator smoke — 2026-10-13" below.

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

The second command refuses to start if `UNDERWRITING_SERVICE_URL` or `ML_SERVICE_URL` is set in
the shell, in a `functions/.env*` file or in `functions/.secret.local`: the emulated functions are
handed all three, and the "local" check would then post synthetic applicants to the real service.
Run it from a clean shell (`env -u UNDERWRITING_SERVICE_URL -u ML_SERVICE_URL -u INTERNAL_SECRET …`).

**To drive k6 itself at the emulator** (smoke profile; this is the sequence that was run on
2026-10-13). Terminal 1 — Redis and the emulators, with the provider variables removed from the
environment the functions inherit:

```bash
redis-server --port 6390 --save '' &
(cd functions && npm ci && npm run build)
env -u UNDERWRITING_SERVICE_URL -u ML_SERVICE_URL -u INTERNAL_SECRET -u GOOGLE_APPLICATION_CREDENTIALS \
  REDIS_URL=redis://127.0.0.1:6390 \
  firebase emulators:start --only functions,firestore,auth --project demo-vida-load
```

Terminal 2 — seed, wait for the creation triggers, run, tear down:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
node tests/load/seed/seed-load-pool.mjs --count 200
sleep 15   # onEmployeeDocCreated runs once per member (claim + credit line)

k6 run --env TARGET_URL=http://127.0.0.1:5001/demo-vida-load/us-central1 \
       --env FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
       --env LOAD_TEST_PASSWORD=loadtest-emulator-only-password \
       --env POOL_SIZE=200 --env PROFILE=smoke tests/load/pipeline-load-test.js

node tests/load/seed/seed-load-pool.mjs --teardown
redis-cli -p 6390 flushall   # this Redis is yours; it resets the 3/day counters for the next run
```

The same run through npm — the preflight and k6 both read the shell here, so every value is a
shell variable: `TARGET_URL=http://127.0.0.1:5001/demo-vida-load/us-central1
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 LOAD_TEST_PASSWORD=loadtest-emulator-only-password
POOL_SIZE=200 npm run load-test:smoke`.

Things the real run showed that are worth knowing before you start:

- The Functions emulator prints *"Application Default Credentials detected. Non-emulated services
  will access production using these credentials"* when `gcloud auth application-default login`
  has been done on the machine. With a `demo-*` project there is no such project to reach, and
  in the emulator log of the run (290 `requestLoan` executions and the seed's triggers) no call
  to anything but `127.0.0.1` appears. It is still the reason the project id must be `demo-*` and
  never a real one (`target.js` refuses an emulator URL that names the production project).
- If ports 5001 / 8080 / 9099 are taken, pass `--config <file>` with other ports and use those in
  the three variables. The 2026-10-13 run did (5011 / 8181 / 9109, emulator UI off).
- A member that was already used does not always answer `DUPLICATE_LOAN_APPLICATION`. The credit
  check runs before the open-loan guard, so when the first loan left less credit than the second
  request asks for the answer is `INVALID_ARGUMENT` ("El monto excede tu crédito disponible").
  The report counts the two separately.

#### Emulator smoke — 2026-10-13 (what it does and does not prove)

The first time `tests/load/pipeline-load-test.js` ran under k6. Report:
`tests/load/results/2026-10-13-emulator-smoke-report.md`.

**Setup.** k6 v2.3.0 (darwin/arm64), firebase-tools 15.26.0, Node 22, functions built from this
branch; emulators `functions,firestore,auth`, project `demo-vida-load`; a local Redis; no
`UNDERWRITING_SERVICE_URL`, `ML_SERVICE_URL` or `INTERNAL_SECRET` (setup A); pool of 200; `smoke`
profile (5 minutes); App Check by the emulator-only unsigned placeholder.

**Result — three full smoke runs, each on a freshly seeded pool with the Redis counters cleared.**

| Run | Iterations | Sign-in 200 | `requestLoan` 200 | Checks | Failed | p50 / p95 / max |
|---|---|---|---|---|---|---|
| 1 (script as merged) | 90 | 90 | 90 | 362 / 362 | 0 | 65 ms / 177 ms / 5,996 ms |
| 2 (after the report fixes below) | 90 | 90 | 90 | 362 / 362 | 0 | 49 ms / 299 ms / 1,145 ms |
| 3 (final script, via `npm run load-test:smoke`) | 91 | 91 | 91 | 366 / 366 | 0 | 43 ms / 97 ms / 155 ms |

Every accepted loan was `under_review` (the inline ML gate has no service to call). After run 3
the emulator held 91 loans across all 50 employers, 91 `review_queue` rows, 182 `audit_log` rows,
and Redis 91 `rl:loan:*` keys; teardown reported exactly those and left every collection empty.
90–91 iterations against the ceiling of 137: in runs 1 and 2 (the two with raw k6 output) k6 never
had more than 4 VUs running — the fifth starts only as the run ends — and run 2 peaked at 28
requests in one minute.

**Refusal paths, provoked on purpose** with a tiny `POOL_SIZE` on members that already held a loan
(each run ends with k6's abort "User pool exhausted", exit 108, as designed):

| What was done | Answer |
|---|---|
| 8 members used a second time | 5 × HTTP 400 `FAILED_PRECONDITION` `DUPLICATE_LOAN_APPLICATION`, 3 × HTTP 400 `INVALID_ARGUMENT` (amount over the credit left) |
| 3 members, third call of the day | 3 × HTTP 400 `DUPLICATE_LOAN_APPLICATION` |
| the same 3, fourth call | 3 × HTTP 429 `RESOURCE_EXHAUSTED` ("Too many loan requests today") |
| 2 members, wrong pool password | 2 × sign-in HTTP 400, then 2 × HTTP 401 `UNAUTHENTICATED` |
| `FIREBASE_PROJECT_ID=vida-finance` with a debug token; an emulator URL naming `vida-finance` | refused at init (exit 107), no request sent |

**What the first run changed in the script.** Nothing failed — run 1 was 90 of 90. But its report
showed three things that were not true, and they were fixed before runs 2 and 3:

- "Per-Stage Latency" printed validation / Firestore / queue figures. No function sends the
  `X-Stage-*-Ms` headers they were meant to come from; the script was filling them with 10% / 40% /
  20% of the total. The section now reads "not instrumented", and the stage thresholds in
  `config.js` are marked as passing on no data.
- "2x target without errors: PASS" on a profile that never reaches the target rate. It is `N/A`
  outside the `full` profile, and an emulator report says in its own text that it closes nothing.
- Failed requests other than 429 / timeout / 5xx were not counted anywhere. The report now has
  buckets for 401, `FAILED_PRECONDITION`, `INVALID_ARGUMENT`, "other" and failed pool sign-ins.

**Zero failures is not a stable property of a smoke run.** At ~90 iterations one failed request
is over the 1% threshold, and k6 then exits 99. A review re-run the same day (same setup, ports
5031 / 8231 / 9139, load average ~150) measured 89 iterations, 88 accepted and 1 failed: the Auth
emulator reset one sign-in connection (status 0), which the script counted as one sign-in failure
and one HTTP 401. Since then a sign-in that gets no HTTP answer is sent once more
(`sendWithOneTransportRetry`, inside `signInPoolMember`); that retry has unit tests only and has not been seen to fire in a
run. The committed report above is run 3; a new run writes a time-stamped file and leaves it alone.

Run 4, after those changes (same setup, ports 5041 / 8241 / 9141, via `npm run load-test:smoke`,
load average 48 at the start and 157 at the end): 90 iterations, 90 accepted, 0 failed, no sign-in
retried, p50 61 ms / p95 115 ms / max 2,286 ms; teardown removed 90 loans, 90 `review_queue` and
180 `audit_log` rows. Report: `tests/load/results/2026-10-13T140725Z-emulator-smoke-report.md`.
Under k6 the new refusals each stopped at init (exit 107, no request sent): `PROFILE=Full`,
`FIREBASE_PROJECT_ID=447766605132`, a `0.0.0.0` target declared as staging, and an emulator URL
with `%76ida-finance` in its path.

**It proves:** the script loads and runs under a current k6; the seed, the k6 side and
`requestLoan` agree on ids, amounts, sign-in and the callable protocol; one uid gives one accepted
loan; the refusals above are told apart; teardown removes what a run leaves.

**It does not prove — none of this was exercised:**

- any latency or throughput of the platform. The numbers are one laptop's emulators, taken while
  the machine was busy with other work (run 1's 6-second maximum is a single request); they are
  not a baseline and must not be compared with a deployed run;
- App Check. The emulator does not verify tokens, and the debug-token exchange (and its new
  back-off) has still **never been run against a real project** — only its unit tests have run;
- Google's sign-in endpoint and its quotas (the Auth emulator answered every sign-in);
- the `full` profile: 28 VUs, ~12,000 members, two hours; Firestore contention and quotas; Cloud
  Functions cold starts and concurrency; Redis over a network;
- setup B, or any provider at all;
- anything after the loan document exists (ops review, disbursement, notifications).

**B8 stays open.** Only a `staging` or `production` report at the `full` profile can close it,
and that still needs H1 and H2.

**3. Seed the non-production target** (after H1):

```bash
export GOOGLE_APPLICATION_CREDENTIALS=<key for STAGING_PROJECT>
export LOAD_TEST_PASSWORD="$(openssl rand -base64 24)"   # keep it for k6; never commit it
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --count 12500
```

The seed refuses: the production project (hard-coded, no flag overrides it), any project id
containing `prod` (see H1), a key that belongs to a different project, a missing `--project` when
no emulator is configured (`GCLOUD_PROJECT` is not enough), and a half-configured emulator. It is
idempotent — every id is `loadtest-emp-NNNNNN` / `loadtest-employer-NNNN`, and member N always
belongs to the same employer — and re-running it restores every member's credit line. Re-running
it with a larger `--count` adds members without moving the existing ones, so it is safe while
loans from an earlier run are still open ("uid-pool arithmetic" above).

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

Read the report before going on: `loans_succeeded` should be close to `loans_submitted`. The
"Error Breakdown" names the cause: `Unauthenticated (401)` is App Check or sign-in (and "Pool
sign-in failures" says which); `Refused (FAILED_PRECONDITION)` / `Refused (INVALID_ARGUMENT)` on
every request means the members already hold a loan (tear down, or use `POOL_OFFSET`);
`Rate limited (429)` means they were already used three times today; 5xx with `UNAVAILABLE` means
Redis. "Per-Stage Latency" reads "not instrumented": only end-to-end latency is measured.

**6. Stages.** Either teardown + re-seed (steps 7 and 3), or keep going past the members the
smoke used: same command without `PROFILE=smoke`, plus `--env POOL_OFFSET=<n>` where `<n>` is
**"Total submitted" from the smoke report** (`loans_submitted`; at most 137), not a figure from
this page. The pool must then hold `<n>` + 12,448: seed `--count 12600` in step 3 if you plan to
run both without a teardown in between (12,600 − 137 = 12,463), otherwise the run can abort with
"User pool exhausted" in its last minute.

**7. Teardown:**

```bash
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --teardown --dry-run   # what is in scope
node tests/load/seed/seed-load-pool.mjs --project <STAGING_PROJECT> --teardown
```

It deletes:

- pool accounts (uid **and** email must match);
- `employees/loadtest-emp-*` and `employers/loadtest-employer-*`;
- loans whose `employeeId` is a pool uid, with their `underwritingDetail`;
- `review_queue` rows whose `loanId` is one of those loans — the rows `requestLoan` writes when
  the inline ML gate is unavailable (setup A);
- `review_queue` rows whose `applicantRfc` is a pool RFC (`LTXXYYMMDDLnn`) — the rows Stage 5 of
  the underwriting-service writes (setup B). Those carry **no loan id**: `requestLoan` sends
  `/underwrite` the applicant, the employer and the amount, so the row's `loanId` is the
  pipeline's own correlation id (`uw-…`), and its `applicantName` is the literal
  `undefined undefined` (Stage 5 reads `firstName` / `lastName`, `requestLoan` sends `fullName`).
  The RFC is the only field that identifies them. No real taxpayer's RFC has that shape (second
  letter `T`, where a person's RFC has a vowel or `X`);
- `audit_log` rows whose `actorUid` is a pool uid.

Every row is re-checked before it is deleted, and a row that is not load-test data stops the
teardown. If Auth refuses some deletions (`deleteUsers` allows about one call of 1,000 accounts
per second; the CLI waits between batches) the command prints `TEARDOWN INCOMPLETE`, exits 1, and
is safe to run again.

It does **not** touch:

- Redis on the functions side: `rl:loan:*` (expire after 24 h);
- after a setup-B run, the underwriting-service's Redis cache: `employer-a:LTE…` (one key per
  pool employer, 24 h);
- `ml_decisions`, and anything a provider stored (a setup-B run without `METAMAP_MOCK` leaves
  MetaMap verifications, and their webhooks add `metamap_shadow_log` / `incident_log` rows —
  with the mock on, nothing calls MetaMap and neither collection is written).

Do not run teardown in the same minute as a seed on a deployed target: `onEmployeeDocCreated`
events still in flight then find no account and no document and log errors
(`There is no user record…`, `no entity to update`). Harmless, but it is noise in the error log
and can trip an error-rate alert. Leave a few minutes, or expect it.

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

After the run: commit `tests/load/results/<date>T<time>Z-<label>-<profile>-report.md`; only a
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
