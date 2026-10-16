# Session handoff — production readiness (updated 2026-10-16)

Paste-ready kickoff prompt for the next session: `docs/NEXT_SESSION_PROMPT.md`.

Written at the end of a Claude Code session so the next session (on a different
Claude account, same folder `/Volumes/PortableSSD/Suena/Funpay`) can continue
without the conversation history. Everything stated here was checked
against git, GitHub, and test runs at the time of writing. Re-check anything
that time could have changed (CI state, open PRs, production health).

## 1. Where things stand

### Shipped to production (2026-10-13)
- **PR #635** (`hardening/production-readiness`) merged as `23d03d2`; deployed and verified.
- **PR #636** (`hardening/launch-followups`) merged as `4390a44` after all 17 checks passed and the
  user confirmed the merge. Deploy run 38383208275 succeeded (CI + Firebase deploy), and
  `verify-production-live.yml` run 38385567418, dispatched afterwards, passed.
  Contents: INFONAVIT active-credits gate, E18 remittance ledger, registry monitoring, D1 diagnosis,
  migration 002 and load-target prep, legacy underwriting test cleanup.

- **PR #637** (`hardening/remittance-ops-load-prep`) merged after 16 checks passed and the user said
  to go ahead. Deploy run 38402458506 succeeded; `verify-production-live.yml` run 38406363345 passed.
  Contents: remittance follow-ups (date validation, reference dedupe, void, on-demand record,
  backfill 004, `listPayrollRemittances`, ops screen `/ops/remittances`), review cleanups, load-test
  seed and runbook, and the Lighthouse work (performance assertion is now `error`; it passed on the
  CI runner).

- **PR #638** (`hardening/remittance-alerts-load-run`) merged as `878bb86` on the user's go-ahead after
  16 checks passed. Deploy run 38447548216 succeeded; `verify-production-live.yml` run 38450876839
  passed. Contents: paginated `listPayrollRemittances` with three new indexes, `receivedOn` lower
  bound, `details.reason` on every refusal with Spanish text, backfill 004 reference-index pass,
  daily `remittanceOverdueCheck`, `public-v2` emulator wiring (dev builds only) and
  `scripts/seed-remittance-emulator.mjs`, the k6 emulator smoke run (90/90 accepted) and tighter
  load-target guards, board placeholders and English-chunk preload on the marketing pages.
  The three new `payrollRemittances` indexes were `CREATING` right after the deploy and were all
  `READY` on 2026-10-14 (checked read-only through the Firestore REST API). Scheduled production
  checks (`verify-production-live`, registry verify, public-route E2E smoke) kept passing through
  2026-10-15.

### Checked against production (read-only, 2026-10-13)
- Backfill 004 dry run (`--allow-production`, no `--apply`, the user's own Google login): **0 batches,
  0 receipts.** Production has no payroll batches yet, so the backfill is not needed and the first
  `remittanceOverdueCheck` run has nothing to alert on.
- `SLACK_WEBHOOK_URL` is not among the repository's GitHub secrets, and `functions/src/utils/slackAlert.ts`
  is a no-op without it: overdue alerts reach only the ops alerts page.
- GitHub secrets `FIREBASE_PROJECT_ID_STAGING` and `FIREBASE_SERVICE_ACCOUNT_STAGING` exist, so a
  staging Firebase project may already exist for the load test.

- **PR #639** (`hardening/stage0-closed-credit`) merged as `b8919fe` on 2026-10-15 after the user
  said "merge 639" (16 checks passed, 3 skipped). Deploy run 38752277581 succeeded (CI + Firebase);
  `verify-production-live.yml` run 38755867305, dispatched afterwards, passed. Contents: stage 0
  treats an INFONAVIT record with `credit_status:"closed"` as closed even with `balance > 0`.

- **PR #640** (`hardening/remittance-load-marketing`, the swarm5 work) merged as `0543a8c` on 2026-10-16 on
  the user's go-ahead ("do it all"), 16 checks passed, 3 skipped. Deploy run 38878782143 succeeded;
  `verify-production-live.yml` run 38882409086 passed. Contents: overdue remittance alerts close when the
  money arrives and re-raise after a void (`overdueAlertEpoch`), page caps with a `remittance-check-truncated`
  incident in `remittanceOverdueCheck`, server-side totals on `/ops/remittances`, load-test guards
  (`FIREBASE_PROJECT_ID` shape check, abort on a failed App Check refresh, mocked exchange/sign-in tests),
  the employer stage photo and `<html lang>` fixes, `/health` commit/version on underwriting, and
  `.github/workflows/deploy-underwriting.yml` (dispatch-only).

### Underwriting-service deployed (2026-10-16)
Merges never redeployed `services/underwriting-service` on Railway; production had been running `8259bd0`
(#630, 2026-09-18), so #636's INFONAVIT gate and #639's closed-credit rule were not live. With the user's
approval, `deploy-underwriting.yml` run 38882474775 deployed `0543a8c` (deployment
`1f8ad33a-959f-4bc1-9730-795a2230b456`, service `a13f634d-79e1-45d4-ae54-29ad27b805ea`). The workflow's
own checks passed (Dockerfile build, deployment SUCCESS, `/health` commit = main), production `/health`
reports `"commit":"0543a8c6…"`, and a second `verify-production-live.yml` run 38882712615 passed.
On 2026-10-16 the user approved a push trigger: `deploy-underwriting.yml` now deploys on every push to
`main` touching `services/underwriting-service/**`, `services/shared/**`, `.dockerignore` or the workflow,
and `scripts/check-deploy-watch-paths.mjs` holds that filter to the Dockerfile's COPY set (its old
dispatch-only mode is gone). It shipped with the handoff docs PR #641; merging #641 triggers its first push deploy, so check that run.

## 2. Next steps, in order
1. Small follow-ups from the swarm5 reviews (none blocking):
   - Remittance totals: a first-page `listPayrollRemittances` call walks every matching record (cap
     40 × 1,000 reads, reports `complete:false` at the cap). "Overdue" depends on today's date, so stored
     `sum()` aggregation can't replace it; if the ledger grows, maintain counters instead. `viewTotals` is
     not cleared while a new filter loads (same staleness as the rows). `resolveStaleAlerts` is not
     transactional (cosmetic: a dismissed alert can also get `resolvedBy:'system'`).
   - Underwriting workflow: `DEPLOYMENT_COMMIT` is read when the deployment first appears, not at SUCCESS.
   - Load: in `tests/load/seed/pool.js` `createAppCheckTokenSource`, an exchange ttl under ~75 s makes the
     refresh point fall after expiry; `FIREBASE_APP_ID`/`FIREBASE_API_KEY` and the seed's `--project` are not
     shape-checked; static `APP_CHECK_TOKEN`/`AUTH_TOKEN` have no expiry detection (smoke-only path).
   - Marketing: the language toggles still label themselves from `i18n.language` (requested) rather than
     `resolvedLanguage`, so after a failed English chunk the toggle offers Spanish while Spanish is shown.
2. Still open, needs people or infrastructure: `SLACK_WEBHOOK_URL` in production is unverified; the 7-day
   grace period is a display default, not an agreed term; B8 and runbook setup B need a staging run
   (section 3); the App Check exchange and sign-in retry are unit-tested against mocks only; `/` Lighthouse
   sits at 0.93–0.94, close to the gate.

## 3. Needs a human (do not fake these)
- **Load test prerequisites:** create the non-production Firebase project (its id must not contain `prod`), register the App Check debug token, and set the load-test password. Steps are in `docs/runbooks/scaling.md`.
- **Gen-2 host guard:** confirm in the GCP console that vida-finance's Cloud Run hash is `gd5fcu677q` and its project number is `447766605132` (the hash answered `/health` with 200, which is the only evidence so far).
- **Slack:** set `SLACK_WEBHOOK_URL` on Functions if overdue-remittance alerts should reach Slack.
- **Local credentials:** the `gcloud` CLI on this Mac is signed in as the production admin service account (`firebase-adminsdk-fbsvc@vida-finance`). Claude has not used it; the user was asked whether read-only use is acceptable and has not answered. Application Default Credentials are the user's own Google login (re-done 2026-10-13); that is what the backfill dry run and the index check used, read-only. If ADC fails with `invalid_rapt`, ask the user to run `gcloud auth application-default login`; never sign in for them.
- **Staging project:** GitHub secrets `FIREBASE_PROJECT_ID_STAGING` and `FIREBASE_SERVICE_ACCOUNT_STAGING` exist. Someone should confirm whether that project can host the load test (its id must not contain `prod`).
- **Ops remittance screen:** an agent checked it in headless Chrome on the emulators; a person with an ops login should still open it in production.
- **Marketing pages:** look at them in Safari (iOS and macOS) and Firefox, and watch the route fade and board films; only headless Chrome screenshots were compared.
- **D1:** confirm the billing cause using billing account `01B681-29512A-745C5D`'s payment history, and see who granted indexAdmin on 2026-08-03. The exact `gcloud logging read` commands are in the checklist D1 section. The deploy SA cannot read those logs. Add a billing-state alert.
- **D5:** run migration 002 against production, then remove the `auditLogs` read rule. Do this only with the sign-offs named in `docs/runbooks/audit-log-consolidation.md`. The commands are in that runbook.
- **B8:** a production load test (smoke profile only, with ops sign-off and a dedicated load-test employer).
- **Section B items:** B1–B11 depend on live infrastructure or third parties. They stay unticked until their owners verify them.
- The local `railway` CLI login (romaysacromay@gmail.com) cannot see the FunPay Railway project.

## 4. How the work was run (repeat the same way)
- **Multi-agent "swarm" via the Workflow tool:** one agent per area in an isolated git
  worktree on its own branch (`swarm/*` from #635, `swarm2/*` for #636, `swarm3/*` for #637, `swarm4/*` for #638, `swarm5/*` for #640), then
  an adversarial reviewer per branch that re-runs the tests, then a repair agent if
  the review blocked. After that, merge the approved branches into a `hardening/*`
  branch, run the full suites locally, push, and let PR CI gate it.
- **Agent rules that worked:**
  - Verify each audit finding against current code first; the audit docs were stale.
  - Use canonical status constants (`functions/src/loans/loanStatus.ts`, mirrored in `public-v2/src/lib/loanStatus.ts`).
  - Every fix gets a test that fails when the fix is reverted.
  - Commit style is a lowercase area prefix (`functions: …`, `public-v2: …`), with **no attribution or co-author lines**.
  - Agents never push, merge or deploy, and never touch IAM, billing or secrets.
  - Agents never send load or writes to production. A single read-only GET to `/health` is fine.
- **Merging to `main` is a production deploy.** Branch protection requires 0 reviews, so nothing but CI stops it. Merge only when the user has authorised it.
- **Old worktrees:** all `swarm/*` … `swarm5/*` worktrees, branches and `worktree-wf_*` placeholder branches were removed on 2026-10-16 with the user's go-ahead (all merged, none dirty). Workflow runs leave `worktree-wf_*` branches behind; delete them with `git branch -d` once merged.
- **Local tooling now installed:** k6 (Homebrew), Firebase emulators with Java, `@lhci/cli` via npx. A local Redis is needed for emulator runs of rate-limited callables (`redis-server --port <p>`); stop any you start.
- **Workflow resume:** if a Workflow run is cut off by a session ending, check its worktrees for commits and uncommitted work before relaunching; completed agents can be replayed from cache only within the same session.
- **Visual checks:** the built-in browser pane can preview a local production build (`.claude/launch.json` with `npm --prefix public-v2 run preview`; delete the file afterwards). Ops pages need `npm run dev:emulators` plus `scripts/seed-remittance-emulator.mjs` (see `docs/runbooks/payroll-remittances.md`), never the real project.
- `graphify-out/` does not exist in this clone, so the CLAUDE.md graphify rule falls back to normal code search.

## 5. Useful commands
```bash
gh pr list --state open
gh pr checks <PR#>
gh run list --branch main --limit 10
gh workflow run verify-production-live.yml --ref main
(cd functions && npx tsc --noEmit -p . && npx jest)
(cd public-v2 && npx tsc --noEmit -p . && npx cross-env NODE_OPTIONS=--no-experimental-webstorage vitest run)
(cd services/underwriting-service && npx jest)
node --test scripts/*.test.mjs tests/load/*.test.mjs tests/load/seed/*.test.mjs
npm run test:migrations
npm run lint && (cd functions && npm run lint) && (cd public-v2 && npm run lint && npm run build)
```
