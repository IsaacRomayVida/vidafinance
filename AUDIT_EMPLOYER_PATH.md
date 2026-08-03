# Audit — the employer-facing money path

**Branch:** `audit/employer-money-path` (base `origin/main` @ d5a992f)
**Scope:** `functions/src/payroll/**`, `functions/src/employers/**`, `processPayroll` and the
deduction/remittance path, the employer surfaces in `public-v2/src` (dashboard, deduction
reports, payroll upload, employee roster, analytics, employer onboarding/verification), and
the employer-related blocks of `firestore.rules`.
**Nature:** read-only audit. No product source was modified. The one file written during the
audit was a throwaway rules-verification harness, deleted before commit (see §Method).

Companion to `AUDIT_PUBLIC_V2.md`, which covered the borrower half of the same money path.
This is the other half: how money comes *back*. Nothing in this document re-audits a borrower
surface.

## Suite results actually observed

| Command | Result |
|---|---|
| `cd functions && npm test` | **exit 0** — 29 suites passed (29), 546 tests passed (546), 33.5s |
| `cd public-v2 && npx vitest run` | **exit 0** — 18 files passed (18), 154 tests passed (154), 9.58s |
| `cd public-v2 && npm run lint` | **exit 0** — 0 errors, 1 warning (`Navbar.tsx:68`, pre-existing, borrower-side) |
| `cd public-v2 && npx tsc -b --noEmit` | **exit 0**, no diagnostics |

Every defect below passes typecheck and passes both suites. **None is caught today.** There is
no test file for `processPayroll` anywhere in the repo (`functions/src/__tests__/` contains
seven files; none covers it), and `firestore.rules.test.ts` tests exactly two employer-update
cases — `contactName` (succeeds) and `status` (fails) — neither of which is a field any
employer surface actually writes.

As in the prior audit, `npm ci` in `public-v2/` requires `--legacy-peer-deps`.

## Method

Same method as `AUDIT_PUBLIC_V2.md`, which is why its findings held: for every field a client
surface reads, I grepped for the backend writer of that exact field, and for every status gate
I read both sides. A field with zero writers is a defect. Nothing below is reported that I have
not read the source for on both sides.

Two additions this pass:

1. **The claim-shape check.** `E1` and `E2` both turn on what is in a user's custom claims, so I
   enumerated every `setCustomUserClaims` call in the repository rather than inferring:
   `functions/src/index.ts:1617,1659,2001`, `functions/src/employers/approveEmployer.ts:290`,
   `functions/src/admin/adminClaims.ts:77,132`, `scripts/set-employer-claims.js:41`,
   `scripts/bootstrap-super-admin.js:136`. **Every one writes `{ role: … }` and nothing else.**
   No `employerId` claim is ever minted, anywhere, by any path.
2. **Empirical rules verification.** The four denied client writes in `E2` and `E6` were run
   against the real rules engine (`firebase emulators:exec --config firebase.emutest.json`,
   `@firebase/rules-unit-testing`) in a scratch spec, **6/6 passing** — the four denials plus two
   controls: that a whitelisted `contactName` write *succeeds* (proving the harness is sound and
   the denials are not false positives), and that an `employerId` claim *would* satisfy
   `isEmployerAdminOf` if one were ever set (isolating the cause to the missing claim, not the
   rule). The scratch file was deleted; it is not part of this deliverable.

The authoritative loan-document shape remains the single
`tx.set(db.collection('loans').doc(loanId), {…})` at `functions/src/index.ts:822-878`. The
canonical status vocabulary is `functions/src/loans/loanStatus.ts:23-47`, mirrored for the
client in `public-v2/src/lib/loanStatus.ts`.

---

# Findings, most severe first

## E1 — CRITICAL: `processPayroll` is unreachable for every employer; the primary collection channel is dead

**What breaks.** The employer-scoping check compares the request against a custom claim that no
code path in the repository ever sets. It is `undefined` for every real caller, so the
comparison is always unequal and the function always throws.

**Evidence — the server gate.** `functions/src/payroll/processPayroll.ts:64-67`:
```ts
// Verify the caller actually belongs to the employer
if (claims['role'] === 'employer_admin' && claims['employerId'] !== input.employerId) {
  throw new HttpsError('permission-denied', 'Employer mismatch');
}
```

**Evidence — the claim is never written.** Enumerated in §Method: all eight
`setCustomUserClaims` call sites write `{ role: … }` only. An employer_admin's token therefore
carries `role` and nothing else, so `claims['employerId']` is `undefined`.

**Evidence — the client sends a real value.** `public-v2/src/pages/PayrollUpload.tsx:133`:
```ts
const out = await fn({ employerId: user!.uid, payPeriodStart: periodStart, payPeriodEnd: periodEnd, rows });
```
`user.uid` is a non-empty string, and it is the correct identifier — an employer_admin's uid
*is* the employer doc id (`firestore.rules:23-24`, and `EmployerDashboard.tsx:652` reads
`employers/{uid}` on exactly that basis). So `undefined !== "<uid>"` → **true**, unconditionally.

**Evidence — the correct pattern exists in this codebase.** `functions/src/invites/sendEmployeeInvite.ts:69-75`
solves the identical problem correctly, and its comment states the rule:
```ts
// An employer_admin is scoped to their own employer record. For this product
// an employer's uid *is* the employer doc id; employerId on the claim is the
// fallback when the two ever diverge.
const ownsEmployer = auth.uid === employerId || auth.employerId === employerId;
```
`processPayroll` kept the fallback half and dropped the half that actually matches.

**Failure scenario.** An employer uploads a valid payroll CSV. Parsing succeeds, the preview
renders, they pick the period and submit. `processPayroll` throws `permission-denied: Employer
mismatch` before touching a single loan. `PayrollUpload.tsx:135-137` catches it and renders the
raw message in the error box. This happens **100% of the time, for every employer, on every
upload**. Only a caller holding `role === 'admin'` — a Funpay internal, not a customer — skips
the check, because the guard is gated on `role === 'employer_admin'`.

**Consequence in money terms.** Payroll deduction is the product's primary repayment channel —
the entire premise of employer-linked lending. Not one deduction can ever be registered through
it. `loans.remainingBalance` is only ever written by this function
(`processPayroll.ts:167`), so no loan balance ever decreases by payroll, no loan ever reaches
`repaid` via `:171`, and the employer's `activeLoans` slot is never released. Combined with the
borrower-side `F2` (card repayment unreachable until #502), **there was no reachable repayment
path into the system at all.** Revenue is not merely at risk; it is uncollectable through this
channel.

**Recommended fix.** Mirror `sendEmployeeInvite.ts:72` exactly:
```ts
const ownsEmployer = request.auth.uid === input.employerId || claims['employerId'] === input.employerId;
if (claims['role'] === 'employer_admin' && !ownsEmployer) {
  throw new HttpsError('permission-denied', 'Employer mismatch');
}
```
This must land with a test — there is currently none for this function.

## E2 — CRITICAL: employee registration cannot complete; its final write is denied by the rules

**What breaks.** The last step of employee account creation increments a counter on the
*employer's* document. The employee is not the employer admin and holds no claim that would
make them one, and the field is not on the employer-update whitelist. The write is denied, the
rejection propagates into the enclosing `try`, and the wizard never advances.

**Evidence — the client write.** `public-v2/src/pages/Onboarding.tsx:571-573`, inside
`createEmployeeAccount`, awaited and **not** individually guarded:
```ts
await updateDoc(doc(db, 'employers', memData.employerId), {
  totalEmployees: increment(1),
});
```

**Evidence — the rule that denies it.** `firestore.rules:74-76`:
```
allow update: if isAdmin()
              || (isEmployerAdminOf(employerId)
                  && onlyAffects(['contactName', 'contactEmail', 'contactPhone', 'logoUrl', 'updatedAt']));
```
The caller is the newly-created employee: `isAdmin()` is false; `isEmployerAdminOf(employerId)`
(`:25-29`) is false on both clauses — their `uid` is their own, not the employer's, and the
`employerId` claim does not exist (§Method, and see E1). `totalEmployees` is absent from the
whitelist regardless.

**Evidence — the denial is real, not inferred.** Verified against the rules engine; the
assertion `employee CANNOT increment employers/{id}.totalEmployees` passes, alongside the
control proving whitelisted writes succeed in the same harness.

**Evidence — it is fatal to the flow.** The `await` at `:571` sits directly in
`createEmployeeAccount`'s `try`, whose `catch` is at `:589-591`:
```ts
      goForward(6);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error creating account');
```
So on rejection: `goForward(6)` at `:588` never runs, and the `acceptInvite` linking step at
`:576-587` — which binds the auth uid to the pre-existing roster employee doc — never runs
either.

**Failure scenario.** An employee completes the whole wizard. Their Firebase Auth user is
created and `employees/{uid}` is written successfully at `:545`. Then the wizard stops on a raw
`permission-denied` string and never reaches the confirmation step. The account half-exists:
the employee cannot be told they succeeded, invite-linked employees are never linked to their
roster row, and a retry hits `auth/email-already-in-use` — handled at `:533-535` by signing in,
so the user can loop through this indefinitely and never get past it.

**Consequence in money terms.** No new borrower can be onboarded through this flow, so no new
loan demand can enter the system. Separately, `employers/{id}.totalEmployees` never increments,
which is the number the employer dashboard renders as "Total Empleados"
(`EmployerDashboard.tsx:766`) — it stays pinned at the `0` written at
`Onboarding.tsx:518`, making the employer's adoption metric permanently zero.

**Recommended fix.** Headcount is a derived counter and does not belong in a client write. The
server already computes it correctly — `functions/src/index.ts:1282,1290` counts
`employees where employerId == uid`. Either drop the client write entirely and read the
server's count, or maintain `totalEmployees` from an `onEmployeeDocCreated` trigger with the
Admin SDK, as `activeLoans` is already maintained in
`functions/src/loans/onLoanStatusChange.ts:18,54`.

## E3 — CRITICAL: overdue loans are billed to the employer but the server refuses to collect them

**What breaks.** The employer's deduction report lists `overdue` loans with an amount owed. The
payroll processor's loan lookup excludes `overdue`. The employer deducts from the paycheck; the
server declines to record it. This is the `F2` disjoint-gate shape, on the collection channel.

**Evidence — the read side includes `overdue`.** `public-v2/src/pages/DeductionReports.tsx:42`
queries `where('status', 'in', DEDUCTION_REPORT_STATUSES)`, defined at
`public-v2/src/lib/loanStatus.ts:39-43`:
```ts
export const DEDUCTION_REPORT_STATUSES: readonly string[] = [
  ...DISBURSED_STATUSES,      // 'active', 'disbursed'
  LOAN_STATUS.OVERDUE,        // 'overdue'  ← listed as deductible
  ...REPAID_STATUSES,
];
```

**Evidence — the write side excludes it.** `functions/src/payroll/processPayroll.ts:106-111`:
```ts
const loanSnap = await db.collection('loans')
  .where('employeeId', '==', row.employeeId)
  .where('employerId', '==', input.employerId)
  .where('status', 'in', ['active', 'disbursed'])   // ← no 'overdue', no 'in_collections'
  .limit(1)
  .get();
```
A hardcoded literal where the canonical `DISBURSED_STATUSES` constant
(`functions/src/loans/loanStatus.ts:78`) exists — and `overdue` is a live status written by
`functions/src/index.ts:2092`.

**Failure scenario.** A loan goes 1 day past due → `overdue`. It stays on the employer's
deduction report showing its full outstanding balance. Payroll runs, the employer withholds
that amount from the employee's paycheck and uploads the CSV. `processPayroll` finds no
matching loan, pushes `{ deductionAmount: 0, error: 'no_active_loan' }` (`:113-119`), and
**writes nothing**. `remainingBalance` is untouched. The loan stays `overdue` and keeps
accruing overdue treatment.

**Consequence in money terms.** The employee has had money taken from their wages that is never
credited against their debt — the worst failure direction in a lending product, and the one
that creates real liability. The employer's books show a deduction remitted; Funpay's show the
loan still outstanding. Every subsequent period repeats it, on exactly the loans that are
already in trouble. `in_collections` (`loanStatus.ts:45`) is excluded on both sides and so
merely invisible; `overdue` is the dangerous case because it is visible on one side only.

**Recommended fix.** Replace the literal with the canonical constant, widened to the statuses a
deduction may legitimately land against — `[...DISBURSED_STATUSES, 'overdue', 'in_collections']`
— and derive `DEDUCTION_REPORT_STATUSES` and this query from one shared definition so they
cannot drift again. Note the Firestore `in` operator caps at 30 values; this list is far under.

## E4 — HIGH: the employer dashboard's stats block reads a key the server does not return

**What breaks.** The client destructures `stats` off the `getEmployerDashboard` response. The
function returns no `stats` key. Every headline number silently falls back to a local
recomputation, each of which is wrong in a different way — and the correct server-side values
are computed and then thrown away.

**Evidence — the read.** `public-v2/src/pages/EmployerDashboard.tsx:674-676`:
```ts
const getEmployerDashboard = httpsCallable<unknown, { stats: DashStats }>(functions, 'getEmployerDashboard');
const result = await getEmployerDashboard({});
if (!cancelled) setStats(result.data.stats || {});
```
**Evidence — the write.** `functions/src/index.ts:1287-1291`, the function's only return:
```ts
return {
  employer: projectDoc(empDoc, EMPLOYER_DASHBOARD_FIELDS),
  loans: loans.docs.map((d) => ({ id: d.id, ...d.data() })),
  employeeCount: employees.size,
};
```
No `stats`. So `result.data.stats` is `undefined`, `setStats({})` runs, and every `stats.x ?? …`
takes the fallback. The `try/catch` at `:672-679` cannot detect this — the call *succeeds*.

**What the fallbacks then get wrong.** `EmployerDashboard.tsx:764-766`:
- `activeCount` → `loans.filter(l => l.status === 'approved' || l.status === 'active')`.
  Counts `approved` (money **not** sent) and omits `disbursed` — the manual ops disbursement
  spelling (`functions/src/loans/markLoanDisbursed.ts:116,247`) — and `overdue`.
- `totalDisbursed` → `loans.filter(l => l.status !== 'rejected' && l.status !== 'pending').reduce((s, l) => s + l.amount, 0)`.
  Wrong twice: it sums `amount`, the bare **principal** (`functions/src/index.ts:830`) rather
  than `total` (`:838`), *and* its filter admits `approved`, `disbursement_queued`,
  `disbursement_failed`, `cancelled`, `rejected_ml` and `written_off` — six statuses where
  either no money left the building or the loan is dead. It overstates the portfolio by every
  undisbursed loan while understating each real one by the full 30% fee.
- `totalEmployees` → `employer?.totalEmployees ?? 0`, which E2 pins at 0.

Meanwhile the server *did* compute `employeeCount` correctly (`:1290`) and is discarded, and the
maintained `employers/{uid}.activeLoans` counter
(`functions/src/loans/onLoanStatusChange.ts:18,54`; `functions/src/index.ts:1731,1778`) is
never read by any employer surface. `DashStats.overdueCount`, `.adoptionRate` and
`.outstandingBalance` (`EmployerDashboard.tsx:47-50`) are declared and never rendered at all.

**Consequence in money terms.** The four numbers an employer uses to decide whether the
programme is working are all wrong, and "Total Desembolsado" — the one denominated in pesos — is
wrong in both directions at once with no way for the employer to notice.

**Recommended fix.** Return a `stats` object from `getEmployerDashboard` built from the
canonical status sets (`OUTSTANDING_STATUSES`, `DISBURSED_STATUSES`) and `total`, not `amount`;
delete the client-side fallback rather than leave a second opinion in place.

## E5 — HIGH: a successful payroll batch reports "0 deducted, $0"

**What breaks.** The result rows the client renders are keyed on a `status` field the server
never writes.

**Evidence — the read.** `public-v2/src/pages/PayrollUpload.tsx:15-21,142-147`:
```ts
type RowResult = { employeeId: string; status: 'deducted' | 'skipped' | 'error' | 'already_processed'; … };
…
const deductedCount = results?.filter(r => r.status === 'deducted').length ?? 0;
const skippedCount  = results?.filter(r => r.status === 'skipped').length ?? 0;
const errorCount    = results?.filter(r => r.status === 'error').length ?? 0;
const totalDeducted = results?.filter(r => r.status === 'deducted')
  .reduce((sum, r) => sum + (r.deductionAmount ?? 0), 0) ?? 0;
```
**Evidence — the write.** `processPayroll` declares its result shape at
`functions/src/payroll/processPayroll.ts:94-101` as
`{ employeeId; loanId?; deductionAmount; newBalance?; newStatus?; error? }` and pushes exactly
that at `:114-118`, `:136-141` and `:185-191`. There is **no `status` field**. The nearest thing
is `newStatus` (`:190`), which is the *loan's* status (`repaid`/`active`), not a row outcome.

**Failure scenario.** All four counters are structurally `0` and `totalDeducted` is
structurally `$0`, so the summary at `:345-351` reads "0 deducted, 0 skipped, 0 errors, $0" for a
batch that deducted correctly. Worse, the per-row badge at `:382` calls
`t(\`payroll_status_${r.status}\`)` → `t('payroll_status_undefined')`. Only the four declared
keys exist (`en.json:939-942`, `es.json:939-942`) and `i18n/index.ts` configures no
`parseMissingKeyHandler`, so i18next returns the key verbatim: every row renders the literal
string **`payroll_status_undefined`**.

**Consequence in money terms.** The employer's only confirmation that a deduction batch landed
says nothing landed. The safe reaction — re-upload — is at least idempotent for a *completed*
batch (`:75-82`), but see E9 for the case where it is not. Latent behind E1 today; it becomes
live the moment E1 is fixed, so it must ship in the same release.

**Recommended fix.** Have the server set an explicit row `status` (`'deducted' | 'skipped' |
'error' | 'already_processed'`) rather than leaving the client to infer one, and give
`statusColor`/the badge a fallback for unknown values.

## E6 — HIGH: three employer self-service writes are denied by the rules; two fail silently

**What breaks.** `firestore.rules:74-76` permits an employer to update only
`['contactName','contactEmail','contactPhone','logoUrl','updatedAt']`. Three employer surfaces
write outside that set. All three are denied — **verified against the rules engine** (§Method).

**E6a — employer verification cannot complete.** `public-v2/src/pages/EmployerDashboard.tsx:117-126`
(`DocUploadBanner`):
```ts
await updateDoc(doc(db, 'employers', uid), {
  docRFC: uploads['rfc'], docId: uploads['id_oficial'], docAddress: uploads['comprobante'],
});
setAllDone(true);
setTimeout(onComplete, 3000);
} catch {
  // Firestore update failed
}
```
The three files upload to Storage successfully, then the Firestore write is denied and swallowed
by an **empty catch**. `setAllDone(true)` never runs, so the success panel at `:130-141` never
renders and `onComplete` never fires. The employer re-uploads the same documents forever, and
`docRFC` stays `null` (`Onboarding.tsx:513`), which is exactly the condition at `:736`
(`needsDocs`) that keeps them on this screen. Employer verification is a permanent dead end —
and an unverified employer is one whose employees cannot borrow.

**E6b — payroll deduction setup (Part B) cannot complete.** `EmployerDashboard.tsx:336-339`
writes `sampleCurps` and `partBStatus: 'pending'`; denied → the `catch` at `:342-344` surfaces
`dash_partb_error`. `partBStatus` never leaves `undefined`, so the card at `:987` renders
forever and the CURP sample Funpay needs to wire up the employer's payroll integration is never
delivered.

**E6c — the employer invite code is never backfilled.** `public-v2/src/pages/EmployeeRoster.tsx:176-178`:
```ts
const code = generateEmployerCode();
await setDoc(empRef, { employerCode: code }, { merge: true });
setEmployerCode(code);
```
Denied. The enclosing async IIFE (`:168-181`) has **no `try/catch`**, so this is an unhandled
promise rejection; `setEmployerCode` never runs and the invite-code card at `:410` never
renders. Any employer whose document lacks `employerCode` can never obtain one — and that code
is the only way employees join (`Onboarding.tsx` employee flow keys on it).

**Consequence in money terms.** Three separate cul-de-sacs on the path from "employer signed up"
to "employer's staff can borrow and repay". Two of them report nothing at all to the user.

**Recommended fix.** These are all legitimately privileged writes and belong behind callables
with the Admin SDK — `updateEmployerCurpConfig` (`EmployerDashboard.tsx:405-410`) is the model
already used correctly on the same page. `employerCode` in particular must be server-minted
(see E15). At minimum, replace the empty catch at `:124-126` and add a `catch` to the roster
IIFE so failures are visible.

## E7 — HIGH: the fallback deduction amount is derived from two fields nothing writes

**What breaks.** When a payroll row omits `deductionAmount`, the server computes one from
`loan.monthlyPayment` and `loan.payPeriodsPerMonth`. Neither field is ever written to a loan
document.

**Evidence.** `functions/src/payroll/processPayroll.ts:125-133`:
```ts
const monthlyPayment    = Number(loan['monthlyPayment']    ?? loan['total'] ?? 0);
const payPeriodsPerMonth = Number(loan['payPeriodsPerMonth'] ?? 2); // default bi-weekly
const deductionAmount = row.deductionAmount ?? calcExpectedDeduction(remainingBalance, monthlyPayment, payPeriodsPerMonth);
```
Repo-wide grep for `monthlyPayment` returns four hits, **all inside this one file** (`:30,33,126,131`);
likewise `payPeriodsPerMonth` (`:31,33,127,132`). The loan write at
`functions/src/index.ts:822-878` contains neither. So the expression is always
`calcExpectedDeduction(remainingBalance, total, 2)`, i.e. `:33`:
```ts
const perPeriod = Math.ceil(monthlyPayment / payPeriodsPerMonth);   // = ceil(total / 2)
```

**What it ignores.** The loan carries a real, contractual amortisation schedule —
`repaymentSchedule[]` at `functions/src/index.ts:852-856`, built by
`buildLoanInstallments(amount + fee, dueDate, term)` (`:507`, mirrored at
`markLoanDisbursed.ts:162`) — and the borrower's real cadence, frozen onto the loan as
`borrowerSnapshot.payFrequency` (`:850`) by `resolvePayFrequency`. The deduction calculation
consults neither.

**Failure scenario.** A $5,000 loan at the 30% fee rate → `total: 6,500`. The fallback deducts
`ceil(6500/2)` = **$3,250 per pay period**, for every borrower, regardless of cadence. A
monthly-paid employee has half the entire obligation taken out of one paycheck; a weekly-paid
employee is billed the bi-weekly figure every week — roughly double the contractual rate. The
schedule the borrower actually signed says something different in both cases.

**Latent divide-by-zero.** `Number(loan['payPeriodsPerMonth'] ?? 2)` uses `??`, which does not
catch `0`. Should that field ever start being written and hold `0`, `Math.ceil(x / 0)` is
`Infinity`, and `Math.min(Infinity, remainingBalance)` (`:34`) returns `remainingBalance` — the
entire loan collected in one pay period. Unreachable today only because the field has no writer.

**Recommended fix.** Derive the expected deduction from `loan.repaymentSchedule[]` — the figures
the borrower was actually quoted — selecting the installment(s) falling inside
`[payPeriodStart, payPeriodEnd]`, and drop both phantom fields. Guard the divisor regardless.

## E8 — HIGH: an employer-supplied deduction amount can mark any loan repaid

**What breaks.** `row.deductionAmount` is taken from the uploaded CSV and trusted without an
upper bound, and the balance write clamps at zero, which converts an over-stated deduction into
full repayment.

**Evidence.** Schema: `functions/src/payroll/processPayroll.ts:16` —
`deductionAmount: z.number().nonnegative().optional()`; no maximum. Used unvalidated at `:129`.
Then `:145-147`:
```ts
const newBalance = Math.max(0, remainingBalance - deductionAmount);
const loanFullyRepaid = newBalance === 0;
const newStatus = loanFullyRepaid ? 'repaid' : loan['status'];
```
and committed at `:166-175`, setting `status: 'repaid'` and `repaidAt`. The client validates only
`Number.isFinite(ded) && ded >= 0` (`PayrollUpload.tsx:96`).

**Failure scenario.** A borrower owes $6,500. A payroll CSV — malicious, or a spreadsheet cell
with a stray digit — carries `deductionAmount: 65000`. `newBalance` clamps to `0`, the loan is
written `repaid`, `notifyLoanEvent('loan_repaid', …)` fires (`:180`), and
`onLoanStatusChange` restores the employee's `availableCredit`
(`functions/src/loans/loanStatus.ts:163-165`) so they can immediately re-borrow. Nothing
anywhere records that only a fraction — or nothing — was actually remitted to Funpay.

**Consequence in money terms.** Any employer can extinguish their employees' debts to Funpay by
uploading a CSV, with no remittance and no reconciliation step to catch it (see E16). This is
the same accounting shape as `G1` in the prior audit's addendum — a repayment marked complete
without checking what was collected — on the payroll channel rather than the card channel.

**Recommended fix.** Clamp to the obligation: `Math.min(row.deductionAmount, remainingBalance)`,
and reject rather than silently truncate when the row exceeds it, so the employer sees the
discrepancy. Do not derive `repaid` from a client-supplied number without a matching remittance.

## E9 — MEDIUM: an interrupted payroll batch re-deducts every row when retried

**What breaks.** Two compounding gaps: the loan is read outside the transaction that updates it,
and the batch-level dedup only short-circuits on `completed`.

**Evidence — stale read.** The loan is fetched at `processPayroll.ts:106-111` and its
`remainingBalance` captured at `:125`. The transaction at `:150-176` performs **no `tx.get`** —
it writes `remainingBalance: newBalance` (`:167`) computed from the pre-transaction snapshot.
Firestore's optimistic concurrency cannot protect a value the transaction never read, so two
concurrent batches both write a balance derived from the same starting figure and one deduction
is lost.

**Evidence — retry re-deducts.** The batch is marked `in_progress` at `:85-92` and `completed`
only at `:203-208`. The dedup guard at `:75-82` returns early **only** when
`status === 'completed'`. A batch that times out or crashes mid-way is left `in_progress`; the
natural retry passes the guard and reprocesses **every row from the first**, including rows
already deducted. Each `payrollDeductions` record is a fresh auto-id doc (`:151`), so there is no
per-row idempotency key to catch it.

**Failure scenario.** A 10,000-row batch is processed serially in a `for` loop (`:103`) with a
Firestore transaction per row; it exceeds the callable timeout at row 6,000. The employer
retries. Those 6,000 employees are debited a second time — real balance reductions against
wages deducted once.

**Recommended fix.** Read the loan inside the transaction with `tx.get`, and make idempotency
per-row: give `payrollDeductions` a deterministic id (e.g. `${batchId}_${employeeId}_${loanId}`)
and `create` it, so a replay fails the write instead of duplicating it.

## E10 — MEDIUM: the report's "Deducción" is the whole outstanding balance, grouped by the wrong date

**What breaks.** The column an employer reads as "the amount to deduct this period" is the full
remaining obligation, and the periods it is grouped under are loan-creation months, not pay
periods.

**Evidence — the amount.** `public-v2/src/lib/deductionReport.ts:47-55` returns
`remainingBalance ?? total` — the full outstanding figure. Rendered under the header
`ded_th_deduction` / "Deducción" (`DeductionReports.tsx:158,171`), summed into "Total
Deducciones" (`:105-106`, via `:58`), into each group's `Total:` badge (`:149`, via
`deductionReport.ts:95`), and into the exported CSV (`:109,115`).

**Evidence — the grouping.** `deductionReport.ts:62-67` keys on `loan.createdAt`, and
`getPeriodLabel` (`:70-78`) renders that as a month name — so a row is filed under the month the
loan was *originated*, presented as though it were the deduction period.

**Three disagreeing definitions of "this period's deduction"** now exist: this one (the full
balance), `processPayroll`'s fallback (`ceil(total/2)`, E7), and `repaymentSchedule[].amount`
(the contractual installment, `functions/src/index.ts:852-856`). None references another.

**Consequence in money terms.** An employer reconciling payroll against this sheet withholds the
entire outstanding balance from a single paycheck — for a $5,000 loan, $6,500 out of one pay
period rather than the scheduled installment. Note this is *not* the prior audit's `F1`: that
was principal-vs-obligation and is correctly fixed here (the comment at `:36-46` documents it).
This is the remaining per-period-vs-total framing on top of the corrected number.

**Recommended fix.** Show the scheduled installment for the selected period from
`repaymentSchedule[]`, with the outstanding balance as a separate, separately-labelled column;
group by pay period, not `createdAt`.

## E11 — MEDIUM: four employer surfaces define "active loans" four different ways

None matches the canonical `DISBURSED_STATUSES = ['active','disbursed']`
(`functions/src/loans/loanStatus.ts:78`):

| Surface | Line | Set used | Wrong how |
|---|---|---|---|
| Employer dashboard | `EmployerDashboard.tsx:764` | `['approved','active']` | counts undisbursed; omits `disbursed`, `overdue` |
| Employee roster | `EmployeeRoster.tsx:255-258` | `['active']` | omits `disbursed`, `overdue` |
| Employer analytics | `AnalyticsPage.tsx:53` | `['approved','disbursed','disbursement_queued']` | **omits `'active'`** — the most common live status |
| Deduction report | `lib/loanStatus.ts:68-70` | `['active','disbursed','overdue']` | correct |

`AnalyticsPage.tsx:53` is the notable one: `active` is what the *automatic* disbursement path
writes (`functions/src/index.ts:1874,1912`), so it is the majority of live loans, and both
"Préstamos Activos" and the peso-denominated `activeLoanAmount` (`:90-95`) exclude all of them
while including `approved`/`disbursement_queued` loans where no money has moved. The same page
sums `l.amount` — principal, not `total` — at `:92`.

**Recommended fix.** One shared constant; `public-v2/src/lib/loanStatus.ts` already exists for
exactly this and is kept honest by `loanStatus.test.ts`.

## E12 — MEDIUM: employer analytics reports a near-zero repayment rate by construction

**Evidence.** `public-v2/src/pages/AnalyticsPage.tsx:101-110` computes on-time repayment from
`l.paidAt`:
```ts
const onTime = withDue.filter((l) => {
  if (!l.paidAt || !l.dueDate) return false;
  return l.paidAt.seconds <= l.dueDate.seconds;
});
```
`processPayroll` writes **`repaidAt`**, not `paidAt`, on full repayment
(`functions/src/payroll/processPayroll.ts:172`). Repo-wide, `paidAt` on a loan is written only
by `services/payment-server/index.js:311` (the internal repayment endpoint) and initialised to
`null` at `functions/src/index.ts:861`.

**Consequence.** Every loan repaid through payroll — the primary channel — has `paidAt === null`
and is counted as *not* repaid on time. The employer's "Repayment Rate" is structurally pinned
near 0%, which is the single metric that would tell them the programme is healthy.

**Recommended fix.** Read `repaidAt ?? paidAt`, or converge the two write paths on one field
name.

## E13 — MEDIUM: read failures render as a permanent spinner on every employer surface

The `F7` class. The borrower surfaces were fixed in `d5a992f`; the employer surfaces were not
touched.

- `DeductionReports.tsx:46-50` — `onSnapshot` with no error callback. `loading` starts `true`
  (`:33`) and is cleared only on success, so the spinner at `:120-125` runs forever.
- `EmployeeRoster.tsx:191-195, 206-209, 219-234` — three listeners, no error callbacks; the
  `getDoc` IIFE at `:168-181` has no `try/catch`. `loading` (`:153`) clears only on the employees
  success path → "Cargando empleados…" (`:557-562`) forever.
- `EmployerDashboard.tsx:651-685` — `await getDoc(...)` at `:652` inside an async IIFE with no
  `try/catch`; on rejection `setPageState('dashboard')` (`:682`) never runs and `:712-718` spins
  forever, plus an unhandled rejection. Notably the loans listener on the *same page*
  (`:704-707`) **does** have an error callback — so the pattern is known here and simply was not
  applied to the document read.

**Consequence.** A permission error — which E6 guarantees on this very page — is
indistinguishable from slowness, with no error and no retry.

## E14 — LOW: `loan.frequency` has no writer, so every report row reads "monthly"

`DeductionReports.tsx:173-175` renders `t(\`freq_${loan.frequency ?? 'monthly'}\`)` and
`deductionReport.ts:110` writes `loan.frequency ?? 'monthly'` into the CSV. The loan document
has no `frequency` field — the cadence is stored as `borrowerSnapshot.payFrequency`
(`functions/src/index.ts:850`), resolved by `resolvePayFrequency.ts`. So the fallback always
wins and the Frequency column reads **monthly** for every loan, including weekly and bi-weekly
employees. An employer scheduling deductions off this column uses the wrong cadence for
everyone not actually on monthly pay. Read `borrowerSnapshot.payFrequency`.

## E15 — LOW: `loan.termDays` has no writer; the employer dashboard prints a hardcoded 30

`EmployerDashboard.tsx:939` — `{loan.termDays ?? 30} {t('dash_days')}`. The loan field is `term`
(`functions/src/index.ts:839`); `termDays` is the request-payload name only (`:396-398,409`) and
is never persisted. Identical to the borrower-side `F5`, still open on this surface: correct
today only because `ALLOWED_LOAN_TERM_DAYS` is `[30]`, and silently wrong for every loan the day
a second term ships.

## E16 — LOW: the "Pagados" tab can never be non-zero

`EmployerDashboard.tsx:53,773,805` defines a `paid` tab and counts
`loans.filter(l => l.status === 'paid')`. `'paid'` is documented dead —
`functions/src/loans/loanStatus.ts:56-61`: *"No write path has ever produced it."* The canonical
completed spelling is `'repaid'` (`:41-43`), and there is no `repaid` tab, so fully repaid loans
appear only under "Todos" and the tab an employer clicks to see them always reads `(0)`.

## E17 — LOW: client-generated employer codes, with no uniqueness check

`EmployeeRoster.tsx:10-17` and `Onboarding.tsx:512` both mint the employer join code in the
browser via `Math.random()` over a 32-character alphabet, 6 characters. No collision check
against existing codes exists on either path. The roster path is dead anyway (E6c), but the
onboarding path is live — `firestore.rules:73` permits self-serve create of any shape. A
collision maps a new employee onto the wrong employer, since `employerCode` is what
`lookupEmployerByCode` resolves against. Should be server-minted with a uniqueness transaction.

## E18 — INFORMATIONAL: there is no remittance or settlement record anywhere

`processPayroll` records that a deduction was **declared** (`payrollDeductions`, `:151-164`) and
immediately reduces the loan balance (`:166-175`). Nothing records that the employer actually
transferred the money to Funpay. A repo-wide grep for `remittance|remit|settlement` outside
`services/payment-server/cardRepayment.js` returns nothing.

So the system's view of "collected" is the employer's unverified assertion. There is no
reconciliation between the sum of `payrollDeductions` for a period and funds received, which is
what would otherwise catch E8. Neither `payrollDeductions` nor `payrollBatches` has a
`firestore.rules` entry, so both fall to the catch-all deny at `:266-268` — correct for safety,
but it also means no employer surface can read the deduction ledger it just wrote, which is why
the deduction report reads `loans` instead (E10).

Recorded as informational because it is a design gap rather than a code defect, but it is the
control that would make E8 non-critical.

---

# Cleared — checked, no defect found

Recording these so the negative results are auditable rather than assumed.

- **The employer approve/reject gate matches on both sides.** This is where the borrower-side
  `F2` bug lived, so it was checked first. `EmployerDashboard.tsx:949` offers the
  Aprobar/Rechazar buttons only when `loan.status === 'pending'`; `updateLoanStatus`
  (`functions/src/index.ts:946-956`) requires, for a non-admin, that `loan.employerId === uid`,
  that `loan.status === 'pending'`, and that the target is in `['approved','rejected']`. The
  client sends exactly `'approved'` or `'rejected'` (`:778`). The sets **intersect correctly** in
  both directions. No disjoint-gate defect here.
- **`updateLoanStatus` validates against the canonical vocabulary.** `index.ts:926-931` rejects
  any status not in `ALL_LOAN_STATUSES`, closing the drift entry point its comment describes.
  The rewind guard at `:957-970` correctly blocks `DISBURSEMENT_INITIATED → PRE_DISBURSEMENT`.
- **Employer loan reads are properly isolated.** `firestore.rules:137-143` — a loan is readable
  only by its employee, its employer admin, or ops; `create`, `update` and `delete` are `false`
  for every client. An employer cannot read another employer's loans, and no client can write a
  loan.
- **`isEmployerAdminOf`'s claim fallback is dead but not dangerous.** `firestore.rules:25-29`
  accepts `request.auth.token.employerId == employerId`. Since no path ever sets that claim
  (§Method), this clause never fires. I checked specifically whether *employees* carry an
  `employerId` claim — they do not (`functions/src/index.ts:2001` writes `{ role: 'employee' }`)
  — because if they did, every employee would satisfy `isEmployerAdminOf` and could read their
  employer's entire roster and loan book via `firestore.rules:105,140`. **They cannot.** The
  isolation the rules claim at `:86-87` holds. Verified with a control assertion against the
  rules engine.
- **`getEmployerDashboard` no longer leaks the payroll credential.** `index.ts:1245-1258`
  projects a 12-field whitelist; `apiKeyHash`, `bankClabe`, `rfc`, `mlScore` and `llmAnalysis`
  are excluded. The `employers` `list` rule is `isOps()` only (`firestore.rules:71`), so the
  anonymous-enumeration hole its comment describes is genuinely closed.
- **Employer self-serve creation cannot escalate privilege.** `isSelfServeEmployerCreate()`
  (`firestore.rules:61-67`) pins `status` to `'pending_verification'` and rejects
  `apiKeyHash`, `creditLimit`, `riskTier`, `mlScore`, `llmAnalysis`, `approvedAt`, `approvedBy`,
  `currentOutstandingBalance` and `maxActiveSlots`. Since `onEmployerDocCreated` keys the
  `employer_admin` claim off `status`, this is the right field to pin.
- **`processPayroll`'s auth and rate limiting are otherwise sound.** `enforceAppCheck: true`
  (`:40`), authentication required (`:43-45`), role restricted to `employer_admin`/`admin`
  (`:47-49`), 10/min/uid rate limit that fails open only on limiter *unavailability* and still
  rethrows a genuine `resource-exhausted` (`:52-60`). Input is Zod-validated with a 10,000-row
  cap (`:10-24`). The defect in this function is the identity comparison (E1), not the
  surrounding guard.
- **No NaN can reach the DOM from the payroll or deduction arithmetic.** Checked explicitly, as
  `F10` was this class. `Number(loan['total'] ?? 0)` and friends (`processPayroll.ts:125-127`)
  coerce `undefined` to `0`, never `NaN`; `calcExpectedDeduction`'s divisor is a literal `2` in
  practice (E7 covers the latent zero case). On the client, `getDeductionAmount`
  (`deductionReport.ts:47-55`) guards every branch with `Number.isFinite` and returns `null`
  rather than a degraded number, and `:171` renders `'—'` for `null`. `PayrollUpload.tsx:90-97`
  rejects non-finite gross/net/deduction at parse time. No division by a client-controlled value
  exists on any employer surface.
- **The deduction report's amount is no longer principal.** The prior audit's `F1` is genuinely
  fixed: `getDeductionAmount` prefers `remainingBalance` then `total`, and explicitly refuses to
  fall back to `amount` (`deductionReport.ts:36-55`). `DEDUCTION_REPORT_STATUSES` now includes
  `disbursed`, `overdue` and the legacy repaid aliases, closing `F3` on the read side. E3 and
  E10 are what remains around it, not a regression of E1's predecessor.
- **CSV export is injection-safe and encoding-correct.** `deductionReport.ts:122` escapes every
  field by wrapping in quotes and doubling internal quotes; `DeductionReports.tsx:19` prepends a
  UTF-8 BOM so Excel renders Spanish month labels and names correctly. Object URLs are revoked
  (`:25`).
- **The payroll CSV upload validates before it submits.** `PayrollUpload.tsx:52-59` enforces a
  5 MB cap and `.csv` extension; `:69-75` requires all four mandatory headers and names the
  missing ones; `:79-101` validates every row and reports per-line errors, capping the displayed
  list at 10 (`:209-215`). Submission is blocked without both period dates (`:121-124,280`).
- **Employer document deletion is impossible from any client.** `firestore.rules:80` —
  `allow delete: if false`, with the same protection on `employees` (`:120`) and `loans`
  (`:151`). An employer cannot orphan their employees' loans.
- **`payrollDeductions` and `payrollBatches` are not client-readable or writable.** Neither has
  a rule block, so both fall to the catch-all `allow read, write: if false`
  (`firestore.rules:266-268`). The deduction ledger cannot be tampered with from a browser.
- **The employer's `activeLoans` counter is maintained correctly server-side.**
  `functions/src/loans/onLoanStatusChange.ts:18,54` increments and decrements it, and
  `isCreditRestoringRepayment` (`loanStatus.ts:163-165`) deliberately owns only the `'repaid'`
  transition so the card path cannot double-restore credit. The counter is sound; the defect is
  that no employer surface reads it (E4). The residual documented at `loanStatus.ts:156-161`
  — the employer slot not being released on the card/payroll-sync `'paid'` paths — is
  pre-existing, already recorded there and in the prior audit's `G3`, and is not re-reported
  here as new.

---

## Summary

**18 findings: 3 CRITICAL, 5 HIGH, 5 MEDIUM, 4 LOW, 1 INFORMATIONAL.**

The employer path is in materially worse shape than the borrower path was. The borrower audit
found surfaces that *displayed* the wrong number; this one finds three channels that **do not
function at all**, and each is load-bearing:

1. **E1** — `processPayroll` compares the caller against an `employerId` custom claim that no
   code path in the repository ever writes, so every employer's payroll upload fails with
   "Employer mismatch". Payroll deduction is the product's primary collection channel and not
   one deduction has ever been able to land through it.
2. **E2** — employee registration's final write increments a counter on the employer document,
   which the rules deny; the rejection is fatal to the enclosing flow, so no employee can
   complete onboarding. Confirmed against the rules engine.
3. **E3** — `overdue` loans appear on the employer's deduction report with a balance owed but are
   excluded from the server's deduction query, so wages withheld against them are never credited
   to the borrower. This is the one that charges a borrower money the system then forgets.

The common cause is the same one the prior audit identified: **read and write sides that were
never reconciled against each other.** Four of the fields these surfaces depend on —
`stats`, row `status`, `monthlyPayment`, `payPeriodsPerMonth`, plus `frequency` and `termDays` —
have **zero writers**, and two more (`paidAt`, the `'paid'` status) are written under a different
name than the one being read. The origination path this money path hangs off remains sound; the
defects are, again, concentrated entirely in what happens *after* a loan exists.

**Merge-order note.** E5 (the payroll result screen reporting `0 deducted / $0`) and E8 (an
unbounded employer-supplied `deductionAmount` marking a loan `repaid`) are both latent **only**
because E1 makes the function unreachable. Fixing E1 alone makes both live in the same deploy.
E1 must not merge ahead of E8. This is the same hazard the prior audit flagged for F2 and the
`payment-server` accounting fixes.
