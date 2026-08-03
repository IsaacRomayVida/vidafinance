import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notifyLoanEvent } from '../utils/notify';
import { checkRateLimit } from '../utils/rateLimiter';
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

const ProcessPayrollSchema = z.object({
  employerId: z.string().min(1),
  payPeriodStart: z.string(), // YYYY-MM-DD
  payPeriodEnd: z.string(),   // YYYY-MM-DD
  rows: z.array(DeductionRowSchema).min(1).max(10000),
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

// ─── Helper: resolve expected deduction for a loan in this pay period ──────

function calcExpectedDeduction(
  remainingBalance: number,
  monthlyPayment: number,
  payPeriodsPerMonth: number,
): number {
  const perPeriod = Math.ceil(monthlyPayment / payPeriodsPerMonth);
  return Math.min(perPeriod, remainingBalance);
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

    // Rate limit: 10/min/uid (expensive batch operation, up to 10k rows)
    try {
      const allowed = await checkRateLimit(`rl:processPayroll:${request.auth.uid}`, 10, 60);
      if (!allowed) {
        throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
      }
    } catch (e: unknown) {
      if (e instanceof HttpsError) throw e;
      logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
    }

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
          const monthlyPayment = Number(loan['monthlyPayment'] ?? loan['total'] ?? 0);
          const payPeriodsPerMonth = Number(loan['payPeriodsPerMonth'] ?? 2); // default bi-weekly

          const requestedAmount = row.deductionAmount ?? calcExpectedDeduction(
            remainingBalance,
            monthlyPayment,
            payPeriodsPerMonth,
          );

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
            return {
              employeeId: row.employeeId,
              status: 'skipped',
              loanId,
              deductionAmount: 0,
              error: 'nothing_to_deduct',
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

