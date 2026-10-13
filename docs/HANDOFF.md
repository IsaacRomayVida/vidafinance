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

### In progress: branch `hardening/remittance-ops-load-prep` (based on `main` at `4390a44`)
Three reviewed `swarm3/*` branches and `swarm2/lighthouse-perf` merged, plus one orchestrator commit with reviewer fixes. PR #637.

| Branch | What | Status |
|---|---|---|
| `swarm3/remittance-followups` | `receivedOn` must be a real date ≤ today (Mexico City). `bankReference` deduped on a normalised key, in the batch and across batches through `payrollRemittanceReferences` (`sharedTransfer: true` overrides the cross-batch case). New ops-only callables `voidPayrollRemittanceReceipt` (audit-logged, idempotent, frees the reference) and `listPayrollRemittances` (with aging). `recordPayrollRemittance` creates the record on demand for pre-ledger batches; backfill script `scripts/migrations/004_backfill_payroll_remittances.ts` (dry run by default). Ops screen `/ops/remittances`. Contract in `docs/runbooks/payroll-remittances.md`. | merged, reviewed (approved first round) |
| `swarm3/cleanups` | Load config example no longer production; `npm run load-test*` run a friendly preflight; Gen-2 `run.app` production hosts refused; `check-production-health.mjs` row logic unit-tested; metamap retry tests on fake timers. | merged, reviewed (approved first round) |
| `swarm3/load-prep` | `tests/load/seed/`: deterministic load-test pool seed and teardown (emulator by default, production project refused with no override), k6 script reads the pool and exchanges the App Check debug token, emulator rehearsals, and a rewritten load section in `docs/runbooks/scaling.md` with the full third-party provider inventory. | merged, reviewed + repaired (first review blocked on an incomplete provider inventory and teardown missing Stage 5 rows) |
| `swarm2/lighthouse-perf` | Marketing pages measured locally at Lighthouse performance 0.95–0.98 median (was 0.71–0.73; LCP 5.7–6.3 s → 2.1–2.7 s). `performance` in `public-v2/lighthouserc.json` is now `error`. Delivery only: self-hosted preloaded fonts, WebP stills at the same dimensions with per-route hero preload, Firebase/auth behind a lazy `PortalAuth` wrapper, lazy English copy (3 s timeout falls back to Spanish), hero film after load, a Web Animations page transition. | merged, reviewed + repaired (the blocking finding on the page transition was rebutted with evidence; the re-review approved) |

Orchestrator commit on top: the load-target guard refuses userinfo URLs (`localhost:x@<prod host>`
used to read as the emulator) and trailing-dot production hosts; `amountCents` capped at the safe
integer range; stale E18 sentence in `AUDIT_EMPLOYER_PATH.md` fixed.

Local results on the integration branch: functions 1116/1116, public-v2 402/402 (after the Lighthouse merge), underwriting
452/452 (1 skipped, as before), migrations 58/58, node tests (health, load target, seed) 120/120,
lint 0 errors everywhere. Rules emulator suite 182/182 on the remittance branch (hard gate in CI).

**Merging this branch deploys two new callables** (`voidPayrollRemittanceReceipt`,
`listPayrollRemittances`; `deploy.yml` FUNCTIONS list was extended) and the ops screen.

## 2. Next steps, in order
1. Get the PR for `hardening/remittance-ops-load-prep` green. Merge only with the user's go-ahead
   (production deploy), then dispatch `verify-production-live.yml`.
2. Lighthouse, still open: the scores were measured on a Mac; `/` had one 0.93 run, so watch the CI Lighthouse job. Nobody has looked at the rendered pages: WebP stills against the JPEGs, self-hosted fonts, and the route fade need a visual check. The first-load fade-in from 0 was removed for LCP. `BoardPhoto` can show only its scrim on a very fast scroll.
3. Remittance, still open (reviewer notes, none blocking):
   - The ops screen was never looked at in a browser. `public-v2` has no emulator wiring, so a
     local dev server talks to production Firebase; the visual check needs a human with an ops
     login, or emulator wiring first.
   - `listPayrollRemittances` reads at most 500 docs before sorting; needs an ordered query or pagination before volumes get there.
   - No scheduled alert for remittances that stay unpaid; the 7-day grace period is a display default, not an agreed term.
   - The backfill does not build reference-index entries for receipts booked before the index existed, and has only run against an in-memory double.
   - `receivedOn` has no lower bound; `voidedAt` is shown as the UTC date; `invalid-argument` details reach ops in English.
4. Load test, still open:
   - `tests/load/pipeline-load-test.js` has never run under k6 (k6 is not installed here). First run it on the emulator (runbook step 2).
   - The "~2,800 uids" figure was wrong: a uid with an open loan is refused, so one uid yields one accepted request. The seed default is 12,500.
   - Runbook setup B (full pipeline) is marked not cleared: Stage 5 calls Anthropic with no mock, and a named person must check the provider list first.
   - `appCheckPlan` should refuse `FIREBASE_PROJECT_ID=vida-finance` and back off after a failed exchange; the "no project id containing `prod`" rule should move up to runbook step H1; re-seeding with a larger `--count` while loans are open reshuffles members across employers.
5. Deferred owner decision: Stage 0 treats `credit_status:"closed"` with `balance > 0` as active.

## 3. Needs a human (do not fake these)
- **Load test prerequisites:** create the non-production Firebase project (its id must not contain `prod`), register the App Check debug token, and set the load-test password. Steps are in `docs/runbooks/scaling.md`.
- **Gen-2 host guard:** confirm in the GCP console that vida-finance's Cloud Run hash is `gd5fcu677q` and its project number is `447766605132` (the hash answered `/health` with 200, which is the only evidence so far).
- **Backfill 004:** running it against production needs an explicit go-ahead and `--allow-production`.
- **Ops remittance screen:** visual check with an ops login.
- **D1:** confirm the billing cause using billing account `01B681-29512A-745C5D`'s payment history, and see who granted indexAdmin on 2026-08-03. The exact `gcloud logging read` commands are in the checklist D1 section. The deploy SA cannot read those logs. Add a billing-state alert.
- **D5:** run migration 002 against production, then remove the `auditLogs` read rule. Do this only with the sign-offs named in `docs/runbooks/audit-log-consolidation.md`. The commands are in that runbook.
- **B8:** a production load test (smoke profile only, with ops sign-off and a dedicated load-test employer).
- **Section B items:** B1–B11 depend on live infrastructure or third parties. They stay unticked until their owners verify them.
- The local `railway` CLI login (romaysacromay@gmail.com) cannot see the FunPay Railway project.

## 4. How the work was run (repeat the same way)
- **Multi-agent "swarm" via the Workflow tool:** one agent per area in an isolated git
  worktree on its own branch (`swarm/*` from #635, `swarm2/*` for #636, `swarm3/*` after that), then
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
