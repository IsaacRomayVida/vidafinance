# Session handoff — production readiness (2026-10-13)

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
  Right after the deploy the three new `payrollRemittances` indexes were still `CREATING`.

### Checked against production (read-only, 2026-10-13)
- Backfill 004 dry run (`--allow-production`, no `--apply`, the user's own Google login): **0 batches,
  0 receipts.** Production has no payroll batches yet, so the backfill is not needed and the first
  `remittanceOverdueCheck` run has nothing to alert on.
- `SLACK_WEBHOOK_URL` is not among the repository's GitHub secrets, and `functions/src/utils/slackAlert.ts`
  is a no-op without it: overdue alerts reach only the ops alerts page.
- GitHub secrets `FIREBASE_PROJECT_ID_STAGING` and `FIREBASE_SERVICE_ACCOUNT_STAGING` exist, so a
  staging Firebase project may already exist for the load test.

### In progress: PR #639 (`hardening/stage0-closed-credit`, open, not merged)
Stage 0: an INFONAVIT record with `credit_status:"closed"` is never counted as active, even with
`balance > 0` (it was). Two new tests fail on revert; underwriting 454 passed, 1 skipped. This
changes approvals, so it waits for the user's explicit go-ahead to merge.

## 2. Next steps, in order
1. PR #639: merge only with the user's go-ahead (production deploy), then dispatch
   `verify-production-live.yml`. Confirm the three new `payrollRemittances` indexes are `READY`, and
   have someone with an ops login open `/ops/remittances` in production.
2. Remittance, still open:
   - Overdue alerts are not resolved when the money arrives, and a record re-opened by a void does not re-raise a threshold it already raised. Whether `SLACK_WEBHOOK_URL` is set in production is unverified.
   - KPI totals on the screen sum only the loaded rows; there is no server-side grand total.
   - The 7-day grace period is a display default, not an agreed term.
   - The `remittanceOverdueCheck` paging loop has no page cap.
3. Load test, still open:
   - Only a staging run can close B8; it needs the human steps in section 3.
   - The App Check debug-token exchange and the sign-in transport retry have never run against a real project.
   - `FIREBASE_PROJECT_ID` should be shape-checked (`^[a-z0-9-]+$`) before it is compared; an expired token with a failing exchange is not aborted.
   - Runbook setup B (full pipeline) is still marked not cleared.
4. Marketing, still open: the employer "stage" panel can show without its photograph on a very fast scroll; `/` sits at 0.93–0.94, close to the gate; `<html lang>` reads `en` while the Spanish fallback is on screen.

## 3. Needs a human (do not fake these)
- **Load test prerequisites:** create the non-production Firebase project (its id must not contain `prod`), register the App Check debug token, and set the load-test password. Steps are in `docs/runbooks/scaling.md`.
- **Gen-2 host guard:** confirm in the GCP console that vida-finance's Cloud Run hash is `gd5fcu677q` and its project number is `447766605132` (the hash answered `/health` with 200, which is the only evidence so far).
- **Slack:** set `SLACK_WEBHOOK_URL` on Functions if overdue-remittance alerts should reach Slack.
- **Local credentials:** the `gcloud` CLI on this Mac is signed in as the production admin service account. Claude did not use it; the user was asked whether read-only use is acceptable and had not answered when this was written.
- **Ops remittance screen:** an agent checked it in headless Chrome on the emulators; a person with an ops login should still open it in production.
- **Marketing pages:** look at them in Safari (iOS and macOS) and Firefox, and watch the route fade and board films; only headless Chrome screenshots were compared.
- **D1:** confirm the billing cause using billing account `01B681-29512A-745C5D`'s payment history, and see who granted indexAdmin on 2026-08-03. The exact `gcloud logging read` commands are in the checklist D1 section. The deploy SA cannot read those logs. Add a billing-state alert.
- **D5:** run migration 002 against production, then remove the `auditLogs` read rule. Do this only with the sign-offs named in `docs/runbooks/audit-log-consolidation.md`. The commands are in that runbook.
- **B8:** a production load test (smoke profile only, with ops sign-off and a dedicated load-test employer).
- **Section B items:** B1–B11 depend on live infrastructure or third parties. They stay unticked until their owners verify them.
- The local `railway` CLI login (romaysacromay@gmail.com) cannot see the FunPay Railway project.

## 4. How the work was run (repeat the same way)
- **Multi-agent "swarm" via the Workflow tool:** one agent per area in an isolated git
  worktree on its own branch (`swarm/*` from #635, `swarm2/*` for #636, `swarm3/*` for #637, `swarm4/*` after that), then
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
- **Old worktrees** under `.claude/worktrees/wf_*` and the `swarm/*` / `swarm2/*` branches can be removed once their content is on `main`: `git worktree remove <path>` and `git branch -d <branch>`. They are local only.
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
node --test scripts/check-production-health.test.mjs tests/load/target.test.mjs
npm run test:migrations
```
