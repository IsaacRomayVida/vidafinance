You're continuing work on FunPay (repo `IsaacRomayVida/vidafinance`, folder `/Volumes/PortableSSD/Suena/Funpay`). It's an employee microcredit platform for a Mexican SOFOM: loans are repaid through payroll deduction. Earlier Claude sessions (on other accounts) have been getting the whole system production-ready. You're picking up exactly where the last one stopped, without its conversation history.

**First, read `docs/HANDOFF.md` in full, from the branch `docs/handoff-production-ready`.** It is the authoritative record of what shipped, what's open, what needs a human, and how the work is run. The up-to-date copy lives on that branch until its PR merges; `main` has an older one. Read it with `git show origin/docs/handoff-production-ready:docs/HANDOFF.md`, or check the branch out.

Then confirm it still matches reality:

```bash
git fetch origin && git status -sb && git log --oneline -5 origin/main
gh pr list --state open
gh run list --branch main --limit 10
```

**State as of 2026-10-16:**
- **Merged and deployed to production:** PRs #635–#640. After each deploy, `verify-production-live.yml` was dispatched and passed, and the scheduled production checks have kept passing.
  - #636: INFONAVIT gate, E18 remittance ledger, registry monitoring. #637: remittance void/dedupe, `/ops/remittances`. #638: paginated remittances, daily `remittanceOverdueCheck`, k6 emulator smoke.
  - #639: stage 0 treats a `credit_status:"closed"` INFONAVIT credit as closed even with a leftover balance.
  - #640: remittance alerts close on payment and re-raise after a void, page caps, server-side totals; load-test guards; marketing fixes; underwriting `/health` commit field and the dispatch-only `deploy-underwriting.yml`.
- **Underwriting-service on Railway** was deployed on 2026-10-16 to `0543a8c` (it had been on `8259bd0` from 2026-09-18). Since #641, `deploy-underwriting.yml` deploys it on every push to `main` touching its build inputs; check that run after any underwriting merge.
- **Slack:** `SLACK_WEBHOOK_URL` is not a GitHub secret, so overdue alerts only appear in the ops alerts page.
- **Open PRs:** none expected once #641 (handoff + underwriting push trigger) merges.

**What to do:**
1. Report the verified current state to the user in a few lines.
2. Work through handoff section 2: the small swarm5 follow-ups.
3. List the human-only items in handoff section 3 precisely; never fake their evidence.

**How the user wants you to work:**
- **Parallel work:** use multi-agent workflows (a "swarm") with the Workflow tool.
  - Give each agent its own worktree and branch (next prefix: `swarm6/*`).
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
