# Audit — `public-v2/` (borrower-facing web app)

**Branch:** `audit/public-v2-money-path` (base `origin/main` @ d9d8a4b)
**Scope:** `public-v2/src` — loan request/quote flow, repayment & payment-link flow, every
surface that displays an amount / fee / total / term / due date, auth & role handling,
direct Firestore reads from the client.
**Nature:** read-only audit. No product source was modified.

## Suite results actually observed

Run in `public-v2/` after `npm ci --legacy-peer-deps` (see note in §"Cleared" below):

| Command | Result |
|---|---|
| `./node_modules/.bin/tsc -b --noEmit` | **exit 0**, no diagnostics |
| `./node_modules/.bin/vitest run` | **11 test files passed (11), 69 tests passed (69)**, 0 failed, 6.88s |

Every defect below passes typecheck and passes the existing suite. None is caught today.

## Method

Every finding was verified by reading both sides — the client read *and* the backend write
path that is supposed to produce the field or status being read. No `.md` file in this repo
was taken on faith. Findings I could not substantiate against source were dropped and are
listed in §"Cleared" so the negative result is on the record.

The authoritative loan-document shape is the single `tx.set(db.collection('loans').doc(loanId), {...})`
at `functions/src/index.ts:822-880`. Lines I read there: 822-880. It writes exactly these
money/term fields:

```
amount   (principal)     fee      feeRate      total (= amount + fee)
term     (NOT termDays)  dueDate  catPercent   repaymentSchedule[]  status
```

The canonical status vocabulary is `functions/src/loans/loanStatus.ts:26-46` (read in full).

---

# Findings, most severe first

## F1 — CRITICAL: the employer deduction report understates every deduction by the fee

**What breaks.** `getDeductionAmount()` resolves to bare **principal**, never the borrower's
actual obligation (principal + fee). The two preferred fields it reads are written by
*nothing*.

**Evidence.**
- `public-v2/src/pages/DeductionReports.tsx:36-38`
  ```ts
  function getDeductionAmount(loan: Loan): number {
    return loan.deductionAmount ?? loan.repaymentAmount ?? loan.amount;
  }
  ```
- `loan.deductionAmount` is never written to a loan document. The only `deductionAmount`
  writes in the backend are on payroll-batch rows, not `loans/{loanId}` —
  `functions/src/payroll/processPayroll.ts:116,139,160,169`.
- `loan.repaymentAmount` is never written anywhere in the backend. Repo-wide grep for
  `repaymentAmount` outside `totalRepaymentAmount` returns **zero** backend hits; all hits
  are in `public-v2/`.
- So the expression always falls through to `loan.amount` — the principal
  (`functions/src/index.ts:830`).
- The real obligation is `total` (`functions/src/index.ts:838`), and the deduction the system
  actually registers is built on it: `buildLoanInstallments(amount + fee, dueDate.toDate(), term)`
  at `functions/src/index.ts:507`, mirrored at `markLoanDisbursed.ts:160-169`.

**Failure scenario.** A $5,000 loan at the 30% fee rate → `amount: 5000`, `fee: 1500`,
`total: 6500`. The deduction report row, the period subtotal
(`DeductionReports.tsx:73`), the "Total Deducciones" stat (`:136,184`) and the exported CSV
(`:86,92`) all read **$5,000.00**. The obligation is $6,500.

**Blast radius.** Every row of every employer deduction report and every exported CSV, for
every employer, on every loan. The report contradicts the deduction the adapter actually
registers, so an employer reconciling payroll against this sheet under-deducts by exactly the
fee — 100% of gross revenue on the primary collection channel — and the borrower's balance
never reaches zero.

## F2 — CRITICAL: card repayment is unreachable; the client and server gates are disjoint

**What breaks.** The UI shows "Pagar" only for `active`/`overdue`. The server refuses unless
the status is exactly `approved`. Those sets do not intersect, in either direction.

**Evidence.**
- Client gate, both dashboards:
  - `public-v2/src/components/employee/LoanTable.tsx:99` — `{['active', 'overdue'].includes(loan.status) ? <button…> : '—'}`
  - `public-v2/src/pages/MyLoans.tsx:364` — `{['active', 'overdue'].includes(loan.status) && <PayButton …/>}`
- Server gate, `functions/src/payments/generatePaymentLink.ts:68-73`:
  ```ts
  if (loan['status'] !== 'approved') {
    throw new HttpsError('failed-precondition', 'Loan must be approved to generate payment link');
  }
  ```
- `approved` is a **pre-disbursement** state. Lifecycle read from source:
  `approved` → `disbursement_queued` (`functions/src/index.ts:1833`) → `active`
  (`:1874`, `:1912`) on the automatic path, or → `disbursed`
  (`functions/src/loans/markLoanDisbursed.ts:116,247`) on the manual ops path; then `overdue`
  (`functions/src/index.ts:2092`). Confirmed against `loanStatus.ts:31-40`.

**Failure scenario.** Borrower's loan is disbursed and live (`active`). They open the
dashboard, click "Pagar" → `generatePaymentLink` throws `failed-precondition` → the button
surfaces a generic error (`MyLoans.tsx:281-283`, `PaymentModal.tsx:46-48`). This happens
100% of the time. Conversely, a loan sitting in `approved` — money not yet sent — is the only
state the server would mint a link for, and the UI deliberately shows no button there.

**Blast radius.** The entire card/Conekta repayment channel, from both the dashboard table
and the payment modal. No borrower can ever repay by card. Only `status === 'disbursed'`
loans also silently lose the button on the manual ops disbursement path.

## F3 — HIGH: the deduction report queries one status nothing writes and misses two that matter

**What breaks.** `DeductionReports.tsx:120` filters `where('status', 'in', ['active', 'paid'])`.

**Evidence.**
- `'paid'` is documented dead: `functions/src/loans/loanStatus.ts:58-63` — *"No write path has
  ever produced it."* The canonical completed spelling is `'repaid'` (`loanStatus.ts:41-43`).
- `'disbursed'` is missing. It is a **live** "funds sent" spelling written by
  `markLoanDisbursed.ts:116,247` and is half of `DISBURSED_STATUSES` (`loanStatus.ts:78`).
- `'overdue'` is missing (`functions/src/index.ts:2092` writes it).

**Failure scenario.** An ops-confirmed manual disbursement leaves the loan at `disbursed`.
That loan never appears in the employer's deduction report at all, so it is never deducted
through this channel. Separately, `completedCount` (`:138`, filtering `'paid'`) is
structurally always **0** — the "completed" stat can never be non-zero.

**Blast radius.** Every manually-disbursed and every overdue loan is invisible to the
employer's payroll deduction sheet. This is the same defect class commit `bf9db5d` closed on
the ops-report side, still open on the employer-report side.

## F4 — HIGH: the loan fee never renders — `loan.feeAmount` is written by nothing

**Evidence.**
- `public-v2/src/pages/MyLoans.tsx:426-431`:
  ```tsx
  <DetailItem label={t('modal_fee', 'Fee')}
    value={loan.feeAmount != null ? `$${fmt(loan.feeAmount)}` : '—'} />
  ```
- The loan document field is `fee` (`functions/src/index.ts:831`), not `feeAmount`.
- The only backend `feeAmount` is a field name in the **admin API response** shape,
  `functions/src/admin/getReviewQueue.ts:77,257` (`feeAmount: num(loan?.['fee'])`) — that is a
  callable's return payload, not a Firestore field. `MyLoans` reads Firestore directly
  (`onSnapshot` at `:84`), so it never sees that mapping.

**Failure scenario.** Borrower expands any loan row → the "Fee" detail renders `—`
unconditionally, for every loan that has ever existed. The single number telling them what
the credit costs is silently absent, while Principal and Total beside it render fine.

**Blast radius.** Every loan detail expansion for every borrower.

## F5 — HIGH: the displayed loan term comes from a client constant, not the loan

**Evidence.**
- `public-v2/src/pages/MyLoans.tsx:438-441` — `value={`${loan.termDays ?? 30} ${t('dash_days','days')}`}`
- `public-v2/src/components/employee/LoanTable.tsx:73` — `<td>{loan.termDays ?? 30} {t('dash_days')}</td>`
- The loan document field is `term` (`functions/src/index.ts:839`). `termDays` is the
  *request payload* name only (`functions/src/index.ts:396-398,409`) and is never persisted.
  Repo-wide grep for `termDays:` in backend source returns only `loanConfig.ts` function
  signatures — no loan write.

**Failure scenario.** `loan.termDays` is always `undefined`, so both surfaces always print the
hardcoded literal **30**. This is correct today only by accident, because
`ALLOWED_LOAN_TERM_DAYS` is `[30]`. The day a second term ships, every loan — historical and
new — misreports its term to the borrower, and nothing fails.

**Blast radius.** Latent, repo-wide across the two loan lists. This is precisely the accident
`LoanWizard.tsx:388-394` documents and deliberately removed from the wizard; it survives
untouched in the two list views.

## F6 — MEDIUM: five canonical statuses have no translation, and one surface renders the raw key

**Evidence.**
- Missing from **both** `public-v2/src/i18n/es.json` and `en.json` (verified per key):
  `status_rejected_ml`, `status_disbursement_failed`, `status_cancelled`,
  `status_in_collections`, `status_written_off`. All five are canonical
  (`functions/src/loans/loanStatus.ts:30,36,43,44,45`).
- `public-v2/src/i18n/index.ts:9-19` configures no `parseMissingKeyHandler` and no
  `saveMissing`, so i18next returns the key verbatim.
- `public-v2/src/components/employee/LoanTable.tsx:77` calls `t(`status_${loan.status}`)`
  with **no** fallback argument. (`MyLoans.tsx:343` does pass one and degrades to the raw
  status instead.)

**Failure scenario.** A borrower whose loan reaches `in_collections` opens the dashboard and
the status badge reads the literal string **`status_in_collections`**.

**Blast radius.** Every borrower in the five states — which includes the two most sensitive
ones to get wrong in front of a consumer, collections and write-off.

## F7 — MEDIUM: Firestore read failures are swallowed and render as a permanent spinner

**What breaks.** Three listeners/reads have no error path, so `loading` is never cleared. A
failure is indistinguishable from "still loading" — the borrower waits forever.

**Evidence.**
- `public-v2/src/pages/MyLoans.tsx:84-87` — `onSnapshot(q, (snap) => {…setLoading(false)})`;
  no error callback. `setLoading(false)` exists only on the success path, and the early
  return at `:147-159` renders a spinner. Same shape for the repayments listener at `:101-105`.
- `public-v2/src/pages/EmployeeDashboard.tsx:45-53` — `await getDoc(...)` inside an async IIFE
  with **no** `try/catch`. On rejection `setPageState('dashboard')` never runs, so `:92-98`
  spins forever, plus an unhandled promise rejection.
- `public-v2/src/pages/LoanWizard.tsx:588-598` — post-submit listener has no error callback;
  the real-time status badge silently freezes on `pending` (`:759-761`).

**Failure scenario.** Transient permission error or offline → borrower sees a spinner
indefinitely with no error, no retry, and no way to tell an outage from slowness. In the
wizard case they are told their application is `pending` when the app has simply stopped
listening.

**Blast radius.** All three borrower-facing loan surfaces.

## F8 — LOW: "Outstanding" omits two outstanding statuses

`public-v2/src/pages/MyLoans.tsx:138-140` counts
`['pending','under_review','approved','disbursed','active','overdue']`. The canonical
`OUTSTANDING_STATUSES` (`functions/src/loans/loanStatus.ts:113-121`) also includes
`disbursement_queued` and `in_collections`. A loan mid-disbursement or in collections is
excluded from both the "Active" count and the "Outstanding" money total (`:141-144`), so the
borrower's outstanding balance reads low during exactly those windows.

## F9 — LOW: the wizard step indicator renders four segments for a three-step wizard

`public-v2/src/pages/LoanWizard.tsx:971` hardcodes `{[1, 2, 3, 4].map((s) => …)}` while
`TOTAL_STEPS = 3` (`:32`) and the caption reads "de 3" (`:1678`). `step` never exceeds 3, so
the fourth segment can never fill: on the final step the borrower sees a 75%-complete bar
above the words "Paso 3 de 3". This is the exact drift the comment at `:28-32` says the
constant exists to prevent — the indicator is the one place that did not use it.

## F10 — LOW: divide-by-zero in the amount slider

`public-v2/src/pages/LoanWizard.tsx:453` — `sliderPct = ((amount - MIN_AMOUNT) / (cappedMax - MIN_AMOUNT)) * 100`.
When `cappedMax === MIN_AMOUNT` (reachable: `availableCredit` ≈ 500, e.g. a declared salary of
~1,700 MXN → `cappedMax` 500) this is `0/0 = NaN`. `Math.min(100, Math.max(0, NaN))` is `NaN`,
so `:1042` emits `width: "NaN%"` — invalid CSS, silently dropped, fill bar renders empty at
what is actually 100% of the borrower's available credit.

## F11 — INFORMATIONAL: repayment `pending` / `processing` badges are dead code

`LoanTable.tsx:64-65,79-88`, `MyLoans.tsx:325-326,345-354` and `PaymentModal.tsx:54-63` branch
on repayment `status` values `'pending'` and `'processing'`. Both repayment write paths write
`status: 'completed'` unconditionally — `services/payment-server/index.js:150` (card) and
`:295` (payroll deduction). These badges can never render. Harmless today; noted because it is
the same read/write vocabulary drift as F3 and would mislead the next reader.

---

# Cleared — checked, no defect found

Recording these so the negative results are auditable rather than assumed.

- **The quote/pricing path is genuinely sound.** `LoanWizard.tsx:416-452` derives every
  displayed figure — fee rate, fee, total, CAT, schedule, deduction date — from the
  server's `getLoanConfig`, propagates `null` rather than degrading to `0`, and blocks
  submission on `!pricingReady` (`:452,1375,1658`). There is no local fallback rate, no
  locally-derived schedule and no locally-computed due date. The "quoted 8%, charged 30%"
  class of defect is not present in the wizard.
- **No client-side-only guard on the amount.** The server independently re-checks the bounds
  (`functions/src/index.ts:422`), `availableCredit` (`:430`), the 30%-of-salary cap (`:432`)
  and the allowed term (`:423`). The client caps are cosmetic and cannot be used to obtain a
  larger loan.
- **`Math.max(effectiveMax, MIN_AMOUNT)` (`LoanWizard.tsx:410`) is not exploitable.** It looks
  like it could offer an amount above the salary cap, but it is unreachable: `creditLimit =
  min(salary * 0.3, ceiling)` and `availableCredit = creditLimit`
  (`functions/src/index.ts:2011-2016`), so any salary low enough to push `salaryMax` under 500
  also puts `availableCredit` under 500, which the eligibility gate at `LoanWizard.tsx:537`
  rejects first. Traced and dismissed.
- **`repaymentAmount || total` fallbacks resolve correctly.** `PaymentModal.tsx:23`,
  `LoanStatusCard.tsx:288`, `LoanTable.tsx:74`, `EmployeeDashboard.tsx:190` and
  `MyLoans.tsx:62` all read a never-written field first but fall through to `total`, which
  *is* written (`functions/src/index.ts:838`). Fragile, not broken. (`MyLoans.tsx:57-58`
  likewise falls through `principalAmount` → `amount`.)
- **No secrets in the client bundle.** `public-v2/src/lib/firebase.ts:11-19` contains the
  Firebase web config. The `apiKey` there is a public project identifier by design, not a
  credential — it is not a finding. App Check is wired correctly (`:30-51`) and the
  reCAPTCHA site key comes from an env var, not source. No other keys, tokens or internal
  hostnames were found in `public-v2/src`.
- **Firestore rules are tight.** `firestore.rules:137-151` — `loans` are readable only by the
  owning employee, their employer admin, or ops; `create`, `update` and `delete` are all
  `false` for every client. The client's direct reads cannot escalate, and no client write
  path to a loan exists.
- **Auth/role handling is sound.** `useAuth.ts:34-87` prefers custom claims, force-refreshes
  once, then falls back to Firestore, and on total failure sets `user: null` so `RouteGuard`
  redirects rather than spinning (`:83-87`). `RouteGuard.tsx:20-26` checks `user` before role
  and denies unknown roles by default.
- **`npm ci` is not broken in CI.** A bare `npm ci` in `public-v2/` fails with `ERESOLVE`
  (`eslint@10` vs `eslint-plugin-react-hooks@7`, which peers `^9`). This is *not* a CI break:
  `.github/workflows/ci.yml:259` already runs `npm ci --legacy-peer-deps`, and `:262-268` gate
  lint, vitest and typecheck+build. Reported only because the command in the task brief does
  not work as written.

---

## Summary

Two critical money-path defects, both in the collection/repayment direction and both
invisible to the current suite:

1. **F1** — the employer deduction report and its CSV state the principal where the
   obligation is principal + fee, understating every deduction by the full fee.
2. **F2** — the card repayment gate in the client and the one on the server are disjoint, so
   no borrower can ever generate a payment link.

The loan *origination* path — the quote, the CAT disclosure, the fee rate, the schedule and
the due date — was audited closely and is in good shape; the hardening documented in
`LoanWizard.tsx` is real and holds up against the server. The defects are concentrated in the
surfaces *after* origination, which appear never to have been reconciled against the loan
document's actual field names or the canonical status vocabulary.

---

# Addendum — `services/payment-server` accounting, found while verifying F2

Added by the orchestrator, 2026-08-03, while independently re-verifying F2 against source.
Out of the audit's `public-v2/` scope, but it is the other half of the same channel, and it
changes the **merge order** for F2. Line numbers read on `8275294`.

## G1 — `order.paid` marks a loan fully repaid regardless of how much was collected

`services/payment-server/index.js:145-153`. The handler's only guard is
`if (!doc.exists || doc.data().status === 'paid') return;`. It then writes
`status: 'paid'` and `paidAmount: amount` **unconditionally** — no comparison against
`total` or `remainingBalance` — and increments the employee's `availableCredit` by the
full `doc.data().amount`.

Compare `charge.paid` immediately below (`:183-190`), which *is* balance-aware: it computes
`newBalance` and only sets `paid` when `newBalance <= 0`. Two handlers, same collection,
divergent logic. **The checkout-link flow is the unguarded one** — `generatePaymentLink`
mints a Conekta *order*, which settles as `order.paid`.

Failure scenario: borrower owes 6,500, pays 1,000 through the link. Loan → `paid`,
`availableCredit` restored by the full principal, 5,500 of debt erased, and the borrower can
immediately re-borrow against money they never repaid.

## G2 — `charge.paid`'s balance fallback is principal, not the obligation

`services/payment-server/index.js:184` — `(loanData.remainingBalance ?? loanData.amount)`.
`remainingBalance` is only written once a payroll deduction has landed
(`functions/src/payroll/processPayroll.ts:167`), so on a card-first repayment the fallback is
`amount`, the bare principal (`functions/src/index.ts:830`). The obligation is `total`
(`:838`). Paying exactly the principal drives `newBalance` to 0 and settles the loan with the
entire fee uncollected — the same defect class as LAUNCH_GAPS P0-2, one layer down.

## G3 — known residual, not a new find

The `'paid'` vs canonical `'repaid'` split is deliberate and already documented at
`functions/src/loans/loanStatus.ts:145-162`: the trigger owns only `'repaid'` so that card
repayments, which restore `availableCredit` in their own transaction, are not credited twice.
The residual that file names — the employer's `activeLoans` slot is **not** released on the
card or payroll-sync paths — is still open, and the fix it proposes (make
`onLoanStatusChange` the single owner of both counters and strip the increments out of
`payment-server`) would subsume G1 and G2 cleanly.

## Consequence for merge order

These three are **latent today only because the card channel is unreachable** (F2). Landing
the F2 gate fix alone would make them live in the same deploy. F2 must not merge ahead of the
`payment-server` accounting fix.
