# VIDA Finance — Current State Snapshot

Goes in `.cursor/context/CURRENT_STATE.md`. Any new Cursor chat reads this and has situational awareness.

## Where we are (2026-04-19)

- **Launch target:** 2026-05-31 (v1.8.0)
- **Repo:** `IsaacRomayVida/vidafinance`, monorepo
- **Main tip:** `d975bb0`
- **Production:** all 6 Railway services + Firebase Hosting green
- **Last security audit:** AUDIT-2 PASS (VID3-700)

## Real stack (verified)

**Frontend — `public-v2/`:**
- React 19.2, TypeScript 5.9, Vite 8
- Tailwind CSS v4 (config in `src/styles/index.css` via `@theme` block — NO `tailwind.config.js`)
- **Dev server: port 3000**
- Build: `tsc && vite build`
- Firebase SDK 12.11
- react-router-dom 7, i18next + react-i18next 16, react-helmet-async 3, papaparse 5
- **No test runner, no form library, no clsx**

**Backend — don't modify from frontend task:**
- `functions/` — 36 callable CFs, all `enforceAppCheck: true` + rate-limited
- 6 Railway services under `observant-miracle`

## Design tokens (from `src/styles/index.css` @theme)

**Teal scale** (primary brand):
`teal-50` `teal-100` `teal-200` `teal-300` `teal-400` `teal-500` `teal-600` `teal-700` `teal-800` `teal-900` (#194445 — primary) `teal-950`

**Gold scale** (accent):
`gold-50` through `gold-950`. `gold-500` = #a28657.

**Fonts:**
- Body: DM Sans (`font-sans` via `@theme`)
- Headings: DM Serif Display (inline `style={{fontFamily:...}}` or `var(--df)` from legacy.css)

**Legacy CSS variables** (in `src/styles/legacy.css`):
`--brand`, `--brand-mid`, `--brand-light`, `--gold`, `--aqua`, `--aqua-soft`, `--bg`, `--bg2`, `--canvas`, `--t1`, `--t2`, `--t3`, `--danger`, `--success`, `--df`, `--db`, `--mx`

## Route map

| Route | Page component | Auth |
|---|---|---|
| `/` | HomePage | public |
| `/employers` | EmployerPage | public (B2B pitch) |
| `/employees` | EmployeePage | public (B2C pitch; **plural!**) |
| `/about` `/security` `/privacy` `/terms` `/partners` `/investors` `/contact` `/press` | *Page | public |
| `/login` | Login | public |
| `/onboarding` | Onboarding | public (employee invite-accept) |
| `/get-started` | → `/contact` | redirect |
| `/employee` | EmployeeDashboard | `employee` |
| `/employee/apply` | LoanWizard | `employee` |
| `/employee/loans` | MyLoans | `employee` |
| `/employer` | EmployerDashboard | `employer_admin` |
| `/employer/employees` | EmployeeRoster | `employer_admin` |
| `/employer/deductions` | DeductionReports | `employer_admin` |
| `/employer/payroll` | PayrollUpload | `employer_admin` |
| `/employer/analytics` | AnalyticsPage | `employer_admin` |
| `/employer/onboarding` | OnboardingWizard | `employer_admin` |
| `/ops` | AdminDashboard | `ops`/`admin`/`super_admin` |
| `/ops/review-queue` | ReviewQueue | ops |
| `/ops/review-queue/:id` | ReviewDetail | ops |
| `/ops/portfolio` | PortfolioPage | ops |
| `/ops/employers` | EmployerMgmt | ops |
| `/ops/alerts` | AlertsPage | ops |
| `/ops/health` | SystemHealth | ops |
| `/admin` / `/admin/*` | → `/ops` | redirect |
| `*` | NotFound | catch-all |

## What blocks the launch (Isaac-only, no code left)

1. **VID3-663** — ML go/no-go decision (recommended Path B: `ML_MODE=manual_review_all`)
2. **VID3-676** — Register App Check + reCAPTCHA Enterprise key (Firebase Console + GCloud)
3. **VID3-659** — MetaMap production credentials (vendor conversation)
4. **VID3-675** — Twilio + SendGrid template approval (24-48h Meta cycle)
5. **VID3-636** — Cutover day env flag flips (5 min when everything ready)

Everything that CAN be pre-written is written, merged, flag-gated.

## Patterns to respect (intentional, don't "clean up")

- **`Onboarding.tsx` vs `OnboardingWizard.tsx`** — both routed, different purposes (employee invite-accept vs employer setup wizard). Keep both.
- **Emoji as icons** in some marketing sections — no icon library yet. Don't add more; replace when redesigning a section.
- **No test runner** — Vitest/Jest not wired. Adding tests requires a ticket to wire the runner first.
- **Two CSS files** (`styles/index.css` + `styles/legacy.css`) — consolidation is done, don't add a third.
- **MetaMap is the sole KYC provider.** Verifik was removed in PR #346. Don't reintroduce a separate SAT taxpayer-status check — individual SAT is covered by MetaMap's gov-check in Stage 4; employer SAT status is inferred from EFOS + Art. 69 (both SAT-sourced) in Stage 0. Regulatory counsel sign-off pending (VID3-719).
- **Employer screening is 4 signals**, not 5: EFOS + Art. 69 + DENUE + REPSE. Don't re-add Verifik or a new SAT-active provider without checking VID3-719 resolution first.

## Shared infrastructure in place (use, don't re-invent)

- **`@/lib/safeStorage`** — `safeGetItem`, `safeSetItem`, `safeRemoveItem` with try/catch. Use instead of raw `localStorage.*`. Shipped PR #343.
- **Per-portal `<ErrorBoundary>`** in App.tsx — 8 boundaries total (global + 4 layouts + 3 standalone routes). Shipped PR #343.
- **Global `:focus-visible`** baseline in `styles/index.css` — applies to all interactive elements. Shipped PR #344.
- **`useRevealOnScroll`** respects `prefers-reduced-motion`. Shipped PR #343.

## Recent commits (most recent first)

- `d975bb0` — Remove Verifik, standardize KYC on MetaMap (PR #346)
- `bf2d9fa` — DENUE INEGI v4.2 API + token auth (PR #345, VID3-640 follow-up)
- `2ad92a0` — Global `:focus-visible` baseline (PR #344, VID3-715 PR A)
- `1f75a1a` — safeStorage + reduced-motion + per-portal ErrorBoundary (PR #343, VID3-714)
- `6dc6209` — Delete 3 orphan files + tighten 2 any types (PR #342)

## Frontend work available now (no blockers)

1. **VID3-715 PR B + PR C** — a11y baseline continuation. PR A (focus-visible) done. PR B = form label associations across 44 inputs. PR C = aria-labels on icon-only buttons + color-only status fixes.
2. **Polish passes** on existing pages — apply design system consistently
3. **Pre-launch E2E tests** (VID3-632) — Playwright/Puppeteer suite
4. **Runbook** (VID3-635)
5. **Post-launch polish backlog** (VID3-562 WebP, 563 JSON-LD, 621 a11y, 622 mobile QA)

## Don't start

- Anything requiring reCAPTCHA live — blocked on VID3-676
- MetaMap E2E (VID3-660) — blocked on VID3-659
- Notification E2E (VID3-628) — blocked on VID3-675

## Development commands

```bash
# Frontend
cd public-v2 && npm run dev          # http://localhost:3000
cd public-v2 && npm run build        # must pass before PR

# Backend (if touching)
cd functions && npm test              # 213 tests must pass
firebase emulators:start              # local full stack

# Railway (if touching services)
railway link -p observant-miracle
railway service <service-name>
railway variables --set "KEY=value"
```

## Repo layout

```
.
├── public-v2/            ← frontend (React 19 + Vite 8 + Tailwind v4)
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/ (singular — marketing)
│   │   │   ├── layouts/ (plural — portals)
│   │   │   ├── marketing/
│   │   │   └── shared/
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── lib/firebase.ts
│   │   ├── i18n/{es,en}.json + index.ts
│   │   └── styles/{index,legacy}.css
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── functions/            ← Cloud Functions (TS)
│   └── src/{index.ts, webhooks/, utils/}
├── services/             ← Railway (Python + Node)
│   ├── softcredito-adapter/
│   ├── payment-server/
│   ├── pdf-generator/
│   ├── notification-service/
│   ├── underwriting-service/
│   └── ml-service/
├── firestore.rules       ← locked
├── storage.rules         ← locked
├── firestore.rules.test.ts  (61 tests)
├── firebase.json         ← CSP + headers
├── .github/workflows/deploy.yml
└── .cursor/              ← this config kit
    ├── rules/
    ├── skills/
    ├── subagents/
    ├── commands/
    └── context/CURRENT_STATE.md
```
