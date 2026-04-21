# Decisions Log

Architectural and product decisions already made on VIDA. **Do not re-open these in new chats or Cursor sessions unless you have genuinely new information.** Every one of these cost real time to resolve.

Format: decision, who, when, why, alternatives considered, what reopens it.

---

## KYC & identity

### D-01: MetaMap is the sole KYC + e-signature provider
- **When:** 2026-04-18 (Mifiel removal PR #308), confirmed 2026-04-21 (Verifik removal PR #346)
- **Why:** One vendor relationship, one integration surface, one invoice. MetaMap covers: document verification, facematch, liveness, device signals, AML/PEP, gov-check, and signed documents (NOM-151).
- **Alternatives considered:** Mifiel (e-sig only) + Verifik (SAT check) + MetaMap (biometrics) — rejected as too many vendors. Signzy as Verifik fallback — never integrated, removed from env.
- **Reopens if:** MetaMap contract doesn't include Signed Documents add-on (confirm via VID3-659). Regulatory counsel (VID3-719) rejects the 4-signal employer screening as insufficient.
- **Impact:** Two vendor integrations deleted (~200 lines total). One vendor email thread to manage (VID3-659). One counsel signoff pending (VID3-719).

---

## Employer screening (4 signals, no direct SAT)

### D-02: Drop direct SAT taxpayer-status check for employers
- **When:** 2026-04-21 (PR #346)
- **Why:** Verifik was removed per D-01. MetaMap's gov-check is individual-oriented, not employer-oriented. Paying for MetaMap Business Verification (or a new vendor) for 1 signal is disproportionate. EFOS + Art. 69 are both SAT-sourced blacklists — an employer passing both is almost certainly an active SAT taxpayer. Combined with DENUE (INEGI business registry) + REPSE (STPS labor registry), we have 4 independent regulatory signals.
- **Alternatives considered:** 
  - Extend SW SAPiens to call `/v3/rfc/consulta` for SAT status — defer until SW's EFOS auth is verified working
  - MetaMap Business Verification add-on — requires separate contract negotiation
  - Signzy as direct SAT check — would reintroduce a dead vendor
- **Reopens if:** Counsel (VID3-719) says 4 signals is insufficient for CNBV/CONDUSEF reasonable-due-diligence.
- **Edge case:** Employer with SAT-suspendido RFC that's not on EFOS/Art. 69 blacklists will pass. Documented in VID3-719 for counsel review.

### D-03: Drop individual SAT check from Stage 1
- **When:** 2026-04-21 (PR #346)
- **Why:** Tier-1 Mexican workers commonly have personal RFCs in "suspendido" state — they've only earned W2-like wages, never invoiced, so their personal RFC is dormant. Rejecting on SAT-inactive was rejecting exactly our target users. MetaMap's gov-check in Stage 4 covers individual identity validation.
- **Alternatives considered:** Keep the check but change `suspendido` to "passing." Rejected as semantically wrong — the check's purpose was to confirm active taxpayer, which isn't actually what we need.
- **Reopens if:** Stage 4 MetaMap gov-check proves insufficient for individual identity validation during VID3-632 E2E.

---

## Stack choices

### D-04: Tailwind v4 with CSS `@theme`, no `tailwind.config.js`
- **When:** early 2026-04 (pre-session, in-repo by 04-17)
- **Why:** Tailwind v4 reads config from a CSS `@theme` block via `@tailwindcss/vite`. No JS config, one fewer file.
- **Reopens if:** Tailwind v5 ships with a breaking change that requires migration.
- **Gotcha:** Classes like `bg-teal-900`, `bg-gold-500` are auto-generated from `--color-*` custom properties. Custom class names like `bg-vida-teal` do NOT exist.

### D-05: React 19 with named exports on pages
- **When:** early 2026-04
- **Why:** React 19 is current. Named exports enable the `React.lazy(() => import().then(m => ({ default: m.X })))` pattern in App.tsx for lazy route loading.
- **Reopens if:** React 19 hits compatibility issues with Firebase SDK or major dep.

### D-06: No test runner on frontend (yet)
- **When:** intentional deferral
- **Why:** Wiring Vitest + CI + first tests is 1-2 focused days. Launch sprint prioritized getting the product working over test infrastructure. Backend has 213 tests; frontend is hand-verified + Playwright E2E covers the critical paths.
- **Reopens after launch.** File ticket when you want to add it.

### D-07: No form library, no clsx, no icon library on frontend
- **When:** intentional minimalism
- **Why:** `public-v2/` is bundle-size-conscious for tier-1 workers on 3G Android. Each added library = extra kB. Plain controlled forms, template-string class composition, and inline SVG icons keep the bundle under 500kB gzipped.
- **Reopens if:** Component complexity genuinely warrants react-hook-form (e.g., >10 complex forms with shared validation).

---

## Data & infrastructure

### D-08: Firestore + Storage + Cloud Functions on Firebase, Node/Python services on Railway
- **When:** pre-2026, baseline architecture
- **Why:** Firebase for auth, realtime, rules-based security, native CF integration. Railway for services that need Python (ML, doc AI) or long-running processes (PDF generation, notifications). Railway's git-native deploys match our CI.
- **Reopens if:** Scale requirements exceed Firebase Functions quotas or Railway's US-east latency to Mexican users becomes a problem.

### D-09: App Check with reCAPTCHA Enterprise, enforceAppCheck on every CF
- **When:** 2026-04 (VID3-677)
- **Why:** Single strongest abuse-mitigation layer for a consumer-facing financial product. `enforceAppCheck: true` means unauthenticated callers are rejected at the platform layer, before any CF code runs.
- **Reopens if:** legitimate use case requires open access to a CF (rare — webhooks are separate; they validate HMAC signature).

### D-10: Rate limiting per-UID on all 31 user-facing callables
- **When:** 2026-04 (VID3-678)
- **Why:** Prevent brute-force, abuse, runaway loops. Tiered 10-60/min based on sensitivity: 10/min on createLoan, 60/min on lookupInvite, etc.
- **Reopens if:** legitimate traffic pattern (e.g., admin bulk operations) hits the ceiling. Then raise the ceiling for that specific call, not globally.

### D-11: Signed URLs for contract downloads (15-min expiry)
- **When:** 2026-04 (VID3-666)
- **Why:** Contracts are regulated sensitive documents. Never expose Storage URLs directly. CF `getContractDownloadUrl` generates a 15-min v4 signed URL on request, checks authorization.
- **Reopens if:** UX friction becomes a problem. 15 min is plenty for download + share, but some users close the tab and come back hours later.

### D-12: Two CSS files — `styles/index.css` (Tailwind) + `styles/legacy.css` (legacy)
- **When:** 2026-04 cleanup
- **Why:** Consolidation from 3+ files done. Legacy styles (marketing sections, admin portal) are in `legacy.css` because they use CSS custom properties (`var(--brand)`) from pre-Tailwind era. New work goes in `index.css` via Tailwind utilities. No third file.
- **Reopens if:** A full redesign replaces all legacy styles with Tailwind utilities.

---

## Product & business

### D-13: B2B2C — employers are primary acquisition channel
- **When:** original product vision
- **Why:** Payroll-deducted credit requires the employer's cooperation. Direct-to-consumer would require Conekta/OXXO repayment, which has much higher default rates. B2B2C means repayment risk is near-zero when employer remits.
- **Reopens if:** B2B pipeline doesn't yield employers, and direct-to-consumer becomes necessary as a fallback.

### D-14: MXN 500-5,000 loan range, 30-day term, payroll-deducted
- **When:** business plan v1.5
- **Why:** Tier-1 worker emergency-liquidity use case. Larger loans require longer terms, higher defaults, different risk model.
- **Reopens if:** real loan-performance data post-launch suggests a different product.

### D-15: Launch target 2026-05-31
- **When:** 2026-04 sprint planning
- **Why:** Capital runway, vendor timelines, regulatory review windows.
- **Reopens if:** a critical vendor (MetaMap prod creds, counsel sign-off, first employer signed) slips beyond recoverable window.

---

## Engineering process

### D-16: Main branch is always deployable; GitHub Actions auto-deploys
- **Reopens never.** This is a floor.

### D-17: Linear is the source of truth for work; commits must ref tickets
- Convention: `Refs VID3-XXX` in every commit. PRs link Linear attachments automatically.

### D-18: Cyrus handles delegated mechanical tickets; Cursor handles active authorship
- **When:** 2026-04 introduction of Cyrus
- **Why:** Background agent pattern — Cyrus picks up well-scoped tickets without supervision, frees Isaac for decisions and strategy.
- **Reopens if:** Cyrus' work quality degrades enough to require supervision.

### D-19: Conventional commits, scoped, with ticket ref
- `feat(public-v2): ...`, `fix(underwriting): ...`, `refactor(...)`, etc.
- Enforced by habit, not CI (yet).

---

## How to add to this doc

If you make a decision that future-you might second-guess, write it here. Template:

```markdown
### D-XX: [one-line decision]
- **When:** YYYY-MM-DD (PR #XXX or VID3-XXX)
- **Why:** [reasoning]
- **Alternatives considered:** [what you rejected]
- **Reopens if:** [the specific condition that would make you revisit this]
- **Impact:** [what this changes]
```

Don't log trivial decisions ("used `const` over `let`"). Log decisions that cost >30 min to make or that someone might reasonably question in 3 months.
