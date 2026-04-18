import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notifyLoanEvent } from '../utils/notify';
import { checkRateLimit } from '../utils/rateLimiter';

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

// ─── Helper: resolve expected deduction for a loan in this pay period ──────

function calcExpectedDeduction(
  remainingBalance: number,
  monthlyPayment: number,
  payPeriodsPerMonth: number,
): number {
  const perPeriod = Math.ceil(monthlyPayment / payPeriodsPerMonth);
  return Math.min(perPeriod, remainingBalance);
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

    // Verify the caller actually belongs to the employer
    if (claims['role'] === 'employer_admin' && claims['employerId'] !== input.employerId) {
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

    const results: Array<{
      employeeId: string;
      loanId?: string;
      deductionAmount: number;
      newBalance?: number;
      newStatus?: string;
      error?: string;
    }> = [];

    for (const row of input.rows) {
      try {
        // Find the active loan for this employee
        const loanSnap = await db.collection('loans')
          .where('employeeId', '==', row.employeeId)
          .where('employerId', '==', input.employerId)
          .where('status', 'in', ['active', 'disbursed'])
          .limit(1)
          .get();

        if (loanSnap.empty) {
          results.push({
            employeeId: row.employeeId,
            deductionAmount: 0,
            error: 'no_active_loan',
          });
          continue;
        }

        const loanDoc = loanSnap.docs[0];
        const loan = loanDoc.data();
        const loanId = loanDoc.id;
        const remainingBalance = Number(loan['remainingBalance'] ?? loan['total'] ?? 0);
        const monthlyPayment = Number(loan['monthlyPayment'] ?? loan['total'] ?? 0);
        const payPeriodsPerMonth = Number(loan['payPeriodsPerMonth'] ?? 2); // default bi-weekly

        const deductionAmount = row.deductionAmount ?? calcExpectedDeduction(
          remainingBalance,
          monthlyPayment,
          payPeriodsPerMonth,
        );

        if (deductionAmount <= 0) {
          results.push({
            employeeId: row.employeeId,
            loanId,
            deductionAmount: 0,
            error: 'nothing_to_deduct',
          });
          continue;
        }

        const newBalance = Math.max(0, remainingBalance - deductionAmount);
        const loanFullyRepaid = newBalance === 0;
        const newStatus = loanFullyRepaid ? 'repaid' : loan['status'];

        // Transactional write: deduction record + loan update
        await db.runTransaction(async (tx) => {
          tx.set(db.collection('payrollDeductions').doc(), {
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

          tx.update(loanDoc.ref, {
            remainingBalance: newBalance,
            lastDeductionAt: FieldValue.serverTimestamp(),
            lastDeductionAmount: deductionAmount,
            ...(loanFullyRepaid ? {
              status: 'repaid',
              repaidAt: FieldValue.serverTimestamp(),
            } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });

        // Side-effect: notification (non-blocking)
        if (loanFullyRepaid) {
          notifyLoanEvent('loan_repaid', { employeeId: row.employeeId, loanId, totalDeducted: remainingBalance }).catch((err) => logger.warn('notify loan_repaid failed', err));
        } else {
          notifyLoanEvent('payroll_deduction', { employeeId: row.employeeId, loanId, amount: deductionAmount, remaining: newBalance }).catch((err) => logger.warn('notify payroll_deduction failed', err));
        }

        results.push({
          employeeId: row.employeeId,
          loanId,
          deductionAmount,
          newBalance,
          newStatus,
        });
      } catch (err) {
        logger.error({ err, employeeId: row.employeeId }, 'Payroll row processing failed');
        results.push({
          employeeId: row.employeeId,
          deductionAmount: 0,
          error: (err as Error).message,
        });
      }
    }

    const processedCount = results.filter((r) => !r.error).length;
    await batchRef.set({
      status: 'completed',
      processedCount,
      errorCount: results.length - processedCount,
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

