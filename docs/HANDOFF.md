# Session handoff — production readiness (2026-10-13)

Paste-ready kickoff prompt for the next session: `docs/NEXT_SESSION_PROMPT.md`.

Written at the end of a Claude Code session so the next session (on a different
Claude account, same folder `/Volumes/PortableSSD/Suena/Funpay`) can continue
without the conversation history. Everything stated here was checked
against git, GitHub, and test runs at the time of writing. Re-check anything
that time could have changed (CI state, open PRs, production health).

## 1. Where things stand

### Shipped to production today
- **PR #635** (`hardening/production-readiness`) was merged into `main` as `23d03d2`
  after all 17 CI checks passed. The push deploy succeeded: Firebase hosting, functions,
  rules and indexes, plus the Railway registry-service. `verify-production-live.yml`
  was dispatched after the deploy and passed: the public endpoints answer and the
  Railway inventory matches the docs.
- Contents: lint everywhere, every critical advisory cleared, INTERNAL_SECRET rotation
  with no 401 window, PDF generator fixes plus a real-Chromium render gate, the
  public-v2 React fixes, and the audit fixes below.
- Audit findings, verified against code. Most were already fixed by earlier PRs; the
  rest were fixed in #635:
  - `AUDIT_EMPLOYER_PATH.md` E1–E17: done. E18 is handled by the follow-up branch below.
  - `AUDIT_PUBLIC_V2.md` F1–F11: done. F5 on the employer side was fixed in `88c9206`.
  - `docs/AUDIT_05_TEST_COVERAGE.md`: every decision-engine stage now has real unit tests.
    That doc is historical and still lists two deleted `tests/` suites; this is known and harmless.
  - `docs/LAUNCH_CHECKLIST_v1.8.md`: D2, D3 (Lighthouse CI job) and D4 were closed in code.

### In progress: branch `hardening/launch-followups` → PR #636 (open, not merged)
This branch is based on `main` and merges six reviewed follow-up branches.

| Branch | What | Status |
|---|---|---|
| `swarm2/infonavit-gate` | Stage 0 now sums only **active** INFONAVIT credits into `infonavitDeduction`. Closed credits were inflating LTI and wrongly rejecting borrowers. Owner decision: closed credits do not count. | merged, reviewed |
| `swarm2/legacy-uw-tests` | Deleted the never-run `services/underwriting-service/tests/` suites and moved the MetaMap client coverage to `src/metamap-client.test.js`. | merged, reviewed |
| `swarm2/registry-domain` | Registry prod domain `https://registry-service-funpay-production-1d23.up.railway.app` was added to `scripts/production-endpoints.json` (top-level `registry` key, deliberately not under `services`), probed by `check-production-health.mjs`, and added to the uptime runbook. | merged, reviewed |
| `swarm2/deploy-403` | Checklist D1 re-diagnosed: two 403s over about 25 h (billing refusal on functions writes, then a missing Firestore index-create grant), neither of which cleared itself. The first review blocked on factual errors; these were repaired in `f1a877c`. | merged, reviewed + repaired |
| `swarm2/ops-prep` | Audit-log migration 002 is importable and tested, with a dry run and an emulator rehearsal (`scripts/migrations/002_emulator_rehearsal.ts`). The load test no longer defaults to the **production** URL (it did before) and refuses prod-shaped targets. Runbook updated. | merged, reviewed |
| `swarm2/remittance-ledger` | E18: `payrollRemittances/{batchId}` holds the expected amount (integer centavos, written by `processPayroll`). The `recordPayrollRemittance` callable (ops/admin only) books received transfers. Employer read-only rules, tests, and a small employer UI card. | merged, reviewed |
| `swarm2/lighthouse-perf` | Get marketing pages to Lighthouse performance ≥ 0.9 (currently 0.70–0.75, LCP 5–7 s on mobile), then change the `performance` assertion in `public-v2/lighthouserc.json` from `warn` to `error`. | **NOT DONE.** The agent was still running when the session ended. Check worktree `.claude/worktrees/wf_647440a8-1e8-2` for uncommitted work; if it is empty, redo the task. |

Local test results on the merged branch: functions 1027/1027, public-v2 300/300,
underwriting 452/452 (1 skipped, as before), script and load-target node tests 28/28,
migrations 49/49. The Firestore rules emulator suite passed on the remittance branch
(181) and runs in CI as a hard gate.

## 2. Next steps, in order
1. Check CI on PR #636 (`hardening/launch-followups`). If it is green, merge it to `main`.
   **Merging to `main` deploys to production** (`deploy.yml` on push). Then dispatch
   `verify-production-live.yml` and confirm it passes.
2. Finish **lighthouse-perf** (see the table). Do not change the visual design.
3. Remittance follow-ups (reviewer notes on `swarm2/remittance-ledger`; none was blocking):
   - **No ops UI** calls `recordPayrollRemittance` yet. Build an ops screen (public-v2 has ops/admin surfaces).
   - Batches processed before this shipped have no `payrollRemittances` doc. A backfill script is needed, or the callable must create the doc on demand from `payrollDeductions`.
   - A wrong receipt cannot be corrected (`receipts[]` only grows). Add an ops "void receipt" path with an audit log entry.
   - `bankReference` dedupe is per batch and case-sensitive. Normalise it, and consider uniqueness across batches.
   - `receivedOn` accepts impossible or future dates. Validate it as a real calendar date ≤ today (Mexico City time).
   - There are no overdue/aging alerts for expected remittances that are never received.
4. Small cleanups from the reviews:
   - `tests/load/config.js:5` still shows the prod URL as the `STAGING_URL` example.
   - The `npm run load-test*` scripts have no `TARGET_URL`, so they fail at init. That is safe but unfriendly.
   - `target.js` does not recognise Gen-2 `*.a.run.app` prod URLs.
   - `check-production-health.mjs` main() registry and drift logic has no unit test.
   - The metamap retry tests wait on real timers (about 3 s); use Jest fake timers.
   - Stage 0: a record with `credit_status:"closed"` but `balance > 0` still counts as active. This decision was deferred (one-line change if "closed" should win).
5. Load test: needs a **seeded pool of load-test employees** (about 2,800 uids for the 2× stage), an App Check debug token on the target project, and a non-prod target. `requestLoan` limits each uid to 3 per day, and `requestLoan` calls live bureau and RiskSeal providers. See the scaling/load runbook. k6 is not installed locally.

## 3. Needs a human (do not fake these)
- **D1:** confirm the billing cause using billing account `01B681-29512A-745C5D`'s payment history, and see who granted indexAdmin on 2026-08-03. The exact `gcloud logging read` commands are in the checklist D1 section. The deploy SA cannot read those logs. Add a billing-state alert.
- **D5:** run migration 002 against production, then remove the `auditLogs` read rule. Do this only with the sign-offs named in `docs/runbooks/audit-log-consolidation.md`. The commands are in that runbook.
- **B8:** a production load test (smoke profile only, with ops sign-off and a dedicated load-test employer).
- **Section B items:** B1–B11 depend on live infrastructure or third parties. They stay unticked until their owners verify them.
- The local `railway` CLI login (romaysacromay@gmail.com) cannot see the FunPay Railway project.

## 4. How the work was run (repeat the same way)
- **Multi-agent "swarm" via the Workflow tool:** one agent per area in an isolated git
  worktree on its own branch (`swarm/*` from #635, `swarm2/*` for the follow-ups), then
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
