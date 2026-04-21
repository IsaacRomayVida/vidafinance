# VIDA v1.8 Launch Checklist

Ground truth for what's done, what's in flight, what's left. As of 2026-04-21. Launch: 2026-05-31.

## The rule

An item is ✅ only if: code merged to main AND deployed to production AND verified working end-to-end with real data (not mocks).

---

## DONE ✅

### Infrastructure
- ✅ Firebase project, Firestore, Storage, Auth, Functions, Hosting — all deployed
- ✅ Railway project `observant-miracle` with 6 services running
- ✅ GitHub Actions deploy pipeline
- ✅ CSP + security headers on Firebase Hosting
- ✅ Firestore rules hardened (61 unit tests)
- ✅ Storage rules with per-loan/KYC/payroll path scoping
- ✅ App Check infrastructure (flag-gated on env var)
- ✅ Rate limiting on 31/31 user-facing callables (10-60/min tiered)

### Pipeline (7 stages)
- ✅ Stage 0 — Employer screening (4 signals: EFOS, Art. 69, DENUE, REPSE)
- ✅ Stage 1 — Individual identity (format validation + age from CURP)
- ✅ Stage 2 — Bureau + employment (Belvo integration)
- ✅ Stage 3 — Auto-approve gate
- ✅ Stage 4 — Full KYC (MetaMap biometrics)
- ✅ Stage 5 — Manual review queue
- ✅ Stage 6 — Contract generation

### Integrations (live)
- ✅ SoftCredito SPEI adapter (creds set)
- ✅ MetaMap webhook with HMAC signature verification
- ✅ MetaMap signing client (flag-gated `METAMAP_SIGNING_ENABLED=false`)
- ✅ DENUE INEGI v4.2 API with token (PR #345)
- ✅ Google Document AI (payroll slip OCR)
- ✅ ML model flag-gated via `ML_MODE` env var

### Frontend
- ✅ React 19 + Tailwind v4 + Vite 8 stack
- ✅ All 30+ routes wired (marketing, auth, employee, employer, ops)
- ✅ Employee invite flow (Onboarding.tsx)
- ✅ Loan wizard
- ✅ Employer roster + payroll upload + deductions UI
- ✅ Admin review queue UI
- ✅ i18n (es/en, ~150 flat keys)
- ✅ `@/lib/safeStorage` helper (PR #343)
- ✅ Per-portal `<ErrorBoundary>` (PR #343)
- ✅ Global `:focus-visible` baseline (PR #344, VID3-715 PR A)
- ✅ `useRevealOnScroll` respects `prefers-reduced-motion` (PR #343)

### Cleanup
- ✅ Mifiel removed (PR #308, VID3-644) — MetaMap handles e-sig
- ✅ Verifik removed (PR #346, VID3-719 for counsel) — MetaMap handles KYC
- ✅ 3 orphan files deleted (PR #342)
- ✅ 2 `catch (e: any)` tightened (PR #342)

---

## IN REVIEW / IN PROGRESS 🟡

- 🟡 **VID3-567** — Sprint 4 launch readiness epic (In Review)
- 🟡 **VID3-636** — Production cutover to v1.8.0 (In Review)
- 🟡 **VID3-714** — Install Cursor config kit (In Progress — this kit)
- 🟡 **VID3-715** — A11y baseline (In Progress — PR A done, PR B+C remain)

---

## BLOCKING LAUNCH — Isaac-only external 🔴

All of these require Isaac personally. They are ordered by urgency.

### 1. VID3-676 — reCAPTCHA Enterprise site key [SELF-SERVE, 30 min]
Everything returns 401 for real users until this is set. See `PROVIDER_TRACKER.md` → Google/Firebase.

### 2. VID3-663 — ML go/no-go decision [15 min]
Reply on the ticket. Recommended: Path B — `ML_MODE=manual_review_all` (every loan flows through Stage 5 until model retrained with real data post-launch).

### 3. VID3-659 — MetaMap production credentials [email, 1-3 days]
Vendor email. Draft in `PROVIDER_TRACKER.md` → MetaMap.

### 4. VID3-675 — Twilio + SendGrid templates [self-serve + 24-48h Meta approval]
Submit 5 WhatsApp templates + create 5 email templates. Drafts in `PROVIDER_TRACKER.md`.

### 5. Belvo production tier [email, 1 week]
Vendor email. Draft in `PROVIDER_TRACKER.md` → Belvo.

### 6. Regulatory counsel engagement [email, 2-3 weeks]
Include **VID3-719** (counsel sign-off on dropped SAT check). Draft in `FIRST_WEEK.md`.

### 7. First employer signed [founder work]
Without an employer, there are no users. Target: at least 1 signed LOI by early May.

---

## BLOCKING LAUNCH — engineering tasks 🔴

These are in Linear and can be delegated to Cyrus/Claude once their blockers clear.

### 8. VID3-618 — Full 7-stage pipeline test with real data [blocked on Belvo prod + SW verification]
Runs the whole underwriting flow with a real test CURP + IMSS data. Un-mocks everything.

### 9. VID3-632 — Full E2E test [blocked on most vendors]
Employer signup → employee invite → signup → loan → disbursement → repayment. End-to-end happy path. ~8 story points.

### 10. VID3-628 — Notification E2E [blocked on Twilio + SendGrid template approval]
10 scenarios across WhatsApp + email.

### 11. VID3-633 — Load test [blocked on E2E green]
k6 at 2× projected peak (26 loans/hour sustained for 1 hour). Tests all services.

### 12. VID3-634 — Security audit [no blockers, ~1 week]
SAST (Snyk/Semgrep) + SCA (npm/pip audit) + secrets scan (trufflehog) + DAST (OWASP ZAP) + manual pen test.

### 13. VID3-635 — Production deploy runbook [no blockers, ~1 day]
`docs/RUNBOOK_v1.8.md` — pre-deploy checklist, deploy order, rollback plan, escalation.

### 14. VID3-713 — RiskSeal live verification [blocked on RiskSeal test identity]
Currently `RISKSEAL_MOCK=true`. Need to verify the real API works.

### 15. VID3-715 PR B + PR C — A11y form labels + aria-labels [no blockers]
~44 inputs need `htmlFor`/`id` pairs. Icon-only buttons need aria-labels. Not a launch blocker but a quality gate.

---

## CUTOVER DAY (2026-05-31) — VID3-636

Only when all above is green:

```bash
# ML to safe mode
railway service ml-service
railway variables --set ML_MODE=manual_review_all

# Enable MetaMap signing (only if sandbox E2E green)
railway service pdf-generator
railway variables --set METAMAP_SIGNING_ENABLED=true

# Flip RiskSeal to real
railway service underwriting-service
railway variables --set RISKSEAL_MOCK=false
```

Redeploy affected services. Monitor dashboards for 2 hours. Celebrate.

---

## BACKLOG (post-launch)

Non-blocking polish work parked until after 2026-05-31:

- **VID3-562** — WebP image conversion
- **VID3-563** — JSON-LD structured data for SEO
- **VID3-621** — A11y WCAG 2.1 AA full audit (landmark structure, contrast)
- **VID3-622** — Mobile QA sweep (multiple device models)
- Test runner wiring (Vitest) — not ticketed yet, file when you want it
- Emoji-as-icons replacement in marketing sections
- CSP `'unsafe-inline'` on script-src hardening
- Bundle size audit + Lighthouse score improvements

---

## DAILY HEALTH CHECK

What to eyeball every morning during the launch sprint:

```bash
# Production health
curl -sS -o /dev/null -w "hosting: %{http_code}\n" https://vida-finance.web.app/
for s in softcredito-adapter-production.up.railway.app payment-server-production-b9b8.up.railway.app pdf-generator-production-1a31.up.railway.app notification-service-production-f49e.up.railway.app underwriting-service-production.up.railway.app ml-service-production-f949.up.railway.app; do
  curl -sS -o /dev/null -w "$s: %{http_code}\n" --max-time 5 "https://$s/health"
done

# Linear velocity
# Open "VIDA v1.8 — Launch Sprint" project; count Todo vs Done. Graph should bend toward Done.

# Main tip freshness
cd "/Users/admin/Desktop/Vida Finance" && git log --oneline -5
```

All 7 should be 200. Main tip should show recent activity.
