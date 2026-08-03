import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import fetch from 'node-fetch';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { checkRateLimit } from '../utils/rateLimiter';

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
          // Rate limit: 20/min/uid (mutation — creates payment link, hits external payment server)
          try {
            const allowed = await checkRateLimit(`rl:generatePaymentLink:${auth.uid}`, 20, 60);
            if (!allowed) {
              throw new HttpsError('resource-exhausted', 'Rate limit exceeded, please retry in a minute');
            }
          } catch (e: unknown) {
            if (e instanceof HttpsError) throw e;
            logger.warn('Rate limiter unavailable', { error: (e as Error).message, service: 'functions' });
          }

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

          if (loan['status'] !== 'approved') {
            throw new HttpsError(
              'failed-precondition',
              'Loan must be approved to generate payment link'
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
          // Charge what the borrower actually owes — principal + fee (`loan.total`,
          // written once at requestLoan time, index.ts:~769) — never `loan.amount`
          // (bare principal) or `loan.principalAmount` (a field nothing ever writes).
          // A loan only reaches this function while `status === 'approved'`, a state
          // the payroll-deduction pipeline (processPayroll.ts, gated to
          // 'active'/'disbursed') never touches, so there is no partial-repayment
          // balance to reconcile against here: `total` is the whole, current
          // obligation. Fails closed on a corrupt/missing total (same convention as
          // the fee-rate read in index.ts's getLoanConfigValues) rather than falling
          // back to a smaller number and silently undercharging.
          const total = loan['total'];
          if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
            throw new HttpsError(
              'internal',
              `Loan ${input.loanId} has no valid total to charge (total=${JSON.stringify(total)})`
            );
          }
          const amount = total;
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
