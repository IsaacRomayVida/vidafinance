import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { getRedis } from '../utils/redis';
import { enforceRateLimit } from '../utils/rateLimiter';
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
          // Rate limit: 20/min/uid (mutation). Fail closed: this records a real
          // STP disbursement and moves loan/employer balances — a limiter
          // outage must not lift the only brake on it.
          await enforceRateLimit(`rl:markLoanDisbursed:${auth.uid}`, 20, 60, {
            onUnavailable: 'closed',
            context: 'markLoanDisbursed',
          });

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

          const employerId = loan['employerId'] as string;
          const principalAmount = (loan['principalAmount'] as number | undefined) ?? (loan['amount'] as number);
          const persistedDueDate = loan['dueDate'] as Timestamp | undefined;
          const borrowerSnapshot = loan['borrowerSnapshot'] as Record<string, unknown> | undefined;
          const borrowerUid =
            (loan['userId'] as string | undefined) ?? (loan['employeeId'] as string | undefined);

          // DISBURSEMENT NO LONGER DECIDES THE DUE DATE (#437).
          //
          // It used to: it recomputed the borrower's next payroll date here and
          // overwrote `loan.dueDate` with it. That second answer came from a
          // different rule than the one the borrower was quoted, signed and was
          // disclosed a CAT against, and it could land EARLIER — same fee, less
          // time, an understated CAT. Rebuilding the schedule alongside it
          // (361b09c) made the loan internally consistent but could not undo a
          // disclosure that had already been made.
          //
          // requestLoan now resolves a payroll-aligned date once, at creation,
          // and freezes the cadence it used onto `borrowerSnapshot.payFrequency`.
          // A loan carrying that field has a due date that is already the answer
          // this function would compute, so there is nothing to realign and this
          // path deliberately writes neither `dueDate` nor `repaymentSchedule`.
          //
          // Loans created BEFORE that change carry no persisted cadence, and
          // they keep the old behaviour exactly — including the realignment.
          // They are in flight: an ops user has approved them, the borrower has
          // been told a collection date, and the SoftCrédito deduction is
          // already registered. Silently switching a live loan onto the new rule
          // would move a real borrower's collection date after the fact, which
          // is a worse thing to do than let a known-imperfect path finish. The
          // branch disappears on its own once the last pre-change loan settles.
          const dueDateResolvedAtRequest =
            typeof borrowerSnapshot?.['payFrequency'] === 'string' && persistedDueDate !== undefined;

          const loanUpdate: Record<string, unknown> = {
            status: 'disbursed',
            stpTransactionId: input.stpTransactionId,
            stpClaveRastreo: input.stpClaveRastreo,
            disbursedAt: Timestamp.fromDate(new Date(input.disbursedAt)),
            updatedAt: now,
            statusHistory: FieldValue.arrayUnion({
              from: 'approved',
              to: 'disbursed',
              at: now,
              by: auth.uid,
              reason: `STP disbursement confirmed. TxID: ${input.stpTransactionId}`,
            }),
          };

          const auditMeta: Record<string, unknown> = {
            entityType: 'loan',
            stpTransactionId: input.stpTransactionId,
            disbursedAmount: input.disbursedAmount,
          };

          let dueDate: Timestamp;

          if (dueDateResolvedAtRequest) {
            dueDate = persistedDueDate;
          } else {
            // ── Legacy path: loans created before the due date was resolved at
            // request time. Unchanged behaviour, kept whole. ──────────────────
            const { frequency: payFrequency, source: payFrequencySource } =
              await resolvePayFrequency(borrowerUid, borrowerSnapshot);
            dueDate = calculateNextPayrollDate(payFrequency);

            if (payFrequencySource === 'default_monthly') {
              logger.warn('Disbursing with an assumed monthly pay frequency', {
                loanId: input.loanId,
                uid: borrowerUid,
                service: 'functions',
              });
            }

            // Moving the due date without moving the schedule with it is the
            // other half of the bug (#437): `repaymentSchedule` would keep
            // pointing at the request-time date while `loan.dueDate` moved to
            // the payroll-aligned one. Rebuilt from the same helper requestLoan
            // uses (#424) so there is still one schedule, not two.
            const total = (loan['total'] as number | undefined) ?? principalAmount;
            const term = (loan['term'] as number | undefined) ?? DEFAULT_LOAN_TERM_DAYS;
            const installments = buildLoanInstallments(total, dueDate.toDate(), term);

            loanUpdate['dueDate'] = dueDate;
            loanUpdate['repaymentSchedule'] = installments.map((i) => ({
              number: i.number,
              amount: i.amount,
              dueDate: Timestamp.fromDate(i.dueDate),
            }));

            // Only recorded when a move actually happened. On the current path
            // there is no realignment to audit, and logging a from === to entry
            // would read as one.
            auditMeta['dueDateRealigned'] = {
              from: persistedDueDate ? persistedDueDate.toDate().toISOString() : null,
              to: dueDate.toDate().toISOString(),
              payFrequency,
            };
          }

          const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();

          await db.runTransaction(async (txn) => {
            txn.update(loanRef, loanUpdate);

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
                  meta: auditMeta,
                },
                now
              )
            );
          });

          // #437 DELIBERATELY NOT DONE HERE: re-registering the payroll
          // deduction. `onLoanApproved` already registered one at approval
          // (`onLoanApproved.ts:139`), and the adapter exposes exactly one
          // deduction route — POST /internal/register-deduction (a create) —
          // with no cancel, update or replace. Calling it again would leave a
          // SECOND live deduction at SoftCrédito on the old date and overwrite
          // `softcreditoDeductionId`, losing the handle to the first. The
          // borrower would be collected twice: strictly worse than any
          // inconsistency it would repair.
          //
          // On the current path this is no longer a compromise. The deduction
          // was registered at approval against `loan.dueDate`, and that date is
          // the final one, so there is nothing to correct. Only the legacy
          // branch above still moves a date out from under a deduction that is
          // already registered, and it is knowingly left on the request-time
          // date there. Realigning it would need a cancel/replace capability
          // from the vendor that does not exist. Do not "complete" this by
          // adding a second register call.

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
