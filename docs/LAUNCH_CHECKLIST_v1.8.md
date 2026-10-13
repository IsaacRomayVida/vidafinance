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
| A2 | Production deploy succeeds | ✅ | Run `30798414554` — functions, rules, indexes, hosting all `Deploy complete!`. First fully green deploy since 2026-07-31 (see D1) |
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
| B8 | Load test passed at 2x target throughput | Isaac / ops | No load-test artifact committed. If one exists, commit the report and promote this to table A |
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

**D1 — The deploy blocker cleared itself; nobody would have noticed.** *(diagnosed 2026-10-13 — two
separate 403s, see the update at the end of this item; the billing half still needs Isaac to confirm)*
Production deploys failed for ~3 days on an HTTP 403 write refusal. Run `30798414554` (2026-08-03
08:42Z) shows the preflight canary getting **200** and the full deploy landing. No config change
was made on our side, so the fix was upstream — billing or IAM. Worth confirming *which*, because
an unexplained recovery can un-recover. The preflight canary itself is the win: it aborts before
any partial write, so three days of failure changed nothing in prod.

*Update 2026-10-13.* Re-measured from every `main` push run of *VIDA Platform — Deploy*
2026-07-28..08-04 (`gh run list --workflow 246929693 --created …`, then `gh run view <id> --log-failed`)
plus read-only `gcloud` on `vida-finance`. Several statements above were wrong: it was **~25 h, not
~3 days**, it was **two different 403s back to back**, neither "fixed itself", and the first fully green
deploy was `30793707586` (2026-08-03 ~08:12Z), not `30798414554`. The 2026-07-30 failures are unrelated
(`onContactCreated` trigger-type change, no 403). No `main` deploy ran between the last good one,
`30593318133` (2026-07-31 00:21Z), and 2026-08-02 05:38Z. *Deploy Firebase* (245647385) ran once in the
window (2026-07-30, dispatch, green).

1. **Billing refusal on Cloud Functions writes — 2026-08-02 05:42Z → 17:42Z (observed).** Every
   functions upload got
   `POST cloudfunctions.googleapis.com/v2/projects/***/locations/us-central1/functions:generateUploadUrl`
   → `HTTP Error: 403, Write access to project '***' was denied: please check billing account associated
   and retry`. First seen in `30734473564` (05:42Z, 256 identical 403s, then the 6 h job limit); last
   seen in `30759300648` (preflight canary 403 at 17:42Z). The next run, `30760060720`, got canary
   **200** at ~18:03Z and deployed every function. `deploy.yml` did not change in between (the only
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
   → `HTTP Error: 403, The caller does not have permission` in every run that reached it — 29 runs,
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
Still needing a human: registry-service's public domain is not recorded in
`scripts/production-endpoints.json`, so the external uptime monitors in
`docs/runbooks/uptime-monitoring.md` and `docs/monitoring/README.md` do not list it, and only the
`REGISTRY_SERVICE_URL` secret knows it. Alert *delivery* for either service remains B7.

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

*Still open 2026-10-13 — needs a named human:* running
`scripts/migrations/002_consolidate_audit_logs.ts` against production per
`docs/runbooks/audit-log-consolidation.md` (its sign-offs), then removing the `auditLogs` read rule.
