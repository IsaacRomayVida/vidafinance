---
name: review-pr
description: Self-review a PR before pushing for external review. Catches what you miss after staring at your own diff. Use before declaring a PR ready, or after a WIP push for a sanity check. Runs diff analysis, convention checks, smoke-test checklist.
---

# /review-pr

Last gate before a PR goes out. You've been close to this code — step back, look as a stranger would.

## Ask once

- **PR number or branch name?** (e.g. `#341` or `auto/vid3-712-...`)
- **Or:** review the currently staged/committed changes on current branch?

## Review

### Step 1 — Diff inspection

```bash
git diff main --stat
git diff main -- <file>
```

Note:
- **Files changed:** > 15 is usually too many. Ask if Isaac wants to split
- **Lines changed:** > 500 insertions = heavy. Acceptable for new features, concerning for bug fixes
- **Mixed concerns:** `public-v2/` AND `functions/` AND `services/` → PR doing too much
- **Unrelated changes:** stray whitespace, formatting in unrelated files → flag for cleanup

### Step 2 — Per-file review

| File type | Rules to apply |
|---|---|
| `public-v2/src/**/*.tsx` | Rules 01, 02, 03, 06 (+ 04 if Firebase) |
| `public-v2/src/**/*.ts` (non-UI) | Rules 01, 03 (+ 04 if Firebase) |
| `public-v2/src/styles/**/*.css` | Rule 02 (visual language), rule 05 |
| `public-v2/src/i18n/*.json` | Rule 06 (Spanish copy) |
| `functions/src/**/*.ts` | Rule 05 (App Check, rate limits, secrets) |
| `firestore.rules` / `storage.rules` | Rule 05 — flag unless a ticket explicitly covers rules changes |
| `package.json` | Rule 05 invariant 12 — justify new deps |
| `.env.example` | OK — ensure values are placeholders |
| `.env*` (not `.example`) | Never in a PR — REJECT |
| `firebase.json` | Rule 05 — CSP/hosting changes need extra care |

### Step 3 — Convention checks

- [ ] Conventional commits, scoped, with VID3-XXX ref
- [ ] Branch name: `auto/vid3-XXX-...` or `isaac/vid3-XXX-...`
- [ ] No `console.log` / `console.warn` in prod code (unless intentional — tag with TODO + ticket)
- [ ] No `TODO` without a ticket reference
- [ ] No commented-out code
- [ ] No `@ts-ignore` (use `@ts-expect-error` with comment, or fix properly)
- [ ] No `any`
- [ ] No hard-coded values that should be constants
- [ ] No secrets (search for `sk-`, `AIza`, `client_secret`, long hex strings)

### Step 4 — Test locally

```bash
git fetch origin
git checkout <branch>
cd public-v2 && npm install && npm run build
```

If CF changes:
```bash
cd functions && npm install && npm test
```

Run the app:
```bash
cd public-v2 && npm run dev
# http://localhost:3000
```

Navigate to the affected page. Spot-check:
- [ ] Intended change works
- [ ] No regression on adjacent functionality
- [ ] Error paths work
- [ ] Loading states appear for > 300ms waits

### Step 5 — CI status

```bash
gh pr view <num> --json statusCheckRollup
```

Every required check green. If red:
- Lint → fix
- Type → fix
- Test failure → diagnose (flaky vs real)
- Build → fix
- Deploy → check logs

### Step 6 — Security / privacy sweep

VIDA-specific:
- [ ] No PII in logs or error messages
- [ ] App Check enforcement not weakened
- [ ] Rate limiting not removed
- [ ] Rules files unchanged (or changed with test coverage)
- [ ] No `fetch()` to CFs — should be `httpsCallable`
- [ ] Spanish error messages don't leak stack traces or IDs

### Step 7 — Design critique (for UI changes)

Run `@design-critic` on changed components. Apply 🔴 must-fix. Note 🟡 should-fix in PR description.

### Step 8 — PR description checklist

- [ ] **Summary** (2-3 lines, what + why)
- [ ] **Changes** (bullet list)
- [ ] **Screenshots** for UI changes — before + after, mobile + desktop minimum
- [ ] **Verification** checklist (what was tested)
- [ ] **Linear ref** (`Refs VID3-XXX` or `Closes VID3-XXX`)
- [ ] **Breaking changes** noted if any
- [ ] **Rollback plan** if risky

## Output

```markdown
# PR review: <branch or #number>

## Overall: <Ready to merge / Ready with fixes / Needs rework / Scope concern>

<1-2 sentence verdict>

## Diff stats
- Files changed: N
- Insertions: +N
- Deletions: -N
- Primary scope: public-v2 / functions / both / other

## Findings

### 🔴 Must fix before merge
1. <item>

### 🟡 Should fix
1. <item>

### 🔵 Consider
1. <item>

## CI status
- <check>: ✅/❌

## Verification done
- [x] Built locally
- [x] Ran app, exercised change
- [x] <other checks>

## Design critique (if UI)
<@design-critic summary, or N/A>

## Suggested PR description
<edited/completed PR description ready to paste>
```

## Principles

- **Be specific.** "This component looks off" useless. "Button label is 'Enviar' but flow is a loan request — should be 'Solicitar préstamo' per rule 06 — LoanForm.tsx:84" useful
- **Catch structural issues early.** PR doing wrong thing → say so before nitpicking quotes-vs-template-literals
- **Don't ship in doubt.** Test flaky + unsure if real behavior correct → pause, don't merge on hope
- **Know when to stop.** PR is good enough eventually. Don't gate-keep perfection.
