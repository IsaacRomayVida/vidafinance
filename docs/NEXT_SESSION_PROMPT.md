You're continuing work on FunPay (repo `IsaacRomayVida/vidafinance`, folder `/Volumes/PortableSSD/Suena/Funpay`). It's an employee microcredit platform for a Mexican SOFOM: loans are repaid through payroll deduction. A previous Claude session (on another account) was getting the whole system production-ready, and you're picking up exactly where it stopped.

**Read `docs/HANDOFF.md` first, in full.** It's the authoritative record of what shipped, what's in flight, what's next, what needs a human, and how the work was run. Then check that it still matches reality: `git status`, `git log --oneline -10`, `gh pr list --state open`, `gh pr checks 636`, `gh run list --branch main --limit 10`.

State in brief:
- PR #635 is merged and deployed to production, and production verification passed.
- PR #636 (`hardening/launch-followups`) is open. It covers the INFONAVIT gate fix, the E18 remittance ledger, registry monitoring, the D1 deploy-403 diagnosis, and load-test and migration prep.
- The Lighthouse performance work (`swarm2/lighthouse-perf`, worktree `.claude/worktrees/wf_647440a8-1e8-2`) was still running when the last session ended. Check whether it left any commits or uncommitted changes. If not, redo it.

Continue with the next steps in section 2 of the handoff, in that order:
1. Get #636 green and merged. **Merging to `main` deploys to production**, and I've authorised you to merge it once CI is fully green. After merging, dispatch `verify-production-live.yml` and confirm it passes.
2. Finish the Lighthouse performance work.
3. Remittance follow-ups: the ops UI, a backfill, voiding a receipt, `bankReference` normalisation, and date validation.
4. The small cleanups listed in the handoff.
5. Load-test prerequisites (seeding, the App Check debug token, a non-production target).

How I want you to work:
- Use multi-agent workflows (a "swarm") for parallel work. Give each agent its own worktree and branch, run an adversarial reviewer on every branch that re-runs the tests, and send a repair agent when the review blocks. Then merge the approved branches into a `hardening/*` branch, run the full suites locally, push, and open a PR.
- Verify against the current code before fixing anything, because the audit docs go stale.
- Every fix needs a test that would fail if the fix were reverted.
- Commit messages use a lowercase area prefix and have **no attribution or co-author lines**.
- Never send load or writes to production. Never change IAM, billing or secrets. Never fake evidence for checklist items that need a human; list them precisely instead (section 3 of the handoff).
- Keep `docs/HANDOFF.md` updated as you go, so the next handoff is easy.

Start by reporting the verified current state in a few lines, then get going.
