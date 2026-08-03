import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { getRedis } from '../utils/redis';
import { checkRateLimit } from '../utils/rateLimiter';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';
import { buildLoanInstallments, DEFAULT_LOAN_TERM_DAYS } from '../config/loanConfig';
import { calculateNextPayrollDate } from './calculateNextPayrollDate';
import { resolvePayFrequency } from './resolvePayFrequency';

const MarkLoanDisbursedSchema = z.object({
  loanId: z.string().min(1),
  stpTransactionId: z.string().min(1),
  stpClaveRastreo: z.string().min(1),
  disbursedAmount: z.number().positive(),
  disbursedAt: z.string().datetime(),
});

export type MarkLoanDisbursedInput = z.infer<typeof MarkLoanDisbursedSchema>;

export interface MarkLoanDisbursedResult {
  success: boolean;
  loanId: string;
  status: string;
  dueDate: string;
}

export const markLoanDisbursed = onCall(
  { enforceAppCheck: true },
  withAuth<MarkLoanDisbursedInput, MarkLoanDisbursedResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling(
        {
          functionName: 'markLoanDisbursed',
          uid: auth.uid,
          loanId: (data as Record<string, unknown>)['loanId'] as string,
        },
        async () => {
          // Rate limit: 20/min/uid (mutation)
          try {
            const allowed = await checkRateLimit(`rl:markLoanDisbursed:${auth.uid}`, 20, 60);
            if (!allowed) {
              throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
            }
          } catch (e: unknown) {
            if (e instanceof HttpsError) throw e;
            logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
          }

          const parseResult = MarkLoanDisbursedSchema.safeParse(data);
          if (!parseResult.success) {
            throw new HttpsError(
              'invalid-argument',
              parseResult.error.issues[0]?.message ?? 'Invalid input'
            );
          }
          const input = parseResult.data;

          const db = getFirestore();
          const now = Timestamp.now();

          const loanRef = db.collection('loans').doc(input.loanId);
          const loanDoc = await loanRef.get();
          if (!loanDoc.exists) {
            throw new HttpsError('not-found', `Loan ${input.loanId} not found`);
          }

          const loan = loanDoc.data()!;
          if (loan['status'] !== 'approved') {
            throw new HttpsError(
              'failed-precondition',
              `Loan must be in 'approved' status to disburse. Current: ${loan['status']}`
            );
          }

          // The borrower's own pay frequency decides when this is deducted. It
          // used to be read from `loan.borrowerSnapshot`, which nothing writes
          // (#431) — so this always fell through to 'monthly' and scheduled
          // every borrower for month-end, a date that for a weekly- or
          // biweekly-paid employee need not be a payday at all.
          const borrowerSnapshot = loan['borrowerSnapshot'] as Record<string, unknown> | undefined;
          const borrowerUid =
            (loan['userId'] as string | undefined) ?? (loan['employeeId'] as string | undefined);
          const { frequency: payFrequency, source: payFrequencySource } =
            await resolvePayFrequency(borrowerUid, borrowerSnapshot);
          const dueDate = calculateNextPayrollDate(payFrequency);

          if (payFrequencySource === 'default_monthly') {
            logger.warn('Disbursing with an assumed monthly pay frequency', {
              loanId: input.loanId,
              uid: borrowerUid,
              service: 'functions',
            });
          }

          const employerId = loan['employerId'] as string;
          const principalAmount = (loan['principalAmount'] as number | undefined) ?? (loan['amount'] as number);

          // Moving the due date without moving the schedule with it is exactly
          // the bug (#437): `repaymentSchedule` and the SoftCrédito deduction
          // would keep pointing at the request-time date while `loan.dueDate`
          // moved to the payroll-aligned one. Rebuilt from the same helper
          // requestLoan used (#424) so there is still one schedule, not two.
          const total = (loan['total'] as number | undefined) ?? principalAmount;
          const term = (loan['term'] as number | undefined) ?? DEFAULT_LOAN_TERM_DAYS;
          const oldDueDate = loan['dueDate'] as Timestamp | undefined;
          const installments = buildLoanInstallments(total, dueDate.toDate(), term);

          const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();

          await db.runTransaction(async (txn) => {
            txn.update(loanRef, {
              status: 'disbursed',
              stpTransactionId: input.stpTransactionId,
              stpClaveRastreo: input.stpClaveRastreo,
              disbursedAt: Timestamp.fromDate(new Date(input.disbursedAt)),
              dueDate,
              repaymentSchedule: installments.map((i) => ({
                number: i.number,
                amount: i.amount,
                dueDate: Timestamp.fromDate(i.dueDate),
              })),
              updatedAt: now,
              statusHistory: FieldValue.arrayUnion({
                from: 'approved',
                to: 'disbursed',
                at: now,
                by: auth.uid,
                reason: `STP disbursement confirmed. TxID: ${input.stpTransactionId}`,
              }),
            });

            txn.update(db.collection('employers').doc(employerId), {
              currentOutstandingBalance: FieldValue.increment(principalAmount),
              updatedAt: now,
            });

            txn.set(
              logRef,
              buildAuditLogDocument(
                {
                  action: 'loan.disbursed',
                  actorUid: auth.uid,
                  actorRole: auth.role,
                  actorEmail: auth.email ?? null,
                  targetId: input.loanId,
                  before: { status: 'approved' },
                  after: { status: 'disbursed' },
                  meta: {
                    entityType: 'loan',
                    stpTransactionId: input.stpTransactionId,
                    disbursedAmount: input.disbursedAmount,
                    // #437: the due date moved from the request-time quote to
                    // the borrower's actual payroll date at disbursement.
                    dueDateRealigned: {
                      from: oldDueDate ? oldDueDate.toDate().toISOString() : null,
                      to: dueDate.toDate().toISOString(),
                      payFrequency,
                    },
                  },
                },
                now
              )
            );
          });

          // #437 DELIBERATELY NOT DONE HERE: re-registering the payroll
          // deduction at the new date. `onLoanApproved` already registered one
          // at approval (`onLoanApproved.ts:139`), and the adapter exposes
          // exactly one deduction route — POST /internal/register-deduction
          // (a create) — with no cancel, update or replace. Calling it again
          // would leave a SECOND live deduction at SoftCrédito on the old date
          // and overwrite `softcreditoDeductionId`, losing the handle to the
          // first. The borrower would be collected twice: strictly worse than
          // the inconsistency this change fixes.
          //
          // Realigning the deduction needs a cancel/replace capability from the
          // vendor that does not exist yet. Until it does, the schedule and the
          // audit trail below are the record of the move, and the registered
          // deduction is knowingly still on the request-time date. Do not
          // "complete" this by adding a second register call.

          try {
          const redis = getRedis();
          await redis.lpush(
              'jobs:notifications',
              JSON.stringify({
                type: 'loan_disbursed',
                userId: (loan['userId'] as string | undefined) ?? (loan['employeeId'] as string),
                loanId: input.loanId,
                amount: input.disbursedAmount,
                dueDate: dueDate.toDate().toISOString(),
              })
            );
          } catch (e: unknown) {
            logger.warn('Redis notification push failed (non-critical)', { error: (e as Error).message, service: 'functions' });
          }

          return {
            success: true,
            loanId: input.loanId,
            status: 'disbursed',
            dueDate: dueDate.toDate().toISOString(),
          };
        }
      )
  )
);
