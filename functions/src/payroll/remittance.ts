import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';

/**
 * Payroll remittance record (AUDIT_EMPLOYER_PATH.md E18).
 *
 * `processPayroll` reduces loan balances on the employer's word that the money
 * was withheld; nothing recorded whether the employer then actually transferred
 * it to Funpay. One `payrollRemittances/{batchId}` document per payroll batch
 * closes that loop:
 *
 *  - `expectedCents` is written by `processPayroll` (server only), summed from
 *    the batch's own `payrollDeductions` rows — not from the attempt's results,
 *    so an interrupted batch that is retried with a partial CSV still expects
 *    every peso the batch actually deducted.
 *  - `receivedCents` / `receipts[]` are written only by `recordPayrollRemittance`,
 *    an ops/admin callable. The employer cannot self-assert a remittance: the
 *    point of the record is that someone other than the employer saw the money
 *    arrive at the bank.
 *  - `status` is derived from the two figures here and nowhere else.
 *
 * Money is integer centavos throughout this document. The deduction ledger
 * stores pesos rounded to cents, and a float sum of many of those drifts; a
 * reconciliation that reads "partial" because of 0.0000001 is worse than none.
 */
export const PAYROLL_REMITTANCES_COLLECTION = 'payrollRemittances';

export type RemittanceStatus = 'expected' | 'partial' | 'received' | 'overpaid';

/** Pesos (rounded to centavos, as the deduction ledger stores them) → integer centavos. */
export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}

export function remittanceStatus(expectedCents: number, receivedCents: number): RemittanceStatus {
  if (receivedCents <= 0) return 'expected';
  if (receivedCents < expectedCents) return 'partial';
  if (receivedCents === expectedCents) return 'received';
  return 'overpaid';
}

/**
 * Write (or refresh) the expected side of a batch's remittance record.
 *
 * Called by `processPayroll` after the last row and BEFORE the batch is marked
 * `completed`, so a completed batch always has its record: if this throws, the
 * batch stays `in_progress`, and the natural retry (whose rows are idempotent)
 * rewrites it.
 *
 * The deduction sum is read inside the transaction so it is consistent with the
 * remittance document it is written against, and a receipt ops recorded
 * against a retried batch is preserved — only `expectedCents` and the derived
 * `status` move. A batch that deducted nothing gets no record: there is nothing
 * to remit, and an empty "received" record would read as a reconciled one.
 */
export async function recordExpectedRemittance(
  db: Firestore,
  batch: { batchId: string; employerId: string; payPeriodStart: string; payPeriodEnd: string },
): Promise<{ expectedCents: number; status: RemittanceStatus } | null> {
  const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(batch.batchId);
  const deductionsQuery = db.collection('payrollDeductions').where('batchId', '==', batch.batchId);

  return db.runTransaction(async (tx) => {
    const deductions = await tx.get(deductionsQuery);
    const remittanceSnap = await tx.get(remittanceRef);

    const expectedCents = deductions.docs.reduce(
      (sum, d) => sum + pesosToCents(Number(d.data()['deductionAmount'] ?? 0)),
      0,
    );
    if (expectedCents <= 0 && !remittanceSnap.exists) return null;

    const receivedCents = Number(remittanceSnap.data()?.['receivedCents'] ?? 0);
    const status = remittanceStatus(expectedCents, receivedCents);

    tx.set(remittanceRef, {
      batchId: batch.batchId,
      employerId: batch.employerId,
      payPeriodStart: batch.payPeriodStart,
      payPeriodEnd: batch.payPeriodEnd,
      expectedCents,
      deductionCount: deductions.size,
      receivedCents,
      status,
      ...(remittanceSnap.exists ? {} : { receipts: [], createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return { expectedCents, status };
  });
}

// ─── Ops: record a received remittance ───────────────────────────────────────

const RecordPayrollRemittanceSchema = z.object({
  batchId: z.string().min(1).max(200),
  amountCents: z.number().int().positive(),
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date'),
  bankReference: z.string().trim().min(1).max(100),
});

export type RecordPayrollRemittanceInput = z.infer<typeof RecordPayrollRemittanceSchema>;

export interface RecordPayrollRemittanceResult {
  batchId: string;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
}

export const recordPayrollRemittance = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  withAuth<RecordPayrollRemittanceInput, RecordPayrollRemittanceResult>(
    ['ops', 'admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling(
        { functionName: 'recordPayrollRemittance', uid: auth.uid },
        async () => {
          await enforceRateLimit(`rl:recordPayrollRemittance:${auth.uid}`, 20, 60, {
            onUnavailable: 'closed',
            context: 'recordPayrollRemittance',
          });

          const parsed = RecordPayrollRemittanceSchema.safeParse(data);
          if (!parsed.success) {
            throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid input');
          }
          const input = parsed.data;

          const db = getFirestore();
          const now = Timestamp.now();
          const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(input.batchId);
          const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();

          const result = await db.runTransaction(async (tx): Promise<RecordPayrollRemittanceResult> => {
            const snap = await tx.get(remittanceRef);
            if (!snap.exists) {
              // Only processPayroll creates these: a receipt against a batch
              // that deducted nothing (or does not exist) is a typo, not money.
              throw new HttpsError('not-found', `No remittance expected for batch ${input.batchId}`);
            }
            const current = snap.data() ?? {};
            const receipts = Array.isArray(current['receipts'])
              ? (current['receipts'] as Array<Record<string, unknown>>)
              : [];

            // One bank transfer is one receipt. Without this an ops
            // double-submit (or a client retry after a timed-out response)
            // counts the same SPEI transfer twice and reads as reconciled.
            if (receipts.some((r) => r['bankReference'] === input.bankReference)) {
              throw new HttpsError(
                'already-exists',
                `Bank reference ${input.bankReference} is already recorded for batch ${input.batchId}`,
              );
            }

            const expectedCents = Number(current['expectedCents'] ?? 0);
            const priorReceivedCents = Number(current['receivedCents'] ?? 0);
            const receivedCents = priorReceivedCents + input.amountCents;
            const status = remittanceStatus(expectedCents, receivedCents);

            tx.update(remittanceRef, {
              receivedCents,
              status,
              receipts: FieldValue.arrayUnion({
                amountCents: input.amountCents,
                receivedOn: input.receivedOn,
                bankReference: input.bankReference,
                recordedBy: auth.uid,
                recordedAt: now,
              }),
              lastReceivedOn: input.receivedOn,
              updatedAt: now,
            });

            tx.set(logRef, buildAuditLogDocument({
              action: 'payrollRemittances.received',
              actorUid: auth.uid,
              actorRole: auth.role,
              actorEmail: auth.email ?? null,
              targetId: input.batchId,
              before: { receivedCents: priorReceivedCents, status: current['status'] ?? null },
              after: { receivedCents, status },
              meta: {
                employerId: current['employerId'] ?? null,
                amountCents: input.amountCents,
                receivedOn: input.receivedOn,
                bankReference: input.bankReference,
              },
            }, now));

            return { batchId: input.batchId, expectedCents, receivedCents, status };
          });

          logger.info({ batchId: input.batchId, status: result.status }, 'Payroll remittance recorded');
          return result;
        },
      ),
  ),
);
