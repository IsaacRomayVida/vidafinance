import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notifyLoanEvent } from '../utils/notify';
import { enforceRateLimit } from '../utils/rateLimiter';
import { DEDUCTIBLE_STATUSES, LOAN_STATUS } from '../loans/loanStatus';

// ─── Input Schema ─────────────────────────────────────────────────────────────

const DeductionRowSchema = z.object({
  employeeId: z.string().min(1),
  employeeRfc: z.string().length(13).regex(/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/i).optional(),
  grossSalary: z.number().nonnegative(),
  netSalary: z.number().nonnegative(),
  payPeriod: z.string(), // ISO date YYYY-MM-DD
  deductionAmount: z.number().nonnegative().optional(),
});

/**
 * The pay-period window is load-bearing as of the schedule-derived deduction
 * below — `payPeriodEnd` decides which contractual installments have come due —
 * so it can no longer be an unvalidated `z.string()`. The comparison against a
 * persisted due date is a lexicographic one on `YYYY-MM-DD`, which is
 * chronological for that shape and meaningless for any other: a free-text end
 * date would sort above every real due date and pull the entire schedule
 * forward into one paycheck. The employer UI submits `<input type="date">`
 * values (`public-v2/src/pages/PayrollUpload.tsx`), which are already exactly
 * this shape, so nothing a real caller sends is newly rejected.
 */
const CalendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

const ProcessPayrollSchema = z.object({
  employerId: z.string().min(1),
  payPeriodStart: CalendarDaySchema,
  payPeriodEnd: CalendarDaySchema,
  rows: z.array(DeductionRowSchema).min(1).max(10000),
}).refine((v) => v.payPeriodStart <= v.payPeriodEnd, {
  message: 'payPeriodStart must not be after payPeriodEnd',
  path: ['payPeriodEnd'],
});

// ─── Row outcomes ─────────────────────────────────────────────────────────────

/**
 * The outcome of a single payroll row, as the employer's results table reads
 * it (`public-v2/src/pages/PayrollUpload.tsx`). The server used to return no
 * row status at all, so every counter on that page was structurally 0 and each
 * badge rendered the literal string `payroll_status_undefined`.
 *
 *  - `deducted`          — money was applied to a loan.
 *  - `skipped`           — nothing to do: no deductible loan, or nothing owed.
 *  - `already_processed` — this row already landed in a previous attempt at
 *                          this same batch (see the per-row idempotency key).
 *  - `error`             — the row was rejected or blew up; nothing was written.
 */
type RowStatus = 'deducted' | 'skipped' | 'error' | 'already_processed';

type RowResult = {
  employeeId: string;
  status: RowStatus;
  loanId?: string;
  deductionAmount: number;
  newBalance?: number;
  newStatus?: string;
  error?: string;
};

// ─── Money helpers ───────────────────────────────────────────────────────────

/** Balances are pesos-and-centavos; keep float dust out of the ledger. */
function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/** Half a centavo — below this, a difference is float noise, not money. */
const CENT_EPSILON = 0.005;

// ─── The contractual repayment schedule ──────────────────────────────────────

/** One installment as persisted on the loan, after coercion. */
type ScheduledInstallment = { amount: number; dueDate: Date };

/**
 * A persisted installment due date, whatever shape it arrives in.
 *
 * `requestLoan` and `markLoanDisbursed` both write a Firestore `Timestamp`, but
 * this value has crossed an export/import boundary in some environments and the
 * consequence of mis-reading one is monetary, so the plain `Date` and ISO-string
 * forms are accepted too. Anything else is `null`, which fails the whole
 * schedule closed rather than dropping one installment out of it.
 */
function toDueDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value !== null && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const converted = (value as { toDate(): unknown }).toDate();
    return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * The calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * Local getters on purpose: every installment date is produced by
 * `calculateNextPayrollDate`, which builds LOCAL midnights, and the employer's
 * pay-period window is a local calendar window too. Reading one back in UTC
 * would shift a midnight-local due date onto the previous or next day for any
 * deployment not running in UTC and move a whole installment across the window
 * boundary.
 */
function calendarDay(instant: Date): string {
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${instant.getFullYear()}-${month}-${day}`;
}

/**
 * `loan.repaymentSchedule` as installments, or `null` if the loan does not
 * carry a usable one.
 *
 * All-or-nothing by design. A schedule with one unreadable entry cannot be
 * partially trusted: the sum of what is readable is the basis for "how much has
 * the borrower already paid", so silently skipping an entry both understates
 * the obligation and mis-states the arrears. The caller turns `null` into an
 * explicit row error.
 */
function parseRepaymentSchedule(raw: unknown): ScheduledInstallment[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const installments: ScheduledInstallment[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const amount = Number((entry as Record<string, unknown>)['amount']);
    const dueDate = toDueDate((entry as Record<string, unknown>)['dueDate']);
    if (!Number.isFinite(amount) || amount < 0 || dueDate === null) return null;
    installments.push({ amount, dueDate });
  }
  return installments;
}

/**
 * How much of the loan the borrower has contractually been asked for by the
 * close of this pay period, net of everything already collected.
 *
 * This replaces a figure derived from `loan.monthlyPayment` and
 * `loan.payPeriodsPerMonth` — two fields NOTHING in the repository has ever
 * written. The expression therefore always collapsed to `ceil(loan.total / 2)`,
 * so a $5,000 loan at the 30% fee (total $6,500) took $3,250 out of a single
 * paycheck for every borrower, whatever their real cadence: a weekly-paid
 * employee was billed the bi-weekly figure every week, roughly double the
 * contractual rate, and a monthly-paid one had half the entire obligation taken
 * at once. `repaymentSchedule[]` is the amortisation the borrower was quoted,
 * signed and was disclosed a CAT against, built by `buildLoanInstallments`
 * against a due date resolved from that borrower's own `payFrequency` — it is
 * the only figure in the loan document that reflects their actual cadence.
 *
 * The window is closed at the top (`dueDate <= payPeriodEnd`) but deliberately
 * NOT at the bottom. A strict `[payPeriodStart, payPeriodEnd]` band drops
 * arrears permanently: an installment whose due date passed before this batch's
 * window — the ordinary shape of an `overdue` loan, which
 * `DEDUCTIBLE_STATUSES` explicitly includes — would never fall inside any
 * later window either, so the deduction channel would collect nothing on it
 * forever. Netting off what has already been collected gives the same answer as
 * an in-window sum for a loan in good standing, and catches up a missed
 * installment instead of writing it off.
 *
 * Already-collected is derived from the balance, not from prior
 * `payrollDeductions`: repayments also arrive by card
 * (`functions/src/payments/`), and money is money. It can never exceed the
 * schedule, so this cannot ask for more than the borrower agreed to in total.
 */
function scheduledDeductionForPeriod(
  schedule: ScheduledInstallment[],
  remainingBalance: number,
  payPeriodEnd: string,
): number {
  const scheduledTotal = schedule.reduce((sum, i) => sum + i.amount, 0);
  const dueThroughPeriodEnd = schedule
    .filter((i) => calendarDay(i.dueDate) <= payPeriodEnd)
    .reduce((sum, i) => sum + i.amount, 0);

  const alreadyCollected = Math.max(0, scheduledTotal - remainingBalance);
  const outstandingAndDue = dueThroughPeriodEnd - alreadyCollected;

  return roundToCents(Math.min(Math.max(0, outstandingAndDue), Math.max(0, remainingBalance)));
}

/**
 * Deterministic id for the deduction a given batch applies to a given loan.
 *
 * Idempotency has to be per row, not per batch: the batch document is only
 * flipped to `completed` after the last row, so a batch that times out
 * half-way is left `in_progress` and the natural retry re-ran EVERY row from
 * the first, debiting the already-processed employees a second time. With a
 * deterministic id the replayed rows fail their `create` instead.
 *
 * `loanId` alone identifies the employee's loan (and is a Firestore auto-id,
 * so it is safe in a document path — unlike `employeeId`, which comes from the
 * uploaded CSV and may contain anything). Two CSV rows naming the same
 * employee in one batch therefore collapse onto one deduction, which is the
 * behaviour we want.
 */
function deductionDocId(batchId: string, loanId: string): string {
  return `${batchId}__${loanId}`;
}

// ─── Main function ───────────────────────────────────────────────────────────

export const processPayroll = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  async (request) => {
    // Auth: employer_admin role only
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be authenticated');
    }
    const claims = request.auth.token;
    if (claims['role'] !== 'employer_admin' && claims['role'] !== 'admin') {
      throw new HttpsError('permission-denied', 'Employer admin role required');
    }

    // Rate limit: 10/min/uid (expensive batch operation, up to 10k rows).
    // Fail closed: this deducts real money from employee payroll — a limiter
    // outage must not lift the only brake on it.
    await enforceRateLimit(`rl:processPayroll:${request.auth.uid}`, 10, 60, {
      onUnavailable: 'closed',
      context: 'processPayroll',
    });

    const input = ProcessPayrollSchema.parse(request.data);

    // Verify the caller actually belongs to the employer. An employer_admin is
    // scoped to their own employer record, and for this product an employer's
    // uid *is* the employer doc id (firestore.rules, and EmployerDashboard
    // reads employers/{uid} on exactly that basis); `employerId` on the claim
    // is the fallback for if the two ever diverge. This check used to test the
    // claim alone — and no code path in the repository has ever WRITTEN that
    // claim (every setCustomUserClaims call site writes `{ role }` only), so it
    // was `undefined` for every real caller and every employer upload was
    // rejected with 'Employer mismatch'. Same rule as
    // invites/sendEmployeeInvite.ts.
    const ownsEmployer =
      request.auth.uid === input.employerId || claims['employerId'] === input.employerId;
    if (claims['role'] === 'employer_admin' && !ownsEmployer) {
      throw new HttpsError('permission-denied', 'Employer mismatch');
    }

    const db = getFirestore();

    // Deduplication: if this payroll batch already ran, return cached result
    const batchId = `${input.employerId}_${input.payPeriodStart}_${input.payPeriodEnd}`;
    const batchRef = db.collection('payrollBatches').doc(batchId);
    const batchSnap = await batchRef.get();
    if (batchSnap.exists && batchSnap.data()?.['status'] === 'completed') {
      logger.info({ batchId }, 'Payroll batch already processed');
      return {
        batchId,
        status: 'already_processed',
        processedCount: batchSnap.data()?.['processedCount'] ?? 0,
      };
    }

    // Mark in progress
    await batchRef.set({
      employerId: input.employerId,
      payPeriodStart: input.payPeriodStart,
      payPeriodEnd: input.payPeriodEnd,
      rowCount: input.rows.length,
      status: 'in_progress',
      startedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const results: RowResult[] = [];

    for (const row of input.rows) {
      try {
        // Find the loan a deduction can land against. DEDUCTIBLE_STATUSES is
        // the shared definition the employer's deduction report also derives
        // from; this used to be a hardcoded ['active', 'disbursed'], which
        // excluded the `overdue` loans that report bills the employer for.
        const loanSnap = await db.collection('loans')
          .where('employeeId', '==', row.employeeId)
          .where('employerId', '==', input.employerId)
          .where('status', 'in', DEDUCTIBLE_STATUSES as string[])
          .limit(1)
          .get();

        if (loanSnap.empty) {
          results.push({
            employeeId: row.employeeId,
            status: 'skipped',
            deductionAmount: 0,
            error: 'no_deductible_loan',
          });
          continue;
        }

        const loanRef = loanSnap.docs[0].ref;
        const loanId = loanSnap.docs[0].id;
        const deductionRef = db.collection('payrollDeductions').doc(deductionDocId(batchId, loanId));

        // Everything that decides how much money moves happens INSIDE the
        // transaction, against the balance the transaction itself read. The
        // query above only locates the loan; its snapshot is deliberately not
        // used for arithmetic, because Firestore's optimistic concurrency
        // cannot protect a value the transaction never read — two concurrent
        // batches would both write a balance derived from the same starting
        // figure and one deduction would be silently lost.
        const outcome = await db.runTransaction(async (tx): Promise<RowResult> => {
          const deductionSnap = await tx.get(deductionRef);
          if (deductionSnap.exists) {
            const prior = deductionSnap.data() ?? {};
            return {
              employeeId: row.employeeId,
              status: 'already_processed',
              loanId,
              deductionAmount: Number(prior['deductionAmount'] ?? 0),
              newBalance: Number(prior['remainingBalanceAfter'] ?? 0),
            };
          }

          const loanFresh = await tx.get(loanRef);
          if (!loanFresh.exists) {
            return {
              employeeId: row.employeeId,
              status: 'error',
              loanId,
              deductionAmount: 0,
              error: 'loan_not_found',
            };
          }
          const loan = loanFresh.data() ?? {};

          // Re-check under the transaction: the loan may have been repaid or
          // written off between the query and here.
          if (!DEDUCTIBLE_STATUSES.includes(String(loan['status']))) {
            return {
              employeeId: row.employeeId,
              status: 'skipped',
              loanId,
              deductionAmount: 0,
              error: 'loan_not_deductible',
            };
          }

          const remainingBalance = roundToCents(
            Number(loan['remainingBalance'] ?? loan['total'] ?? 0),
          );
          // No amount on the CSV row: fall back to what this borrower's own
          // repayment schedule says is due by the close of this pay period.
          let requestedAmount: number;
          let derivedFromSchedule = false;
          if (row.deductionAmount !== undefined) {
            requestedAmount = row.deductionAmount;
          } else {
            derivedFromSchedule = true;
            const schedule = parseRepaymentSchedule(loan['repaymentSchedule']);
            if (schedule === null) {
              // Loans created before #424 carry no schedule (and
              // markLoanDisbursed deliberately leaves the pre-#437 path's
              // alone). There is no safe amount to invent for them: the figure
              // this branch used to produce, `ceil(total / 2)`, is precisely
              // the over-collection this row error exists to prevent. The
              // employer can still collect by putting an explicit
              // `deductionAmount` on the row, which is bounded by the
              // obligation check below.
              return {
                employeeId: row.employeeId,
                status: 'error',
                loanId,
                deductionAmount: 0,
                error: 'loan_missing_repayment_schedule',
              };
            }
            requestedAmount = scheduledDeductionForPeriod(
              schedule,
              remainingBalance,
              input.payPeriodEnd,
            );
          }

          // The obligation is the ceiling, and the obligation is server-side.
          // `row.deductionAmount` comes straight off the uploaded CSV: an
          // over-stated figure used to clamp to a zero balance and mark the
          // loan `repaid` (restoring the employee's credit), so any employer
          // could extinguish their employees' debts with a spreadsheet typo.
          // Surface the discrepancy instead of silently truncating it — the
          // employer withheld a number we cannot reconcile, and they have to
          // see that. Re-uploading the corrected row is safe: the per-row
          // idempotency key means the rows that did land are not re-applied.
          if (requestedAmount - remainingBalance > CENT_EPSILON) {
            return {
              employeeId: row.employeeId,
              status: 'error',
              loanId,
              deductionAmount: 0,
              error: `deduction_exceeds_balance:requested=${roundToCents(requestedAmount)},owed=${remainingBalance}`,
            };
          }

          const deductionAmount = roundToCents(Math.min(requestedAmount, remainingBalance));
          if (deductionAmount <= 0) {
            // Zero off the schedule with a balance still outstanding is not
            // "nothing owed" — it is "the borrower's next installment is not
            // due until after this pay period". Saying so is the whole point of
            // billing the schedule instead of a fixed per-period figure, and an
            // employer reading the results table has to be able to tell the two
            // apart.
            const nothingDueYet = derivedFromSchedule && remainingBalance > 0;
            return {
              employeeId: row.employeeId,
              status: 'skipped',
              loanId,
              deductionAmount: 0,
              error: nothingDueYet ? 'no_installment_due_this_period' : 'nothing_to_deduct',
            };
          }

          const newBalance = Math.max(0, roundToCents(remainingBalance - deductionAmount));
          const loanFullyRepaid = newBalance === 0;
          const newStatus = loanFullyRepaid ? LOAN_STATUS.REPAID : String(loan['status']);

          // `create`, not `set`: a replay of this row must fail the write
          // rather than record a second deduction.
          tx.create(deductionRef, {
            loanId,
            employeeId: row.employeeId,
            employerId: input.employerId,
            batchId,
            payPeriodStart: input.payPeriodStart,
            payPeriodEnd: input.payPeriodEnd,
            grossSalary: row.grossSalary,
            netSalary: row.netSalary,
            deductionAmount,
            remainingBalanceBefore: remainingBalance,
            remainingBalanceAfter: newBalance,
            createdAt: FieldValue.serverTimestamp(),
          });

          tx.update(loanRef, {
            remainingBalance: newBalance,
            lastDeductionAt: FieldValue.serverTimestamp(),
            lastDeductionAmount: deductionAmount,
            ...(loanFullyRepaid ? {
              status: LOAN_STATUS.REPAID,
              repaidAt: FieldValue.serverTimestamp(),
            } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            employeeId: row.employeeId,
            status: 'deducted',
            loanId,
            deductionAmount,
            newBalance,
            newStatus,
          };
        });

        // Side-effect: notification (non-blocking). Only for a deduction this
        // attempt actually applied — a replayed row must not re-notify.
        if (outcome.status === 'deducted') {
          if (outcome.newStatus === LOAN_STATUS.REPAID) {
            notifyLoanEvent('loan_repaid', { employeeId: row.employeeId, loanId, totalDeducted: outcome.deductionAmount }).catch((err) => logger.warn('notify loan_repaid failed', err));
          } else {
            notifyLoanEvent('payroll_deduction', { employeeId: row.employeeId, loanId, amount: outcome.deductionAmount, remaining: outcome.newBalance }).catch((err) => logger.warn('notify payroll_deduction failed', err));
          }
        }

        results.push(outcome);
      } catch (err) {
        logger.error({ err, employeeId: row.employeeId }, 'Payroll row processing failed');
        results.push({
          employeeId: row.employeeId,
          status: 'error',
          deductionAmount: 0,
          error: (err as Error).message,
        });
      }
    }

    const processedCount = results.filter((r) => r.status === 'deducted').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    const alreadyProcessedCount = results.filter((r) => r.status === 'already_processed').length;
    const errorCount = results.filter((r) => r.status === 'error').length;
    await batchRef.set({
      status: 'completed',
      processedCount,
      skippedCount,
      alreadyProcessedCount,
      errorCount,
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.info({ batchId, processedCount, total: results.length }, 'Payroll batch completed');

    return {
      batchId,
      status: 'completed',
      processedCount,
      errorCount: results.length - processedCount,
      results,
    };
  },
);

