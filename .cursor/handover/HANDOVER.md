# VIDA Finance — Handover

You're picking up the build of VIDA Finance. This doc gets you oriented in 5 minutes. Read it first, then follow the pointers.

**Last updated:** 2026-04-21  
**Main tip:** `d975bb0`  
**Launch target:** 2026-05-31 (v1.8.0)  
**Production:** green (all 6 Railway services + Firebase Hosting/Functions 200)

---

## What VIDA is (the 60-second version)

Payroll-deducted microcredit for Mexican tier-1 workers. B2B2C:

- **Employers** enroll their company (KYC + compliance checks)
- **Employees** get invited, sign up, apply for loans (MXN 500–5,000)
- **Underwriting** auto-decides most, escalates edge cases to manual review
- **Disbursement** via SPEI (through SoftCredito adapter) to employee CLABE
- **Repayment** via payroll deduction — employer deducts and remits to us

Regulated as **SOFOM E.N.R.** under CNBV/CONDUSEF. Target: ~$6M disbursed year 1, ~24,000 loans.

---

## Read these in order

1. **`LAUNCH_CHECKLIST.md`** — what's done, what's left, priority order  
2. **`PROVIDER_TRACKER.md`** — every vendor, what to ask them, current status  
3. **`FIRST_WEEK.md`** — exactly what to do day 1 through day 7  
4. **`DECISIONS.md`** — architectural choices already made (do not re-open these)  
5. **`GLOSSARY.md`** — VIDA/fintech/Mexican-specific terms  
6. **Cursor config kit** (parent `cursor-config/`) — rules, skills, commands for day-to-day work

---

## Who does what

Three "roles" do work on VIDA. Handover is about making sure each has what they need.

### You (Isaac — founder / product)

Only you can do:
- Send vendor emails from your account
- Sign contracts and accept pricing
- Make product/business judgment calls (launch scope, pricing, risk appetite)
- Get counsel sign-off on regulatory questions
- Sign first employers

### Cursor (inside your repo, day-to-day)

Rules, skills, commands in `.cursor/` auto-engage when you open files. Use `/ship-component`, `/polish-page`, `/review-pr`. Good for frontend work and small backend fixes.

### Cyrus (background agent, delegated tickets)

Assigned to most Linear tickets with `delegate: Cyrus`. Picks up work without supervision. Good for mechanical refactors, test writing, doc generation.

### Claude chat (this interface)

Best for: architectural decisions, multi-file changes, vendor integrations, provider credential wiring, strategy discussions. Use when the task needs a conversation, not a self-contained ticket.

---

## Current state at a glance

**✅ Built, deployed, working:**
- 6 Railway services (all healthy)
- Firebase Hosting + 36 callable Cloud Functions
- Firestore rules (hardened, 61 tests) + Storage rules
- Employer screening stack (4 signals: EFOS + Art. 69 + DENUE + REPSE)
- Employee invite flow (send → lookup → accept)
- Loan wizard + underwriting pipeline (7 stages)
- Contract generation + MetaMap e-sig (flag-gated)
- SPEI disbursement via SoftCredito
- Notification service (WhatsApp + email, templates pending)
- Admin/ops review queue
- Rate limiting on 31 callables + App Check infrastructure
- Frontend: React 19, Tailwind v4, global focus-visible, per-portal error boundaries, safe localStorage

**⚠️ Built but not verified end-to-end:**
- MetaMap signing (flag off until creds arrive)
- RiskSeal integration (never tested live — VID3-713)
- Notification delivery (templates pending — VID3-628)

**❌ Not done:**
- Full E2E test (VID3-632)
- Load test (VID3-633)
- Security audit (VID3-634)
- Deploy runbook (VID3-635)
- A11y PR B+C (VID3-715) — form labels + aria-labels
- Counsel regulatory sign-off (VID3-719)

**🔴 Blocking everything until done:**
- reCAPTCHA Enterprise key (VID3-676) — without it, all authenticated CFs return 401 to real users

---

## The four numbers that matter

| Metric | Today | Launch target |
|---|---|---|
| PRs merged this week | 4 (#342-346) | — |
| Linear Todo tickets | ~10 | 0 |
| Production uptime | 100% | 99.9% |
| Days to launch | ~40 | 0 |

---

## Gotchas — things that will waste your time if you don't know them

1. **Dev server runs on port 3000, not Vite's default 5173.** Set in `vite.config.ts`.
2. **Tailwind v4** — config lives in `src/styles/index.css` `@theme` block, NOT a `tailwind.config.js`. Class names like `bg-teal-900`, `bg-gold-500` are auto-generated. Don't look for the config file, it isn't there.
3. **No test runner on the frontend.** Adding tests requires a ticket to wire Vitest first.
4. **Pages use named exports**, not default — required for the `React.lazy(() => import().then(m => ({ default: m.X })))` pattern in `App.tsx`.
5. **`Onboarding.tsx` AND `OnboardingWizard.tsx` both exist and are both routed** — different purposes (employee invite-accept vs employer setup). Don't "consolidate" them.
6. **`useAuth` has complex token-refresh + Firestore fallback** — don't simplify it. It's load-bearing for role resolution across portals.
7. **App Check is flag-gated** on `VITE_RECAPTCHA_SITE_KEY`. Until that env var is set in GitHub secrets, all real-user CF calls get 401. Local dev needs the debug token.
8. **Raw `localStorage` will throw** in Safari private mode. Use `@/lib/safeStorage`.
9. **No new third CSS file.** Use `styles/index.css` (Tailwind) or `styles/legacy.css` (legacy classes). Two files is intentional.
10. **MetaMap is the sole KYC provider.** Verifik was removed. Do not reintroduce it or add a parallel SAT check without reading VID3-719.

---

## Emergency: production is down

1. Check Railway services: `railway service <name> && railway logs` for each of 6 services
2. Check Firebase: `firebase functions:log`
3. Check GitHub Actions for most recent deploy status
4. If a Railway service is the culprit, rollback via Railway dashboard (one-click)
5. If a Cloud Function is the culprit, `firebase deploy --only functions:<name>` with a reverted commit
6. Full rollback: `git revert <sha>` on main → auto-deploys

Isaac's emergency contact: — **(add your WhatsApp/phone here before handing off)**

---

## Where to find things

| What | Where |
|---|---|
| The repo | `IsaacRomayVida/vidafinance` |
| Production frontend | https://vida-finance.web.app |
| Linear workspace | linear.app/vidateam |
| Sprint 4 project | `VIDA v1.8 — Launch Sprint` |
| Railway project | `observant-miracle` |
| Railway ID | `1ad040b4-6f0b-4530-9f58-0a1ef5e89c75` |
| Firebase project | `vida-finance` |
| Business plan | `/mnt/project/Business_plan_VIDA_1_6.pdf` (in Claude project) |
| Engineering playbook | `/mnt/project/VIDA_Engineering_Playbook.docx` |
| ML paper | `/mnt/project/VIDA_ML_Paper.docx` |
| Project context v1.7 | `/mnt/project/VIDA_Project_Context_v1_7.md` |

---

## Last thing

**The single most important next action is:** get the reCAPTCHA Enterprise site key into the `VITE_RECAPTCHA_SITE_KEY` GitHub secret and redeploy. Nothing works for real users until that happens. It's self-serve, takes 30 minutes, and it's on Isaac's plate (VID3-676).

After that, the launch is blocker-limited, not work-limited. Every vendor email sent earlier = launch on time. Every day of delay on vendor outreach = one day slip.

Good luck.
