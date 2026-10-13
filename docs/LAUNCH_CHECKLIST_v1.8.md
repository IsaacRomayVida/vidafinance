# VIDA Finance Launch Checklist v1.8

> **Last measured:** 2026-08-03 against `main` @ `4581cd6`
> **Re-measured (partial):** 2026-10-13 against `hardening/production-readiness` @ `7943d6a`, plus
> the `swarm/launch-gaps` fixes on top of it — see the *2026-10-13* notes in tables A and D.
> **Status:** partially verified — see the two tables below. **Not signed off.**
>
> ### Why this file replaces `LAUNCH_CHECKLIST_v1.7.md`
>
> v1.7 was dated 2026-03-21 and declared **"Status: All items verified"**, with every one of its
> ~30 boxes ticked. On 2026-08-02 an audit of the same tree found eight defects, two of them P0:
> every loan request was rejected with `Plazo inválido`, and borrowers were quoted an 8% fee and
> charged 30% (`outputs/CRITICAL_DEFECTS.md`). A document asserting a green loan wizard while the
> loan wizard could not complete a single request is worse than no document — it is a sign-off
> surface for a launch that would have failed on first contact with a borrower.
>
> The defect was not the ticks being wrong on the day. It is that **a tick carries no evidence and
> no date**, so it cannot be re-checked and never expires. v1.8 fixes the format, not just the
> values:
>
> - Every claim this repo can prove carries **the command that proves it** and the date measured.
> - Every claim the repo *cannot* prove is moved to a second table and named as needing a human.
>   It is not ticked here, by anyone, ever.
> - A claim with no evidence column is not "unknown"; it is **not done**.
>
> Re-measure before any launch sign-off. If the date above is stale, this file is a hypothesis.

---

## A. Machine-verified — evidence attached

Measured 2026-08-03 against `4581cd6`. Reproduce with the command in the evidence column.

| # | Item | State | Evidence |
|---|---|---|---|
| A1 | Full CI green on `main` | ✅ | Run `30798414583` — **10/10 jobs**, incl. both HARD gates (Firestore Rules, Loan Flow E2E). `gh run view 30798414583` |
| A2 | Production deploy succeeds | ✅ | Run `30798414554` — functions, rules, indexes, hosting all `Deploy complete!`. Not the first green one: that was `30793707586` (2026-08-03 ~08:12Z), the first since 2026-07-31 (see D1) |
| A3 | ESLint + TypeScript zero errors | ✅ | CI job *Lint, Typecheck & Test* + *Frontend Lint, Typecheck & Build*, both green in `30798414583` |
| A4 | Unit / integration / rules tests pass | ✅ | CI `30798414583`; `functions` suite 431/431 local at `361b09c` |
| A5 | No `continue-on-error` in CI — every suite is a hard gate | ✅ | `grep -n continue-on-error .github/workflows/ci.yml` → 2 hits, **both comments forbidding it**, zero directives |
| A6 | Zero references to Truora / Incode / Sardine / EFL in shipped code | ✅ | `grep -rniE "truora\|incode\|sardine\|\bEFL\b" services/ functions/src/ public-v2/src/` → 2 hits, both in `ml-service/tests/test_prompt_loader.py` asserting their **absence**. The guard is the only mention |
| A7 | The 8 P0/P1/P2 defects of 2026-08-02 are fixed | ✅ | `outputs/CRITICAL_DEFECTS.md` audit table, re-verified against source 2026-08-03T01:30Z; P0-1 and P0-2 re-read again this pass |
| A8 | Loan pricing has one server-side source of truth | ✅ | `functions/src/index.ts:395,449,657` all read `loanConfig.feeRate`; `feeRate` frozen onto the loan at creation so a later config change cannot reprice a signed loan. ADR-002 |
| A9 | Stage-3 auto-approve breakdown persisted for ops | ✅ | `functions/src/index.ts:608-638` writes `underwritingDecision` (decision, reason, allPass, all 12 conditions with value/bound/source). Fail-soft: omitted, never blocking |
| A10 | Every service exposes `/health` | ✅ | 7/7: payment-server, softcredito-adapter, notification-service, pdf-generator, ml-service, underwriting-service, registry-service |
| A11 | All 7 services are health-checked by the deployed `systemHealthCheck` | ✅ (code) | 2026-10-13: `functions/src/index.ts` re-exports `scheduled/systemHealthCheck.ts`, which probes all 7 (`MONITORED_SERVICES`). Pinned by `cd functions && npx jest src/scheduled/__tests__/systemHealthCheck.test.ts` (7 tests, incl. a wiring guard). See D2. Whether prod *answers* is still B10 |
| A12 | Lighthouse runs in CI on the launch-mode marketing pages | ✅ (job) / ❌ (≥90) | 2026-10-13: CI job *Lighthouse (marketing pages)*, config `public-v2/lighthouserc.json`. a11y/best-practices/SEO ≥0.9 are a hard gate; **performance measures 0.70–0.75** and is a `warn`. See D3 and B9 |

**2026-10-13 re-measure of table A** (against `7943d6a`; rows not listed were not re-measured):

- **A1/A3/A4** — CI run `35455293322` on `7943d6a`: 13/13 executed jobs green (both HARD gates
  included); *Verify production endpoints* skipped (runs only on `refs/heads/main`). `gh run view 35455293322`.
  Locally on `swarm/launch-gaps`: `cd functions && npm run typecheck && npm run typecheck:tests &&
  npm run lint && npm run test:ci` → 58 suites, 997/997 tests. The new CI jobs added on this branch
  (D3, D4) have **not** run in Actions yet — re-check on the release commit.
- **A5** — `grep -n continue-on-error .github/workflows/ci.yml` → 2 hits, both comments forbidding it.
- **A6** — same grep → 1 file, `services/ml-service/tests/test_prompt_loader.py` (the absence guard).
- **A8** — line numbers moved: `loanConfig.feeRate` is read at `functions/src/index.ts:744,798` and
  frozen onto the loan at `:1390`.
- **A9** — the breakdown now lives in the `loans/{id}/underwritingDetail/detail` subcollection
  (`functions/src/index.ts:1174-1180`), not a field on the loan; read by `admin/getReviewQueue.ts`.
- **A10** — `/health` routes: `underwriting-service/index.js:117`, `notification-service/src/index.ts:27`,
  `pdf-generator/index.js:368`, `payment-server/index.js:175`, `registry-service/index.js:155`,
  `ml-service/main.py:187`, `softcredito-adapter/index.js:205`.

---

## B. Not verifiable from this repo — needs a named human

These were **all ticked in v1.7 with no evidence**. Nothing in the repo can confirm them: they are
live-infrastructure and third-party facts. They are listed unticked on purpose.

| # | Item | Owner | Why the repo cannot answer it |
|---|---|---|---|
| B1 | Production env vars set (MetaMap, Belvo, SoftCrédito, RiskSeal) | Isaac / ops | Values live in Railway + GitHub secrets, never in-tree |
| B2 | All internal service secrets rotated off staging values | Isaac / ops | A secret's *value* is invisible here; only its *presence* is enforced (boot-time `throw`, P1-4) |
| B3 | MetaMap webhook secret is the production value | Isaac / ops | Same as B2 |
| B4 | Redis memory limit configured (OOM guard) | Isaac / ops | Railway runtime config |
| B5 | Firestore write quota raised above the 500/sec default | Isaac / ops | GCP quota console |
| B6 | Hosting traffic split (90% React / 10% legacy) | Isaac / ops | Firebase Hosting runtime config |
| B7 | Alerting rules configured **and a test alert delivered** | Isaac / ops | Delivery is observable only in the alert sink |
| B8 | Load test passed at 2x target throughput | Isaac / ops | **Not run anywhere.** No artifact in `tests/load/results/`. 2026-10-13: the script no longer defaults to production (it did); runnable once App Check token + seeded employee pool exist — see D3 and `docs/runbooks/scaling.md` § Load test. Only a `staging`/`production` `full`-profile report can close it |
| B9 | Lighthouse ≥90 on marketing pages | Frontend owner | **Measured, and it fails on performance.** 2026-10-13, local Chrome, LHCI 0.15.1 mobile defaults, `VITE_LAUNCH_MODE=live`, median of 3: `/` perf 0.72, `/employers` 0.74, `/employees` 0.71, `/about` 0.73 (LCP 5–7 s); a11y 0.95–0.96, best-practices 1.0, SEO 0.91. Now in CI (A12). Needs a perf fix, then promote the `warn` to `error` |
| B10 | The 5 live Railway services actually return 200 | Isaac / ops | A10 proves the route **exists in code**; only prod proves it **answers**. Do not conflate these — v1.7 did |
| B11 | Champion/challenger/autoencoder models deployed; PSI-CSI baselines saved | Isaac / ops | Model registry state is external. `docs/ML_MODEL_STATUS.md` is the closest in-tree record |

---

## C. Sign-off

No signature until **table A is re-measured on the release commit** and **every row of table B is
initialled by its owner**. A blank cell is "not done", never "assumed fine" — that assumption is
precisely what v1.7 encoded.

| Role | Name | Date | Commit measured | Signature |
|------|------|------|-----------------|-----------|
| Engineering Lead | | | | |
| Product Owner | | | | |
| Compliance Officer | | | | |
| QA Lead | | | | |

---

## D. Open gaps found while measuring

**D1 — Two 403s blocked prod deploys for ~25 h; neither cleared itself, and the second left prod
half-deployed.** *(diagnosed 2026-10-13 — the original v1.8 text is kept below and is wrong in
several places, see the update; the billing half still needs Isaac to confirm)*
Production deploys failed for ~3 days on an HTTP 403 write refusal. Run `30798414554` (2026-08-03
08:42Z) shows the preflight canary getting **200** and the full deploy landing. No config change
was made on our side, so the fix was upstream — billing or IAM. Worth confirming *which*, because
an unexplained recovery can un-recover. The preflight canary itself is the win: it aborts before
any partial write, so three days of failure changed nothing in prod. *(Wrong for the index phase —
see item 3 of the update.)*

*Update 2026-10-13.* Re-measured from every `main` push run of *VIDA Platform — Deploy*
2026-07-28..08-04 (`gh run list --workflow 246929693 --created …`, then `gh run view <id> --log-failed`)
plus read-only `gcloud` on `vida-finance`. Several statements above were wrong: it was **~25 h, not
~3 days**, it was **two different 403s back to back**, neither "fixed itself", and the first fully green
deploy was `30793707586` (2026-08-03 ~08:12Z), not `30798414554`, and the canary did **not** keep
prod untouched: it protected only the billing phase, and the index phase left prod partly deployed for
~14 h, 2026-08-02 18:19Z → 08-03 08:12Z (item 3). The 2026-07-30 failures are unrelated
(`onContactCreated` trigger-type change, no 403). No `main` deploy ran between the last good one,
`30593318133` (2026-07-31 00:21Z), and 2026-08-02 05:38Z. *Deploy Firebase* (245647385) ran once in the
window (2026-07-30, dispatch, green).

1. **Billing refusal on Cloud Functions writes — 2026-08-02 05:42Z → 17:42Z (observed).** Every
   functions upload got
   `POST cloudfunctions.googleapis.com/v2/projects/***/locations/us-central1/functions:generateUploadUrl`
   → `HTTP Error: 403, Write access to project '***' was denied: please check billing account associated
   and retry`. First seen in `30734473564` (05:42Z, 256 identical 403s, then the 6 h job limit); last
   seen in `30759300648` (preflight canary 403 at 17:42Z). The next run, `30760060720`, proved the
   billing refusal had cleared: canary **200** at 18:04:00Z ("Preflight OK … (HTTP 200)"). It then
   skipped `storage.rules` (unchanged), uploaded `firestore.rules` (not released — no "released rules"
   line), and at 18:04:05Z failed on the index 403 of (2) below and exited 1. **No function deployed
   in that run.** The first function writes that landed were in `30760666827` (18:19:47Z, run later
   cancelled), then `30760796507` (18:23Z, cancelled) and `30761707373` (18:48Z). `deploy.yml` did not change in between (the only
   commit, `1cf01b6`, is app code, rules and an index — no credentials or API calls), and the secret `FIREBASE_SERVICE_ACCOUNT_PRODUCTION`
   was last set 2026-03-22 (`gh secret list`), so the same principal went from refused to accepted.
   During the outage `billingInfo` reported `billingEnabled: true` (commit `e8f0ca4`, run `30756695646`)
   and Firestore REST said "requires billing to be enabled" (commit `030b993`). Today:
   `gcloud billing projects describe vida-finance` → `billingAccounts/01B681-29512A-745C5D`,
   `billingEnabled: true`. **Strongest supported hypothesis:** the linked billing account was in a bad
   state (suspended / payment failed / delinquent) without being unlinked, and a human cleared it on
   Sunday 2026-08-02 between 17:42Z and ~18:03Z. **Not proven** — the deploy SA cannot read the
   billing account or any audit logs (`gcloud billing accounts describe` and `gcloud logging read` both
   `PERMISSION_DENIED`). **Missing evidence, and who can get it:** Isaac (`roles/owner`), or whoever
   administers billing account `01B681-29512A-745C5D` — its payment / transaction history and any
   "account suspended / reinstated" emails for 2026-07-31..08-02, and its audit log
   (`gcloud logging read 'timestamp>="2026-07-31T00:00:00Z" AND timestamp<="2026-08-02T19:00:00Z"'
   --billing-account=01B681-29512A-745C5D`). That also gives the true start, which runs cannot: anywhere
   between 07-31 00:21Z and 08-02 05:42Z.
2. **IAM refusal on Firestore index creation — 2026-08-02 18:04Z → 2026-08-03 07:19Z.** Once
   functions were writable, the index step got
   `POST firestore.googleapis.com/v1/projects/***/databases/(default)/collectionGroups/audit_log/indexes`
   → `HTTP Error: 403, The caller does not have permission` in every run that reached it — 32 runs,
   `30760060720` … `30791906109`, last at 07:19:22Z. **Root cause (proven):** a latent IAM gap exposed by code. `1cf01b6`
   (#402, 2026-08-02 17:58Z) was the first commit in the window to add a composite index (on
   `audit_log`); before it, the index step was a no-op that "deployed successfully" even mid-billing
   outage (e.g. `30751081837` 14:02Z, `30757753296` 17:00Z), because the deploy SA could list indexes but
   not create them. It cleared with **no repo change** (`d1193f1`→`01585bc` touch only `ml-service`),
   and `30793707586` logged `deployed indexes … successfully` at 08:12:03Z. Today
   `gcloud projects get-iam-policy vida-finance` shows `roles/datastore.indexAdmin` bound to
   `firebase-adminsdk-fbsvc@vida-finance.iam.gserviceaccount.com` (the only non-owner principal holding
   it; the fix #414 had asked for exactly this grant). So someone granted it between 07:19Z and 08:12Z on
   2026-08-03. Who and exactly when is in the project's Admin Activity log (kept 400 days), readable by
   Isaac: `gcloud logging read 'protoPayload.methodName="SetIamPolicy" AND
   timestamp>="2026-08-03T07:00:00Z" AND timestamp<="2026-08-03T08:15:00Z"' --project=vida-finance`.

3. **What the canary did and did not protect — the original "changed nothing in prod" is wrong.** The
   preflight canary probes Cloud Functions writes only. It held through phase (1): no billing-phase run
   wrote anything (`30734473564` … `30759300648`). It could not see the index 403, because index creation
   is a different permission, so from 18:04Z every run passed the canary and then wrote part of a
   deploy before failing. Measured from the run logs (`gh run view <id> --log`, first matching line):

   | Run | Functions (`Successful … operation`) | `firestore.rules` released | Hosting released | Index 403 |
   |---|---|---|---|---|
   | `30760060720` | — | — (uploaded only) | — | 18:04:05Z |
   | `30760666827` (cancelled) | from 18:19:47Z | — | — | — |
   | `30761707373` | from 18:48:00Z | 20:06:50Z | — | 20:06:53Z |
   | `30764142125` | from 20:09:29Z | 20:23:38Z | — | 20:23:41Z |
   | `30765287665` (`913987c`, #414) | from 20:26:14Z | 20:40:30Z | **20:40:40Z** | 20:40:33Z |
   | 27 more failing runs `30765887091` … `30790896142`, each the same shape as `30765287665` (`30781964666` failed in unit tests and never deployed) | | | | |
   | `30791906109` (last failure) | from 07:04:43Z | 07:19:19Z | 07:19:29Z | 07:19:22Z |

   (Run order and step order changed under us: #412 batched function deploys, and #414 stopped an
   index 403 from blocking hosting.) So prod was **not** untouched. Two windows of mixed state:
   - **2026-08-02 18:19:47Z → 20:40:40Z (~2 h 20 m): new Cloud Functions, then (from 20:06:50Z) new
     Firestore rules, against the hosting release from 2026-07-31.** That is backend-ahead-of-frontend,
     the skew the deploy order is meant to avoid. Nobody checked what the old frontend did against it.
   - **2026-08-02 20:40:40Z → 2026-08-03 08:12:03Z (~11.5 h): everything current except Firestore
     indexes.** Any query needing the new `audit_log` composite index (#402) would have failed with
     `FAILED_PRECONDITION` until `30793707586` created it.

   What this means for launch: the canary guards only against a refused *functions* write. It does not
   make a deploy atomic, and any other permission or quota failure after it leaves prod partly deployed.
   The job does fail red in that case (every run above exited 1), so it is not silent, but "red" here
   means "half shipped", not "nothing shipped". Whoever owns deploys should treat a red deploy as a
   live prod change to check, not as a no-op.

Remaining action for D1 to close: Isaac confirms (1) from billing history and puts an alert on that
billing account's payment state, since nothing in this repo can see it coming.

**D2 — Launch monitoring covers 5 services; 7 exist, and the 2 omitted are the important ones.**
*(closed in code 2026-10-13 — see the update at the end of this item)*
v1.7 monitors payment-server, softcredito-adapter, notification-service, pdf-generator, ml-service.
Absent: **underwriting-service** (makes the credit decision) and **registry-service** (holds the
ledger). Both expose `/health`. A product that cannot underwrite is down even if all five monitored
services are green. Add both to health checks and alerting before launch.

*Update 2026-10-13.* It was worse than stated. `services/shared/health-monitor.js` already had all 7
(added 2026-08-03), but the **deployed** Firestore-side `systemHealthCheck` was an inline copy in
`functions/src/index.ts` left from the "Railway decommissioned" era that probed only
**payment-server and ml-service**; the 5-service module in `functions/src/scheduled/` never deployed
(it was on the frozen duplicate list). Fixed: `index.ts` now re-exports the module, which probes all 7;
an unset URL env var is recorded as `unconfigured` with no critical incident (`REGISTRY_SERVICE_URL`
is still sourced from a possibly-empty secret in `deploy.yml`). Evidence:
`cd functions && npx jest src/scheduled/__tests__/systemHealthCheck.test.ts src/__tests__/duplicateFunctionDefinitions.test.ts`;
`npx jest services/shared/health-monitor.test.js` (now a CI hard gate).
*Update 2026-10-13 (domain).* registry-service's public domain is now recorded:
`scripts/production-endpoints.json` → `registry.url` =
`https://registry-service-funpay-production-1d23.up.railway.app` (source: commit `433312e`, which
moved the registry into FunPay's Railway project and set `REGISTRY_SERVICE_URL` to it; live check
the same day, one `GET /health` → **200** `{"status":"ok","service":"vida-registry-service","db":true}`).
It is a separate `registry` key, not a `services` entry, so `deploy.yml`'s functions/.env loop and
`recover-production-services.mjs` do not pick it up. `scripts/check-production-health.mjs` (run by
`verify-production-live.yml`) now probes it as `canonical:registry-service`, and a
`REGISTRY_SERVICE_URL` secret that drifts from it gates on its own health. Listed in
`docs/runbooks/uptime-monitoring.md` (row 8, the UptimeRobot loop) and the scrape config in
`docs/monitoring/README.md`. Evidence: `node --test scripts/check-production-health.test.mjs`.
Alert *delivery* for either service remains B7.

**D3 — Lighthouse and load-test claims have no CI home.** *(Lighthouse half closed 2026-10-13;
load-test half still open)*
B8 and B9 were ticked in v1.7 and are unfalsifiable as written. Either add a CI job (Lighthouse CI
is a small addition to the frontend job) or commit the report artifact. Until then they stay in B.

*Update 2026-10-13.* Lighthouse now has a CI home: job *Lighthouse (marketing pages)* in
`.github/workflows/ci.yml`, config `public-v2/lighthouserc.json`, reports uploaded as the
`lighthouse-report` artifact. Measuring it showed the v1.7 tick was **false**, not merely unproven:
performance is 0.70–0.75 (B9 has the numbers). Local reproduction:
`cd public-v2 && VITE_LAUNCH_MODE=live npm run build && npx @lhci/cli@0.15.1 autorun` (exit 0 with
four performance warnings; raising the a11y floor to 0.99 makes `lhci assert` exit 1, so the gate
does bite). The load test (B8) is **not** automated: `tests/load/` holds a k6 script but
`tests/load/results/` is empty, and running it means sending load at production — that is for ops to
schedule and commit the report.

*Update 2026-10-13 (ops-prep).* Prepared, **not run**. Findings and changes:
- The k6 script's default target was `https://us-central1-vida-finance.cloudfunctions.net`, i.e.
  **production** (`.firebaserc`; `/api/health` → 200, one GET on 2026-10-13). It now has no default;
  production needs `LOAD_TEST_ALLOW_PRODUCTION=I-HAVE-OPS-SIGN-OFF`; reports are named
  `<date>-<emulator|staging|production>-<profile>-report.md`. Pinned by
  `node --test tests/load/target.test.mjs` (11 tests, CI hard gate). Setup now aborts on a failed
  health check instead of proceeding.
- **No usable staging:** `develop` is 429 commits behind `main`; its last three `deploy.yml` runs
  failed (latest 2026-05-29); no staging URL is in-tree.
- **k6 is not installed** on the prep machine, so nothing was run — not even against the emulator.
  `tests/load/results/` is still empty; no result is claimed.
- The script cannot produce a meaningful 2x number yet: `requestLoan` enforces App Check (now
  supported via `APP_CHECK_TOKEN`), needs an `employees/{uid}` doc, and limits each uid to 3/day;
  the script's sign-in path invents unseeded users. A seeded load-test user pool is a prerequisite.
  The dead `LOAD_TEST_AUTH_BYPASS` option (no function implements it) was removed.
- Exact commands, the recommended window (Tue–Thu 03:00–05:00 CDMX, away from quincenas) and live
  abort thresholds: `docs/runbooks/scaling.md` § Load test.

**D4 — 11 `console.log` calls remain in services; v1.7 claimed zero.** *(the two that mattered are
fixed — 2026-10-13)*
Most are benign process-start banners (`listening on ${PORT}`) or a CLI backfill script. Two are
not: `pdf-generator/index.js:285` logs a per-loan signing event (`loanId`, `metamapDocumentId`) on
a request path, and `shared/health-monitor.js:154-161` logs every poll. Both bypass the structured
logger, so they carry no correlation id and are not queryable — the two properties that make a log
useful during an incident. Low severity, but the v1.7 claim of zero was false.

*Update 2026-10-13.* `pdf-generator`'s signing event already goes through `log.info`
(`services/pdf-generator/index.js:312`), and `health-monitor.js`'s per-poll output was already
`log.info`. The remaining health-monitor startup banners and its poll-failure/crash paths now use the
same pino logger, pinned by `services/shared/health-monitor.test.js`. That suite and
`services/shared/alerting.test.js` previously ran in **no** CI job (services/shared is not a package);
both are now a hard-gate step in the *Lint, Typecheck & Test* job.
`grep -rn "console\.log" services --exclude-dir=node_modules | grep -v test` → **7**, all benign:
4 `listen` banners and 3 lines of the `registry-service/scripts/backfill.js` CLI.

**D5 — Two audit-log collections still coexist.** *(re-measured 2026-08-03; scope was narrower than
stated)*
Noted as residual in `CRITICAL_DEFECTS.md` P2-2. Not a defect — the security-critical grant path
audit-logs before minting a claim, and a failed audit write aborts the grant.

The **write side is already consolidated**, which the v1.8 wording did not reflect. Every writer goes
through `functions/src/utils/auditLog.ts` (`audit_log`); grep across `functions/`, `services/`,
`public/`, `public-v2/`, `scripts/` and `tests/` finds **no writer to `auditLogs` at all**. Rules and
all four composite indexes target `audit_log`. So there is no ambiguity about which collection holds
a *new* record.

Two things were genuinely open, and are now addressed:

- **The grant-ordering invariant had no test.** `onEmployerDocCreated` — the trigger that mints
  `employer_admin` — was covered by nothing; a refactor that minted before logging would have passed
  every suite in the repo. Now pinned by
  `functions/src/employers/__tests__/onEmployerDocCreated.test.ts` (8 tests), verified by mutation:
  reordering the production code fails 2 of them.
- **Legacy history is not migrated.** Pre-consolidation records still live in `auditLogs`, and the
  ops console (`public/js/app.js:2602`) queries only `audit_log`, so they are invisible in the UI.
  `scripts/migrations/002_consolidate_audit_logs.ts` copies them forward — committed, **not run**;
  procedure and sign-offs in `docs/runbooks/audit-log-consolidation.md`.

Until that migration runs, `firestore.rules` deliberately keeps ops read on `auditLogs` so the
history is not stranded. Removing that rule is a follow-up, gated on the migration being verified.

*Update 2026-10-13 (ops-prep).* The script already had `--dry-run`; it is now importable
(`planMigration` / `applyPlan` / `run`, main guarded) and pinned by
`scripts/migrations/__tests__/002_consolidate_audit_logs.test.ts` (5 tests: dry run creates zero
batches, idempotent re-run, native-id refusal fires in dry run too, copy preserves original
timestamp; a mutation that lets the dry run write fails the suite). Rehearsed on the Firestore
emulator with seeded data (27 legacy rows, 2 untimestamped): dry run wrote nothing, real run copied
25, re-run identical, `auditLogs` untouched — `scripts/migrations/002_emulator_rehearsal.ts`,
output in the runbook § Rehearsal. Runbook now has the exact commands (compiled with the pinned
`tsc`; `ts-node` is not a dependency, so the old `npx ts-node` line would have fetched an
unpinned package) and an evidence-based sign-off list.

*Still open 2026-10-13 — needs a named human:* running
`scripts/migrations/002_consolidate_audit_logs.ts` against production per
`docs/runbooks/audit-log-consolidation.md` (its sign-offs), then removing the `auditLogs` read rule.
