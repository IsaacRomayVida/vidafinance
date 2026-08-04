# Security audit — `public-v2/` (borrower-facing React/Vite app)

**Branch:** `audit/public-v2-borrower` (base `origin/main` @ `75b7532`)
**Scope:** `public-v2/src` — client→server trust boundaries, money/terms parity against the
server's single source of truth, every direct Firestore path the client touches, secrets/PII
in the bundle and in storage, auth and route guards.
**Method:** every claim below was traced client origin → transport → server handler or
`firestore.rules` rule on this commit. Comments describing a past defect were not taken as
evidence of a live one; each was checked against current code.

## Suite results actually observed

Run in `public-v2/` after `npm ci --legacy-peer-deps`:

| Command | Before this branch | After this branch |
|---|---|---|
| `npm test` (`vitest run`) | **27 files / 184 tests passed** | **30 files / 204 tests passed** |
| `npm run lint` | 0 errors, 1 pre-existing warning (`Navbar.tsx:68`) | identical |
| `npm run build` (`tsc && vite build`) | exit 0 | exit 0 |

Both shipped fixes were mutation-verified: the defect was re-injected and the suite went red
(1 failure for F1, 5 for F2), then restored to green. Numbers above are observed, not projected.

## Note on the prior audit

`AUDIT_PUBLIC_V2.md` at the repo root is a read-only audit of this app at base `d9d8a4b`.
**Its findings F1–F11 are all fixed on `75b7532`** — I re-checked each rather than assume it
(see §"Verified NOT a defect"). This audit is new ground; the one place F7's pattern survives
is recorded as F5 below.

---

# Findings, most severe first

## F1 — CRITICAL: anyone can register with a `@vida-test.com` address, skip identity verification entirely, and borrow real money — FIXED (client half)

### What breaks

The only identity check standing between a signup and a disbursed loan lives in the browser,
and the browser also ships a switch that turns it off for anybody who types the right email
domain into the signup form.

### Evidence

**1. The onboarding wizard had an ungated bypass.** `public-v2/src/pages/Onboarding.tsx:437-445`
as of `75b7532`:

```tsx
const startKYC = () => {
  // Test-mode bypass: skip MetaMap for @vida-test.com emails
  if (memData.email.endsWith('@vida-test.com')) {
    setMetamapVerificationId('test-verification-' + Date.now());
    setMetamapIdentityId('test-identity-' + Date.now());
    setKycStatus('approved');
    goForward(4);
    return;
  }
  // ... otherwise open the MetaMap widget
```

`memData.email` is the address the person signing up types into step 2 of the same wizard.
Nothing else gates this — no environment check, no build check.

**2. That client-chosen value is written straight to Firestore.**
`public-v2/src/pages/Onboarding.tsx:574` (now `:579`), inside `createEmployeeAccount`:

```tsx
await setDoc(doc(db, 'employees', uid), {
  ...
  kycStatus: kycStatus,
  ...(metamapVerificationId ? { metamapVerificationId } : {}),
```

**3. The rules do not constrain it.** `firestore.rules:131-135` is the create-time field
blocklist, and `kycStatus` is not in it:

```
function noSelfAssignedCredit() {
  return !request.resource.data.keys().hasAny([
    'creditLimit', 'availableCredit', 'creditLimitSetAt', 'salarySource', 'riskTier', 'mlScore'
  ]);
}
```

`firestore.rules:220-227` applies it on create only. Note the block comment at `:127-128`
states *"creditLimit, availableCredit, employerId, kycStatus must come from CFs"* — the
**update** whitelist (`:227-229`) does exclude `kycStatus`, but **create** does not. The rule
file's own stated contract and its create branch disagree.

**4. Nothing server-side ever corrects the value.** Repo-wide, `kycStatus` appears in
`functions/src` exactly once — `functions/src/employees/getEmployeeDashboard.ts:61`
(`kycStatus: user['kycStatus']`), a read for display. The MetaMap webhook writes
*different* fields: `functions/src/webhooks/metamap.ts:106-110` updates `metamapStatus`,
`metamapVerifiedAt`, `metamapLastEventAt` — never `kycStatus`. So the field is written once,
by the browser, and is never revisited.

**5. It is the only KYC gate on the borrowing path, and it is client-side.**
`public-v2/src/pages/LoanWizard.tsx:530-535`:

```tsx
// Check KYC
if (data.kycStatus && data.kycStatus !== 'approved' && data.kycStatus !== 'verified') {
  setEligibilityError(t('wiz_error_unverified'));
```

`requestLoan` (`functions/src/index.ts:512-600`) checks the rate limit, amount bounds, term,
`availableCredit`, the 30%-of-salary cap, duplicate active loans, employer status and the CURP
allowlist — **and no identity signal at all**. Note also that the client gate is `data.kycStatus &&`,
so a document with the field absent passes.

**6. The backend already fixed this exact shape, three times.** Every server-side
`@vida-test.com` shortcut is gated on `allowTestBypass()`
(`functions/src/index.ts:276`, `:3211`, `:3233`), which per
`functions/src/utils/environment.ts:43-51` hard-refuses on the production project and treats
anything it cannot positively identify as non-production as production. The comment at
`index.ts:273-275` says it in as many words: *"Gated on the environment, not on the CURP prefix
or the email suffix — the caller picks both of those."* The wizard was the one place that
never got the gate.

### Exploitability

No tooling, no console, no forged request. Open the live site → `/onboarding` → choose
"empleado" → enter `anything@vida-test.com` → the KYC step self-completes with
`kycStatus: 'approved'` and a fabricated `metamapVerificationId` → finish signup →
`employees/{uid}.kycStatus === 'approved'` → `LoanWizard` admits → `requestLoan` disburses
against a self-declared salary and an identity nobody verified. A regulated consumer lender
originating loans to unverified identities is an AML/CONDUSEF exposure, not only a bug.

A second, wider path exists and is **not** closed by this branch: because `kycStatus` is
client-supplied on create and unconstrained by the rules, any registrant can set it to
`approved` regardless of email domain; and because `requestLoan` reads no identity field at
all, the callable can be invoked directly whatever the document says.

### Fix

**Shipped (client half).** `public-v2/src/lib/testBypass.ts` — a direct counterpart to
`functions/src/utils/environment.ts`. The shortcut is now gated on Vite's
`import.meta.env.DEV`, true under `vite dev` and Vitest and false in every built bundle
(production, staging, preview), and it fails closed. `Onboarding.tsx:444` calls
`testBypassAllowed(memData.email)`. Verified in the emitted bundle: the default argument
constant-folds, so `dist/assets/Onboarding-*.js` contains
`function ce(e, t = !1) { return !t || ... }` — the branch is unreachable in production.

**NOT shipped — needs the backend, flagged for the orchestrator.** Two changes belong outside
`public-v2` and are not low-risk enough for this branch:

1. `requestLoan` must require a *server-written* identity signal before originating —
   `metamapStatus === 'verified'` on the employee document, the one field the webhook actually
   writes. Today no server code reads any identity signal before lending.
2. `firestore.rules` should add `kycStatus` (and `metamapVerificationId`,
   `metamapIdentityId`, `kycStartedAt`) to `noSelfAssignedCredit()`'s blocklist so the client
   cannot seed its own verification state, and a Cloud Function should own the field. Note
   `metamapWebhook` finds the employee *by* `metamapVerificationId`
   (`functions/src/webhooks/metamap.ts:94-98`), so that field must be written by whatever
   starts the verification, not by the form.

### Collateral

`e2e-test-v18.mjs:444-504` drives the employee onboarding UI with a `@vida-test.com` address
against a deployed `BASE`. It is a hand-run script, **not wired into `.github/workflows/ci.yml`**
(CI's frontend job is lint + `npm test` + build, `ci.yml:287-297`). It relied on the ungated
bypass and will now stop at the KYC step when pointed at a built deployment. That is the
correct outcome — it should run against the emulator or a `vite dev` build, the same way the
server's own bypasses require a non-production project.

---

## F2 — HIGH: the homepage calculator asks for the visitor's salary and ignores it, offering everyone a credit line up to $5,000 — FIXED

### What breaks

The public calculator is a pre-contractual disclosure: it names a credit line and an
"estimated repayment" to somebody with no account. Its salary input was decorative.

### Evidence

`public-v2/src/components/marketing/ROICalculator.tsx:11-19` as of `75b7532`:

```tsx
export function ROICalculator() {
  const { t } = useTranslation();
  const [credit, setCredit] = useState(3000);
  const [salary, setSalary] = useState('15,000');

  const total = credit * (1 + RATE);
  const whole = Math.floor(total);
  const cents = ((total - whole) * 100).toFixed(0).padStart(2, '0');
  const fillPct = ((credit - 500) / 4500) * 100;
```

`salary` is set at `:21-24`, rendered back into its own input at `:72`, and appears nowhere
else in the file. The slider is fixed at `min="500" max="5000"` (`:91-92`) for every visitor.

The line the backend actually grants — `functions/src/index.ts:3161`:

```ts
const creditLimit = Math.max(Math.min(salary * EMPLOYEE_CREDIT_SALARY_RATIO, EMPLOYEE_CREDIT_CEILING), 0);
```

with `EMPLOYEE_CREDIT_SALARY_RATIO = 0.3` and `EMPLOYEE_CREDIT_CEILING = 5000`
(`functions/src/index.ts:74-75`), re-checked on every loan at `:542-544`.

The copy makes the promise explicit — `public-v2/src/i18n/es.json`:
`calc_h2` = *"Descubre cuánto puedes acceder."*, `calc_p` = *"Calcula tu línea de crédito en
segundos. **Ajusta tu salario** y monto deseado."*

### Failure scenario

A visitor earning 10,000 MXN/month types it in. Before the fix the slider still ran to $5,000
and the page quoted an estimated repayment of **$6,500**. Their actual line is
`10,000 × 0.3 = 3,000`, repayment $3,900 — and `requestLoan` refuses anything above it with
*"El monto excede el 30% de tu salario mensual"*. The gap applies to **every visitor earning
under 16,667 MXN/month**, which on a Mexican payroll-lending book is essentially the entire
target market (the 2026 general minimum wage is roughly 8,400 MXN/month → a real line of
2,520, shown as 5,000). Below ~1,667 MXN/month the calculator quoted a line the product
cannot originate at all.

### Fix

**Shipped.** New `public-v2/src/lib/creditLine.ts` mirrors the backend formula in one place
(`creditLineFor`, `selectableCreditLine`, `CREDIT_SALARY_RATIO`, `CREDIT_CEILING`,
`MIN_CREDIT_LINE`), with `creditLine.test.ts` pinning each constant to its backend counterpart
— the same cross-project arrangement `Onboarding.payFrequency.test.ts` and `loanStatus.test.ts`
already use, since `public-v2` and `functions` are separate TS projects with no shared package.
`ROICalculator` now derives the slider ceiling from the salary, clamps an already-selected
amount down when the salary drops, reuses `sliderFillPercent` from `loanSlider.ts` (which
already handles the degenerate single-point range), and, when the line cannot reach the $500
minimum, disables the slider and says so instead of quoting a number
(`calc_note_below_min`, added to `es.json` and `en.json`).

`ROICalculator.test.tsx` drives the rendered component, not the helper, so the wiring is what
is asserted.

---

## F3 — MEDIUM: the fee rate is hardcoded three times in the marketing calculator, and ADR-002 made that rate runtime-editable — NOT FIXED (needs a backend endpoint)

### Evidence

Three copies in `public-v2`:

- `public-v2/src/components/marketing/ROICalculator.tsx:9` — `const RATE = 0.30;`, used at
  `:16` as `total = credit * (1 + RATE)`
- `public-v2/src/i18n/es.json` — `"calc_rate": "30% mensual"`
- `public-v2/src/i18n/en.json` — `"calc_rate": "30% monthly"`

Plus the term: `ROICalculator.tsx:103` hardcodes `30 {t('calc_days')}`.

The single source of truth is `functions/src/config/loanConfig.ts:23` (`LOAN_FEE_RATE = 0.3`)
— but as of #389 that constant is only the **seed**. `getLoanConfigValues()` (`:329-364`)
returns the rate stored in `config/loan`, which two admins can change via
`proposeLoanConfigChange` / `approveLoanConfigChange` anywhere in `[MIN_ALLOWED_FEE_RATE=0,
MAX_ALLOWED_FEE_RATE=0.35]` (`:123-124`). `ALLOWED_LOAN_TERM_DAYS` is `[30]` (`:30`).

### Parity, proven not guessed

**Today the numbers agree.** `0.30 === LOAN_FEE_RATE`, and `30 days` is the only allowed term.
There is no live drift. What exists is an **armed** drift channel: the first approved fee-rate
change reprices every loan while the homepage keeps quoting 30%, silently. That is the same
defect class as the ratified *"the UI quoted borrowers 8% while the backend charged 30% — a
CONDUSEF consumer-protection exposure"* recorded at `loanConfig.ts:10-14`, in the one surface
that was never migrated to the published config.

The borrower-facing *wizard* is clean: `LoanWizard.tsx:417-453` derives fee, total, CAT and
schedule from the server's `getLoanConfig`, propagates `null` rather than degrading to a
default, and blocks submission on `!pricingReady`.

### Why not fixed here

There is no route by which an anonymous visitor can learn the rate. `getLoanConfig` is
`withAuth(['employee'])` (`functions/src/index.ts:412-414`), and `firestore.rules:383-385`
denies `config/{document=**}` to every client, deliberately. Closing this means publishing the
rate (and `defaultTermDays`) through an unauthenticated, App-Check-gated, rate-limited callable
— the shape `checkEmailAvailability` (`index.ts:203-232`) already uses — and having the
calculator consume it and refuse to quote when it is unavailable, exactly as the wizard does.
That is a backend change, so it is flagged rather than attempted. A comment recording the
constraint has been added at `ROICalculator.tsx:9-16`.

---

## F4 — MEDIUM: the employer roster's invite state reads a collection the rules deny outright, so every invited employee shows as "pending" forever and gets re-mailed

### Evidence

`public-v2/src/pages/EmployeeRoster.tsx:211-218`:

```tsx
/* ── real-time invites (for status + cooldown) ───────── */
useEffect(() => {
  if (!user) return;
  const q = query(
    collection(db, 'invites'),
    where('employerId', '==', user.uid),
  );
  const unsub = onSnapshot(q, (snap) => {
```

`firestore.rules:293-296`:

```
match /invites/{inviteId} {
  allow read, write: if false;
}
```

Unconditional deny, for every caller including the employer admin. The listener has no error
callback, so the rejection is swallowed and `invitesByEmployee` stays `{}` permanently. The
rule is deliberate — the comment above it explains that `lookupInvite` hashes the raw token
server-side so *"clients never need to read these documents directly"* — but this client does.

Everything derived from that map therefore degrades silently:

- `getInviteState` (`:274-282`) — `invitesByEmployee[emp.id]` is always `undefined`, so any
  employee without `authUid` returns `'pending'`. The "invited" badge can never render.
- `canResend` (`:284-289`) — `sentMs` is always `0`, so it returns `true` unconditionally. The
  `RESEND_COOLDOWN_MS = 24 * 60 * 60 * 1000` constant (`:45`) is inert.
- `pendingEmployees` (`:318-322`) — includes everyone already invited, so **bulk invite
  re-mails the entire un-registered roster on every click**.

### Failure scenario

An employer invites 40 employees. The roster still lists all 40 as "Pendiente". The admin
clicks bulk invite again the next day; all 40 are re-mailed. Worse than noise:
`sendEmployeeInvite` supersedes prior links on every mint
(`functions/src/invites/sendEmployeeInvite.ts:107-134`, `status: 'superseded'`), so an employee
who received a link yesterday and clicks it today finds it dead. The server's only brake is a
20/minute per-admin rate limit (`sendEmployeeInvite.ts:52-55`) — a volume cap, not a dedupe.

The server code even documents the assumption this breaks
(`sendEmployeeInvite.ts:108-110`): *"the UI already assumes a single live invite per employee
(it collapses `invitesByEmployee` to the newest by `sentAt`)"* — a map that is, in production,
always empty.

### Recommended fix

Not attempted here: it needs a server surface, not a client edit. Either return the invite
state on the existing employer-facing callable (`getEmployerDashboard` / the roster read), or
add a `listEmployeeInvites` callable returning `{employeeDocId, sentAt, acceptedAt, status}`
with no token material. As a strict improvement in the meantime, give the listener an error
callback so the failure is visible instead of silently disabling the cooldown.

---

## F5 — LOW: two employer surfaces still spin forever on a Firestore read failure

`public-v2/src/pages/DeductionReports.tsx:47-53`:

```tsx
const unsub = onSnapshot(q, (snap) => {
  const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Loan));
  setLoans(data);
  setLoading(false);
});
```

No error callback. `loading` starts `true` (`:34`) and is cleared only on success, and `:121`
renders a bare spinner — so a permission error, a missing composite index (this query is
`where employerId` + `where status in` + `orderBy createdAt`, which requires one) or an offline
client is indistinguishable from "still loading", forever, with no retry.

Same shape at `public-v2/src/pages/EmployeeRoster.tsx:188-194` (employees listener; the
roster's spinner never clears) and `:202-208` (loans, non-blocking).

This is the residual of the prior audit's F7. The pattern was fixed everywhere else —
`MyLoans.tsx:102-113`, `EmployeeDashboard.tsx:106-120`, `EmployerDashboard.tsx:729-746`,
`EmployerMgmt.tsx:73-80`, `AdminDashboard.tsx:71-75`, `ReviewQueue.tsx:168+` all pass an error
callback and surface an `ErrorBanner` with a retry token. These two were missed.

Left alone deliberately: the fix is mechanical but touches page state and error copy in two
employer screens, which is more than this branch should carry alongside F1 and F2.

---

## F6 — LOW: the ops alerts page's "Resolve" action can never take effect

`public-v2/src/pages/AlertsPage.tsx:247-256`:

```tsx
const dismiss = async (alert: Alert) => {
  const key = `${alert.kind}-${alert.id}`;
  setDismissing(key);
  try {
    const col = alert.kind === 'overdue' ? 'overdue_log' : 'incident_log';
    await updateDoc(doc(db, col, alert.id), { resolved: true });
  } catch (e) {
    console.error('Failed to dismiss alert:', e);
  } finally {
```

`firestore.rules:352` and `:355`:

```
match /overdue_log/{d}   { allow read: if isAdmin();  allow write: if false; }
match /incident_log/{d}  { allow read: if isAdmin();  allow write: if false; }
```

Every write is denied. The rejection goes to `console.error` only; the spinner clears and the
list re-renders from the (unchanged) snapshot, so the operator sees the alert stay put with no
explanation. An operator who believes they cleared an overdue-borrower incident has cleared
nothing, and the alert counts at `:265-269` never go down.

Fix: route the resolution through an ops callable that writes via the Admin SDK (the pattern
every other write on these collections already uses), and surface the failure in the existing
toast rather than the console.

---

# Verified NOT a defect — checked and cleared

Recorded so the next tick does not re-audit them.

**Secrets and PII**
- `public-v2/src/lib/firebase.ts:11-19` — the Firebase web config in source is a public project
  identifier by design, not a credential. App Check with reCAPTCHA Enterprise is wired at
  `:30-51` and its site key comes from `VITE_RECAPTCHA_SITE_KEY`, not source. No other keys,
  tokens or internal hostnames anywhere in `public-v2/src`.
- **No PII in storage.** Every `safeSetItem`/`safeGetItem` call in the app writes exactly one
  key, `vida_lang` (`i18n/index.ts:7,25`, `Navbar.tsx:75`, `Footer.tsx:12`, `ComingSoon.tsx:21`,
  `Onboarding.tsx:1447`, both layouts). `SplashIntro.tsx:11-17` writes one sessionStorage flag.
  No CURP, RFC, CLABE, salary or bank data is ever persisted client-side.
- **Sentry is PII-safe and inert by default.** `lib/sentry.ts:22-28` no-ops without a DSN;
  `sendDefaultPii: false`, all sample rates 0, `beforeSend` redacts every URL query parameter
  (`:38-49`), and `setSentryUser` passes only uid + role, never email/name/phone (`:76-83`).

**Trust boundaries that hold**
- **Payroll CSV deduction amounts are bounded server-side.** `PayrollUpload.tsx` parses a
  client `deductionAmount` column and sends it, but `processPayroll.ts:407` clamps it —
  `roundToCents(Math.min(requestedAmount, remainingBalance))` — so an employer cannot
  over-deduct from a paycheck via the upload.
- **`requestLoan` ignores the client's `employerCode`.** `LoanWizard.tsx:653-660` sends it, but
  the callable resolves the employer from `emp['employerId']` on the server document
  (`functions/src/index.ts:553-560`). The field is inert, not a forgery channel.
- **Loan amount caps in the client are cosmetic and safe.** `LoanWizard.tsx:408` floors
  `monthlySalary * 0.3` to 100s for the slider; the server independently re-checks bounds,
  `availableCredit`, the 30% cap and the allowed term (`index.ts:536-544`).
- **`Onboarding.tsx:614` credit preview matches the backend.** `Math.min(Math.max(salary*0.3, 0), 5000)`
  is algebraically identical to `Math.max(Math.min(salary*0.3, 5000), 0)` at `index.ts:3161`
  for every finite input. Duplicated constants, but no live drift. (`creditLine.ts` now exists
  if someone wants to collapse the duplication.)
- **Employer self-registration is properly constrained.** `Onboarding.tsx:503-530` no longer
  writes `employerCode` (minted by `onEmployerDocCreated`), and
  `firestore.rules:61-98`'s `isSelfServeEmployerCreate()` pins `status` and blocks
  `apiKeyHash`, `creditLimit`, `riskTier`, `mlScore`, `maxActiveSlots`, `tier`,
  `cleanPayrollCyclesSinceReview`, `employerCode` and the rest.
- **Contact forms match their rule.** `ContactForm.tsx:18-25` and `ComingSoonForm.tsx:23-33`
  send only fields inside `firestore.rules:311-312`'s `hasOnly` list. (Minor, not a security
  issue: `ContactForm.tsx:27-29` swallows a submit failure with no message, where
  `ComingSoonForm` shows one.)

**Firestore paths the client touches — rule-by-rule**
| Path | Client op | Rule | Constrained? |
|---|---|---|---|
| `loans` | read (`MyLoans`, `EmployeeDashboard`, `DeductionReports`, `EmployerDashboard`, `AnalyticsPage`, `EmployeeRoster`, `AdminDashboard`, `LoanWizard`) | `:255-260` | Yes — owner / employer admin / ops; create, update, delete all `false` |
| `employees` | read + self-create (`Onboarding`) | `:220-233` | Yes for credit fields, employer eligibility and CURP allowlist. **No for `kycStatus` — see F1** |
| `employers` | read + self-create | `:100-112` | Yes — `get` is own-admin/ops, `list` ops-only, create shape-pinned |
| `repayments` | read | `:329-332` | Yes — owner or admin; writes `false` |
| `review_queue` | read (`ReviewQueue`) | `:338-341` | Yes — ops only |
| `contact` | create | `:310-324` | Yes — field allowlist + size bounds |
| `invites` | read (`EmployeeRoster`) | `:293-296` | Denied outright — **the read never succeeds, see F4** |
| `incident_log`, `overdue_log` | read + update (`AlertsPage`) | `:352,355` | Read admin-only; **update denied, see F6** |
| `employers` (list), `config/**`, `system_health`, queues | — | `:102`, `:383-385`, `:378`, `:390-392` | Yes — all closed |

**Auth and route guards**
- `hooks/useAuth.ts:34-87` prefers custom claims, force-refreshes once, falls back to Firestore
  with one retry, and on total failure sets `user: null` so the guard redirects rather than
  spinning. `RouteGuard.tsx:20-26` checks `user` before role and denies unknown roles by
  default. The client role is advisory only — every callable re-checks via `withAuth`, and the
  rules re-check via claims/uid. Not a trust-boundary violation.
- `Login.tsx:68-74` enforces `emailVerified` strictly (sends a verification mail, signs out).
  `EmployeeDashboard.tsx:70-72` and `EmployerDashboard.tsx:665` exempt `@vida-test.com` from
  the *banner* only; that path is only reachable straight after onboarding, and the server's
  auto-verify triggers are already environment-gated (`index.ts:3208-3245`). Cosmetic, left as is.

**Money and terms parity**
- Fee, total, CAT, schedule and due date in the loan wizard all come from the server's
  `getLoanConfig`; `LoanWizard.tsx:453` blocks submission when pricing is unavailable rather
  than falling back to a constant. `loanConfig.ts` remains the only place a rate is decided.
- `lib/loanStatus.ts` mirrors the canonical status vocabulary and is pinned by
  `loanStatus.test.ts`; `DEDUCTION_REPORT_STATUSES` is what `DeductionReports.tsx:42` queries.
- `lib/deductionReport.ts:51-59` resolves `remainingBalance ?? total` and returns `null` rather
  than falling back to bare principal. `getPayFrequency` (`:84-88`) refuses to present a
  `default_monthly` assumption as fact.
- Client and server repayment gates now intersect: `MyLoans.tsx:430` /
  `LoanTable.tsx:99` allow `['active','overdue','disbursed']`, and
  `generatePaymentLink.ts:72` checks `REPAYABLE_STATUSES`.
- **All eleven findings in the prior `AUDIT_PUBLIC_V2.md` are fixed on this commit** — verified
  individually, including F10 (now `lib/loanSlider.ts:28-31`) and F2 (the disjoint pay gates).

---

# Out of scope, but found while tracing — for the orchestrator

Not `public-v2` defects; recorded because they were established from source while verifying
findings above, and both touch the same money path.

1. **`approveEmployer` writes an employer status `requestLoan` refuses.**
   `functions/src/employers/approveEmployer.ts:243` sets `status: 'approved'`, but
   `functions/src/index.ts:559-560` admits only `'active'` or `'pending_verification'` and
   otherwise throws `EMPLOYER_NOT_APPROVED`. `firestore.rules:173-176`'s
   `employerAcceptsEnrolment` accepts the same two and not `'approved'`. If this is real, an
   employer that completes due diligence and is approved can no longer take on employees or
   have loans originated — the opposite of the intent. Worth an independent check against the
   deployed data; it is a `functions` question, not a `public-v2` one.
2. **F1's server half** (see above): `requestLoan` performs no identity check whatsoever, and
   `firestore.rules` lets the client seed its own `kycStatus`.

---

# Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | CRITICAL | `@vida-test.com` self-service KYC bypass; KYC enforced only in the browser | Client half **fixed**; server half flagged |
| F2 | HIGH | Homepage calculator ignores salary, offers everyone up to $5,000 | **Fixed** |
| F3 | MEDIUM | Fee rate hardcoded 3× in marketing copy; ADR-002 rate is runtime-editable | Flagged (needs unauth endpoint) |
| F4 | MEDIUM | Roster reads `invites`, which rules deny — invite state dead, employees re-mailed | Flagged (needs callable) |
| F5 | LOW | `DeductionReports` / `EmployeeRoster` spin forever on read failure | Flagged |
| F6 | LOW | Ops "Resolve alert" write is denied by rules and swallowed | Flagged |

The origination *quote* path in this app is genuinely well built — the wizard has no local
rate, no local schedule, no local due date, and refuses to quote when the server cannot price.
The defects cluster where a value **originates in the browser and nothing behind it ever looks
again**: the KYC status (F1), the marketing quote that never asked the server anything (F2, F3),
and the two client reads/writes aimed at collections the rules close (F4, F6).
