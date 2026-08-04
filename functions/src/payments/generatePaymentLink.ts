import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import fetch from 'node-fetch';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';
import { DISBURSED_STATUSES, LOAN_STATUS } from '../loans/loanStatus';

// A loan is repayable from "funds sent" (`DISBURSED_STATUSES`: 'active' —
// auto-disbursed, 'disbursed' — manually ops-confirmed) through 'overdue'.
// Deliberately excludes `approved` (pre-disbursement — nothing to repay yet)
// and every post-repayment/write-off status (`REPAID_STATUSES`,
// 'in_collections', 'written_off') via allow-list, not a separate deny check.
const REPAYABLE_STATUSES: readonly string[] = [...DISBURSED_STATUSES, LOAN_STATUS.OVERDUE];

const GeneratePaymentLinkSchema = z.object({
  loanId: z.string().min(1),
});

export type GeneratePaymentLinkInput = z.infer<typeof GeneratePaymentLinkSchema>;

export interface GeneratePaymentLinkResult {
  paymentUrl: string;
  orderId: string;
  expiresIn: string;
}

export const generatePaymentLink = onCall(
  { enforceAppCheck: true },
  withAuth<GeneratePaymentLinkInput, GeneratePaymentLinkResult>(
    ['employee'],
    async (data, auth) =>
      withErrorHandling(
        {
          functionName: 'generatePaymentLink',
          uid: auth.uid,
          loanId: (data as Record<string, unknown>)['loanId'] as string,
        },
        async () => {
          // Rate limit: 20/min/uid (mutation — creates payment link, hits external payment server).
          // Fail closed: a limiter outage must not lift the only brake on
          // spamming the paid payment-server checkout endpoint.
          await enforceRateLimit(`rl:generatePaymentLink:${auth.uid}`, 20, 60, {
            onUnavailable: 'closed',
            context: 'generatePaymentLink',
          });

          const parseResult = GeneratePaymentLinkSchema.safeParse(data);
          if (!parseResult.success) {
            throw new HttpsError(
              'invalid-argument',
              parseResult.error.issues[0]?.message ?? 'Invalid input'
            );
          }
          const input = parseResult.data;

          const db = getFirestore();
          const loanDoc = await db.collection('loans').doc(input.loanId).get();
          if (!loanDoc.exists) {
            throw new HttpsError('not-found', 'Loan not found');
          }

          const loan = loanDoc.data()!;
          const loanUserId = (loan['userId'] as string | undefined) ?? (loan['employeeId'] as string);

          if (loanUserId !== auth.uid) {
            throw new HttpsError('permission-denied', 'Not your loan');
          }

          if (!REPAYABLE_STATUSES.includes(loan['status'] as string)) {
            throw new HttpsError(
              'failed-precondition',
              'Loan is not eligible for repayment'
            );
          }

          const paymentServerUrl = process.env['PAYMENT_SERVER_URL'];
          if (!paymentServerUrl) {
            throw new HttpsError('internal', 'Payment server not configured');
          }

          const internalSecret = process.env['INTERNAL_SECRET'] ?? process.env['INTERNAL_API_SECRET'] ?? '';

          const employeeId = loanUserId;
          const employeeName =
            (loan['borrowerSnapshot'] as Record<string, unknown> | undefined)?.['fullName'] ??
            (loan['employeeName'] as string | undefined) ??
            '';
          // Charge what the borrower actually owes RIGHT NOW, never a stale
          // whole-loan figure. This function is now reachable while a loan is
          // 'active'/'disbursed'/'overdue' — statuses the payroll-deduction
          // pipeline (processPayroll.ts) actively writes to, decrementing
          // `remainingBalance` on every deduction. Charging `total` (principal
          // + fee, written once at requestLoan time, index.ts:~769) once any
          // deduction has landed would bill the borrower again for money
          // already collected. `remainingBalance` is only ever absent before
          // the first payroll deduction touches the loan, in which case the
          // full `total` is still owed. Never `loan.amount` (bare principal —
          // the defect that was already fixed once). Fails closed on a
          // corrupt/missing/non-positive value for whichever field is in play
          // rather than falling back to a smaller number and silently
          // undercharging.
          const rawRemainingBalance = loan['remainingBalance'];
          const hasRemainingBalance = rawRemainingBalance !== undefined && rawRemainingBalance !== null;

          let amount: number;
          if (hasRemainingBalance) {
            if (
              typeof rawRemainingBalance !== 'number' ||
              !Number.isFinite(rawRemainingBalance) ||
              rawRemainingBalance <= 0
            ) {
              throw new HttpsError(
                'internal',
                `Loan ${input.loanId} has no valid remainingBalance to charge (remainingBalance=${JSON.stringify(rawRemainingBalance)})`
              );
            }
            amount = rawRemainingBalance;
          } else {
            const total = loan['total'];
            if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
              throw new HttpsError(
                'internal',
                `Loan ${input.loanId} has no valid total to charge (total=${JSON.stringify(total)})`
              );
            }
            amount = total;
          }
          const concept = `Pago préstamo ${input.loanId}`;

          const response = await fetch(`${paymentServerUrl}/create-checkout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-secret': internalSecret,
            },
            body: JSON.stringify({
              loanId: input.loanId,
              amount,
              employeeId,
              employeeName,
              concept,
            }),
          });

          if (!response.ok) {
            const errBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            const errMsg = (errBody['message'] as string | undefined) ?? `Payment server error: ${response.status}`;
            throw new HttpsError('internal', errMsg);
          }

          const { paymentUrl, orderId } = (await response.json()) as {
            paymentUrl: string;
            orderId: string;
          };

          if (!paymentUrl || !orderId) {
            throw new HttpsError('internal', 'Invalid response from payment server');
          }

          await db.collection('loans').doc(input.loanId).update({
            conektaOrderId: orderId,
            paymentLinkUrl: paymentUrl,
            updatedAt: Timestamp.now(),
          });

          return { paymentUrl, orderId, expiresIn: '24 hours' };
        }
      )
  )
);
