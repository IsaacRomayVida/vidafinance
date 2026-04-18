import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { getRedis } from '../utils/redis';
import { checkRateLimit } from '../utils/rateLimiter';
import { calculateNextPayrollDate } from './calculateNextPayrollDate';

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

          const borrowerSnapshot = loan['borrowerSnapshot'] as Record<string, unknown> | undefined;
          const payFrequency = (borrowerSnapshot?.['payFrequency'] as string | undefined) ?? 'monthly';
          const dueDate = calculateNextPayrollDate(payFrequency);

          const employerId = loan['employerId'] as string;
          const principalAmount = (loan['principalAmount'] as number | undefined) ?? (loan['amount'] as number);

          const logRef = db.collection('auditLogs').doc();

          await db.runTransaction(async (txn) => {
            txn.update(loanRef, {
              status: 'disbursed',
              stpTransactionId: input.stpTransactionId,
              stpClaveRastreo: input.stpClaveRastreo,
              disbursedAt: Timestamp.fromDate(new Date(input.disbursedAt)),
              dueDate,
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

            txn.set(logRef, {
              action: 'loan.disbursed',
              entityType: 'loan',
              entityId: input.loanId,
              performedBy: auth.uid,
              timestamp: now,
              metadata: {
                stpTransactionId: input.stpTransactionId,
                disbursedAmount: input.disbursedAmount,
              },
            });
          });

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
