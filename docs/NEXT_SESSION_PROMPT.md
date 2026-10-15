You're continuing work on FunPay (repo `IsaacRomayVida/vidafinance`, folder `/Volumes/PortableSSD/Suena/Funpay`). It's an employee microcredit platform for a Mexican SOFOM: loans are repaid through payroll deduction. Earlier Claude sessions (on other accounts) have been getting the whole system production-ready. You're picking up exactly where the last one stopped, without its conversation history.

**First, read `docs/HANDOFF.md` in full, from the branch `hardening/stage0-closed-credit`.** It is the authoritative record of what shipped, what's open, what needs a human, and how the work is run. The up-to-date copy lives on that branch until PR #639 merges; `main` has an older one. Read it with `git show origin/hardening/stage0-closed-credit:docs/HANDOFF.md`, or check the branch out.

Then confirm it still matches reality:

```bash
git fetch origin && git status -sb && git log --oneline -5 origin/main
gh pr list --state open
gh pr checks 639
gh run list --branch main --limit 10
```

**State as of 2026-10-15:**
- **Merged and deployed to production:** PRs #635, #636, #637 and #638. After each deploy, `verify-production-live.yml` was dispatched and passed, and the scheduled production checks have kept passing.
  - #636: INFONAVIT gate, E18 remittance ledger, registry monitoring.
  - #637: remittance void and dedupe, the ops screen `/ops/remittances`, Lighthouse performance gate set to `error`, load-test seed tooling.
  - #638: paginated remittance list, daily `remittanceOverdueCheck`, `public-v2` emulator wiring, a k6 smoke run on the emulator (90/90 accepted), marketing polish.
- **Production indexes:** the three `payrollRemittances` indexes added by #638 are `READY`.
- **Backfill 004:** a read-only dry run against production found 0 payroll batches, so no backfill is needed.
- **Slack:** `SLACK_WEBHOOK_URL` is not a GitHub secret, so overdue alerts only appear in the ops alerts page.
- **Open: PR #639** (`hardening/stage0-closed-credit`). Stage 0 treats an INFONAVIT credit with `credit_status:"closed"` as closed even when it shows a leftover balance. CI is green. It changes who gets approved, so **do not merge it until the user explicitly says "merge 639"**.

**What to do:**
1. Report the verified current state to the user in a few lines.
2. If the user authorises it, merge #639. Merging to `main` deploys to production, so watch the `VIDA Platform — Deploy` run, then dispatch `gh workflow run verify-production-live.yml --ref main` and confirm it passes.
3. Then work through section 2 of the handoff in order:
   - remittance leftovers: alert resolution, server-side totals, a page cap on the overdue loop;
   - load-test hardening;
   - the marketing stage-panel gap and the `<html lang>` mismatch.
4. Ask the user before removing the old `.claude/worktrees/wf_*` worktrees and the `swarm*/*` branches. They are all merged.

**How the user wants you to work:**
- **Parallel work:** use multi-agent workflows (a "swarm") with the Workflow tool.
  - Give each agent its own worktree and branch (next prefix: `swarm5/*`).
  - Run an adversarial reviewer on every branch that re-runs the tests and revert-checks the fixes.
  - Send a repair agent when a review blocks.
  - Merge the approved branches into a `hardening/*` branch off `main`, run the full suites locally (commands are in handoff section 5), push, and open a PR.
  - The user asked for agents on Opus 5.5.
- **Verify before fixing:** check against the current code before fixing anything, because the audit and handoff notes go stale.
- **Tests:** every fix needs a test that would fail if the fix were reverted.
- **Commits:** messages use a lowercase area prefix (`functions: …`, `public-v2: …`, `load: …`, `docs: …`) and have **no attribution or co-author lines**.
- **Merging:** merging to `main` deploys to production. Merge only with the user's explicit go-ahead for that specific PR, and only when CI is fully green. Use `gh pr merge <n> --merge --match-head-commit <sha>`.
- **Production limits:**
  - Never send load or writes to production. Never change IAM, billing or secrets.
  - Read-only production checks may use the user's Application Default Credentials. If those have expired, ask the user to run `gcloud auth application-default login`.
  - Do not use the admin service account the `gcloud` CLI is signed in as unless the user agrees.
  - Never sign in or enter passwords for the user.
- **Human-only items:** never fake evidence for checklist items that need a human. List them precisely instead, as handoff section 3 does.
- **Handoff:** keep `docs/HANDOFF.md` and this file updated as you go, so the next handoff is easy.
