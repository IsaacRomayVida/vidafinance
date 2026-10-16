import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { enforceRateLimit } from '../utils/rateLimiter';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';
import {
  DEFAULT_REMITTANCE_GRACE_DAYS,
  INCIDENT_LOG_COLLECTION,
  OUTSTANDING_REMITTANCE_STATUSES,
  OVERDUE_ALERT_EPOCH_FIELD,
  PAYROLL_BATCHES_COLLECTION,
  PAYROLL_REMITTANCES_COLLECTION,
  PAYROLL_REMITTANCE_REFERENCES_COLLECTION,
  bankReferenceDocId,
  batchFromBatchDoc,
  calendarDaysBefore,
  expectedRemittanceFields,
  isRealCalendarDate,
  isVoided,
  lastReceivedOnOf,
  nextOverdueAlertEpoch,
  normalizeBankReference,
  overdueAlertEpochOf,
  readExpectedInTx,
  receiptIdOf,
  receiptReferenceKey,
  receiptsOf,
  receivedCentsOf,
  remittanceAging,
  remittanceAlertDocIds,
  remittanceStatus,
  remittancesQuery,
  resolvedAlertFields,
  remittancesQueryDirection,
  todayInMexicoCity,
  upsertExpectedRemittance,
  type RemittanceAging,
  type RemittanceBatch,
  type RemittancePosition,
  type RemittanceStatus,
  type StoredReceipt,
} from './remittanceLedger';

export {
  PAYROLL_REMITTANCES_COLLECTION,
  PAYROLL_REMITTANCE_REFERENCES_COLLECTION,
  pesosToCents,
  remittanceStatus,
  remittanceAging,
  normalizeBankReference,
  isRealCalendarDate,
  todayInMexicoCity,
} from './remittanceLedger';
export type { RemittanceStatus, RemittanceAging } from './remittanceLedger';

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
 *  - `receivedCents` / `receipts[]` are written only by `recordPayrollRemittance`
 *    and `voidPayrollRemittanceReceipt`, ops/admin callables. The employer
 *    cannot self-assert a remittance: the point of the record is that someone
 *    other than the employer saw the money arrive at the bank.
 *  - `status` is derived from the two figures here and nowhere else.
 *
 * Money is integer centavos throughout this document. The deduction ledger
 * stores pesos rounded to cents, and a float sum of many of those drifts; a
 * reconciliation that reads "partial" because of 0.0000001 is worse than none.
 *
 * The arithmetic and the document shape live in `remittanceLedger.ts`, shared
 * with the backfill script. Callable contracts: docs/runbooks/payroll-remittances.md.
 */

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
  batch: RemittanceBatch,
): Promise<{ expectedCents: number; status: RemittanceStatus } | null> {
  const written = await upsertExpectedRemittance(db, batch, () => FieldValue.serverTimestamp());
  return written && { expectedCents: written.expectedCents, status: written.status };
}

const OPS_ROLES = ['ops', 'admin', 'super_admin'] as const;

// ─── Refusals the UI can translate ───────────────────────────────────────────

/**
 * Every refusal these callables throw carries `details.reason`, a stable
 * machine-readable code. The `message` is English and for logs; the ops UI
 * shows its own Spanish text keyed on the reason. Codes are a contract
 * (docs/runbooks/payroll-remittances.md): add new ones, never rename.
 */
export type RemittanceRefusalReason =
  // already-exists
  | 'bank-reference-in-batch'
  | 'bank-reference-in-other-batch'
  // invalid-argument
  | 'input-invalid'
  | 'batch-id-invalid'
  | 'amount-invalid'
  | 'received-on-invalid-format'
  | 'received-on-not-a-date'
  | 'received-on-future'
  | 'received-on-before-pay-period'
  | 'bank-reference-invalid'
  | 'shared-transfer-invalid'
  | 'receipt-id-invalid'
  | 'void-reason-invalid'
  | 'view-invalid'
  | 'employer-id-invalid'
  | 'overdue-only-invalid'
  | 'grace-days-invalid'
  | 'limit-invalid'
  | 'cursor-invalid'
  // not-found
  | 'remittance-not-expected'
  | 'remittance-not-found'
  | 'receipt-not-found';

function refusal(
  code: 'invalid-argument' | 'not-found' | 'already-exists',
  reason: RemittanceRefusalReason,
  message: string,
  extra: Record<string, unknown> = {},
): HttpsError {
  return new HttpsError(code, message, { reason, ...extra });
}

type SchemaIssue = { path: PropertyKey[]; code?: string; message: string };

/**
 * A failed schema parse → `invalid-argument` with the reason for the first
 * field that failed. `reasons` maps a top-level field to its code (or to a
 * function of the issue, where one field can fail in more than one way).
 */
function schemaRefusal(
  issues: SchemaIssue[],
  reasons: Record<string, RemittanceRefusalReason | ((issue: SchemaIssue) => RemittanceRefusalReason)>,
): HttpsError {
  const issue = issues[0];
  const first = issue?.path[0];
  const field = typeof first === 'string' ? first : null;
  const mapped = field === null ? undefined : reasons[field];
  const reason = typeof mapped === 'function' && issue ? mapped(issue) : typeof mapped === 'string' ? mapped : 'input-invalid';
  return refusal('invalid-argument', reason, issue?.message ?? 'Invalid input', field === null ? {} : { field });
}

type ReferenceHolder = { batchId: string; receiptId: string; employerId: string | null };

function holdersOf(indexDoc: Record<string, unknown> | undefined): ReferenceHolder[] {
  const holders = indexDoc?.['holders'];
  return Array.isArray(holders) ? (holders as ReferenceHolder[]) : [];
}

// ─── Ops: record a received remittance ───────────────────────────────────────

const RecordPayrollRemittanceSchema = z.object({
  batchId: z.string().min(1).max(200),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  receivedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')
    .refine(isRealCalendarDate, 'receivedOn is not a real calendar date'),
  bankReference: z.string().trim().min(1).max(100),
  /**
   * Ops' explicit acknowledgement that this one bank transfer pays more than
   * one batch. Without it a reference already booked against another batch is
   * refused as a duplicate.
   */
  sharedTransfer: z.boolean().optional(),
});

export type RecordPayrollRemittanceInput = z.infer<typeof RecordPayrollRemittanceSchema>;

export interface RecordPayrollRemittanceResult {
  batchId: string;
  receiptId: string;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
  /** True when the batch predates the ledger and its record was created by this call. */
  createdRecord: boolean;
}

export const recordPayrollRemittance = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  withAuth<RecordPayrollRemittanceInput, RecordPayrollRemittanceResult>(
    [...OPS_ROLES],
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
            throw schemaRefusal(parsed.error.issues, {
              batchId: 'batch-id-invalid',
              amountCents: 'amount-invalid',
              // The refinement (a day that does not exist) reports as `custom`;
              // anything else is the wrong shape.
              receivedOn: (issue) => (issue.code === 'custom' ? 'received-on-not-a-date' : 'received-on-invalid-format'),
              bankReference: 'bank-reference-invalid',
              sharedTransfer: 'shared-transfer-invalid',
            });
          }
          const input = parsed.data;

          // Money that has not arrived cannot have been received. Compared as
          // strings: both sides are zero-padded YYYY-MM-DD.
          const today = todayInMexicoCity(new Date(Date.now()));
          if (input.receivedOn > today) {
            throw refusal(
              'invalid-argument',
              'received-on-future',
              `receivedOn ${input.receivedOn} is in the future (today is ${today} in Mexico City)`,
              { field: 'receivedOn', today },
            );
          }

          const bankReferenceKey = normalizeBankReference(input.bankReference);

          const db = getFirestore();
          const now = Timestamp.now();
          const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(input.batchId);
          const referenceRef = db
            .collection(PAYROLL_REMITTANCE_REFERENCES_COLLECTION)
            .doc(bankReferenceDocId(bankReferenceKey));
          const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();
          // Generated outside the transaction: a retried transaction body must
          // not mint a second id for the same receipt.
          const receiptId = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc().id;

          const result = await db.runTransaction(async (tx): Promise<RecordPayrollRemittanceResult> => {
            // ── Reads (Firestore requires every read before the first write) ──
            const snap = await tx.get(remittanceRef);
            let current: Record<string, unknown>;
            if (snap.exists) {
              current = snap.data() ?? {};
            } else {
              // A batch processed before the ledger shipped has deductions but
              // no record. Build the expected side now, with the same sum
              // processPayroll uses. A batch that does not exist, or deducted
              // nothing, is still a typo rather than money.
              const batchSnap = await tx.get(db.collection(PAYROLL_BATCHES_COLLECTION).doc(input.batchId));
              const batch = batchSnap.exists ? batchFromBatchDoc(input.batchId, batchSnap.data()) : null;
              const expected = batch ? await readExpectedInTx(tx, db, input.batchId) : null;
              if (!batch || !expected || expected.expectedCents <= 0) {
                throw refusal('not-found', 'remittance-not-expected', `No remittance expected for batch ${input.batchId}`);
              }
              current = expectedRemittanceFields(batch, expected, undefined, now);
            }
            const referenceSnap = await tx.get(referenceRef);

            // ── Checks ──
            // Money withheld from a pay period cannot have been remitted before
            // that period began: a date earlier than `payPeriodStart` is a typo
            // (wrong year, wrong batch), and booking it would put the receipt
            // ahead of the deductions it pays for. The period START, not its
            // end, because an employer that runs payroll early may remit before
            // the period closes. Skipped only if the record carries no readable
            // start date — an unknown period is not a reason to refuse money.
            const payPeriodStart = current['payPeriodStart'];
            if (
              typeof payPeriodStart === 'string' &&
              isRealCalendarDate(payPeriodStart) &&
              input.receivedOn < payPeriodStart
            ) {
              throw refusal(
                'invalid-argument',
                'received-on-before-pay-period',
                `receivedOn ${input.receivedOn} is before the pay period of batch ${input.batchId} began (${payPeriodStart})`,
                { field: 'receivedOn', payPeriodStart },
              );
            }

            const receipts = receiptsOf(current);

            // One bank transfer is one receipt. Without this an ops
            // double-submit (or a client retry after a timed-out response)
            // counts the same SPEI transfer twice and reads as reconciled.
            // Compared on the normalised key, and only against receipts that
            // still count: a voided receipt's reference is free again.
            if (receipts.some((r) => !isVoided(r) && receiptReferenceKey(r) === bankReferenceKey)) {
              throw new HttpsError(
                'already-exists',
                `Bank reference ${input.bankReference} is already recorded for batch ${input.batchId}`,
                { reason: 'bank-reference-in-batch', batchIds: [input.batchId] },
              );
            }

            // The same transfer booked against a different batch is the same
            // money counted twice — unless ops says the transfer really did
            // cover both.
            const holders = holdersOf(referenceSnap.exists ? referenceSnap.data() : undefined);
            const otherBatches = [
              ...new Set(holders.filter((h) => h.batchId !== input.batchId).map((h) => h.batchId)),
            ];
            if (otherBatches.length > 0 && input.sharedTransfer !== true) {
              throw new HttpsError(
                'already-exists',
                `Bank reference ${input.bankReference} is already recorded for batch ${otherBatches.join(', ')}`,
                { reason: 'bank-reference-in-other-batch', batchIds: otherBatches },
              );
            }

            const nextReceipts: StoredReceipt[] = [
              ...receipts,
              {
                receiptId,
                amountCents: input.amountCents,
                receivedOn: input.receivedOn,
                bankReference: input.bankReference,
                bankReferenceKey,
                recordedBy: auth.uid,
                recordedAt: now,
              },
            ];
            const expectedCents = Number(current['expectedCents'] ?? 0);
            const priorReceivedCents = Number(current['receivedCents'] ?? 0);
            const receivedCents = receivedCentsOf(nextReceipts);
            const status = remittanceStatus(expectedCents, receivedCents);

            // Money in full closes the overdue alerts this cycle raised, in
            // the same commit, so the Alerts page stops showing a batch that
            // has been paid. Still a read, so still before the first write.
            const openAlerts: DocumentReference[] = [];
            if (expectedCents - receivedCents <= 0) {
              const epoch = overdueAlertEpochOf(current);
              for (const id of remittanceAlertDocIds(input.batchId, epoch)) {
                const ref = db.collection(INCIDENT_LOG_COLLECTION).doc(id);
                const alert = await tx.get(ref);
                if (alert.exists && alert.data()?.['resolved'] !== true) openAlerts.push(ref);
              }
            }

            // ── Writes ──
            const moved = {
              receivedCents,
              status,
              receipts: nextReceipts,
              lastReceivedOn: lastReceivedOnOf(nextReceipts),
              updatedAt: now,
            };

            if (snap.exists) {
              tx.update(remittanceRef, moved);
            } else {
              tx.set(remittanceRef, { ...current, ...moved, createdOnDemandBy: auth.uid });
            }

            for (const ref of openAlerts) tx.update(ref, resolvedAlertFields('remittance-received', now));

            tx.set(referenceRef, {
              bankReferenceKey,
              holders: [
                // An entry for this batch here is stale: the check above found
                // no live receipt with this reference on it.
                ...holders.filter((h) => h.batchId !== input.batchId),
                {
                  batchId: input.batchId,
                  receiptId,
                  employerId: (current['employerId'] as string | undefined) ?? null,
                },
              ],
              updatedAt: now,
            });

            tx.set(logRef, buildAuditLogDocument({
              action: 'payrollRemittances.received',
              actorUid: auth.uid,
              actorRole: auth.role,
              actorEmail: auth.email ?? null,
              targetId: input.batchId,
              before: { receivedCents: priorReceivedCents, status: snap.exists ? current['status'] ?? null : null },
              after: { receivedCents, status },
              meta: {
                employerId: current['employerId'] ?? null,
                receiptId,
                amountCents: input.amountCents,
                receivedOn: input.receivedOn,
                bankReference: input.bankReference,
                bankReferenceKey,
                ...(snap.exists ? {} : { createdRecord: true, expectedCents }),
                ...(otherBatches.length > 0 ? { sharedTransferWith: otherBatches } : {}),
                ...(openAlerts.length > 0 ? { resolvedAlerts: openAlerts.map((ref) => ref.id) } : {}),
              },
            }, now));

            return {
              batchId: input.batchId,
              receiptId,
              expectedCents,
              receivedCents,
              status,
              createdRecord: !snap.exists,
            };
          });

          logger.info({ batchId: input.batchId, status: result.status }, 'Payroll remittance recorded');
          return result;
        },
      ),
  ),
);

// ─── Ops: void a receipt booked in error ─────────────────────────────────────

const VoidPayrollRemittanceReceiptSchema = z.object({
  batchId: z.string().min(1).max(200),
  receiptId: z.string().min(1).max(200),
  reason: z.string().trim().min(3, 'a reason is required').max(500),
});

export type VoidPayrollRemittanceReceiptInput = z.infer<typeof VoidPayrollRemittanceReceiptSchema>;

export interface VoidPayrollRemittanceReceiptResult {
  batchId: string;
  receiptId: string;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
  /** True when the receipt was already voided and this call changed nothing. */
  alreadyVoided: boolean;
}

/**
 * Take a wrongly booked receipt out of the totals. The receipt is never
 * deleted: it stays in `receipts[]` marked `voided`, with who voided it, when
 * and why, and `receivedCents` / `status` are recomputed from the receipts that
 * remain. Voiding the same receipt again is a no-op, so a retried call cannot
 * write a second audit entry or disturb a reference since reused.
 */
export const voidPayrollRemittanceReceipt = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  withAuth<VoidPayrollRemittanceReceiptInput, VoidPayrollRemittanceReceiptResult>(
    [...OPS_ROLES],
    async (data, auth) =>
      withErrorHandling(
        { functionName: 'voidPayrollRemittanceReceipt', uid: auth.uid },
        async () => {
          await enforceRateLimit(`rl:voidPayrollRemittanceReceipt:${auth.uid}`, 20, 60, {
            onUnavailable: 'closed',
            context: 'voidPayrollRemittanceReceipt',
          });

          const parsed = VoidPayrollRemittanceReceiptSchema.safeParse(data);
          if (!parsed.success) {
            throw schemaRefusal(parsed.error.issues, {
              batchId: 'batch-id-invalid',
              receiptId: 'receipt-id-invalid',
              reason: 'void-reason-invalid',
            });
          }
          const input = parsed.data;

          const db = getFirestore();
          const now = Timestamp.now();
          const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(input.batchId);
          const logRef = db.collection(AUDIT_LOG_COLLECTION).doc();

          const result = await db.runTransaction(async (tx): Promise<VoidPayrollRemittanceReceiptResult> => {
            const snap = await tx.get(remittanceRef);
            if (!snap.exists) {
              throw refusal('not-found', 'remittance-not-found', `No remittance record for batch ${input.batchId}`);
            }
            const current = snap.data() ?? {};
            const receipts = receiptsOf(current);
            const index = receipts.findIndex((r, i) => receiptIdOf(r, i) === input.receiptId);
            const target = receipts[index];
            if (!target) {
              throw refusal('not-found', 'receipt-not-found', `No receipt ${input.receiptId} on batch ${input.batchId}`);
            }

            const expectedCents = Number(current['expectedCents'] ?? 0);
            const priorReceivedCents = Number(current['receivedCents'] ?? 0);
            if (isVoided(target)) {
              return {
                batchId: input.batchId,
                receiptId: input.receiptId,
                expectedCents,
                receivedCents: priorReceivedCents,
                status: remittanceStatus(expectedCents, priorReceivedCents),
                alreadyVoided: true,
              };
            }

            const bankReferenceKey = receiptReferenceKey(target);
            const referenceRef = db
              .collection(PAYROLL_REMITTANCE_REFERENCES_COLLECTION)
              .doc(bankReferenceDocId(bankReferenceKey));
            const referenceSnap = await tx.get(referenceRef);

            const nextReceipts = receipts.map((r, i) =>
              i === index
                ? {
                    ...r,
                    // Receipts booked before ids and keys were stored get them
                    // now, so the voided entry is self-describing.
                    receiptId: input.receiptId,
                    bankReferenceKey,
                    voided: true,
                    voidedBy: auth.uid,
                    voidedAt: now,
                    voidReason: input.reason,
                  }
                : r,
            );
            const receivedCents = receivedCentsOf(nextReceipts);
            const status = remittanceStatus(expectedCents, receivedCents);
            // A void that leaves a settled record owing again starts a new
            // alert cycle: the overdue check can then raise every threshold
            // afresh, even ones the settled cycle already raised (and closed).
            const epoch = nextOverdueAlertEpoch(current, expectedCents, receivedCents);

            tx.update(remittanceRef, {
              receivedCents,
              status,
              receipts: nextReceipts,
              lastReceivedOn: lastReceivedOnOf(nextReceipts),
              ...(epoch !== overdueAlertEpochOf(current) ? { [OVERDUE_ALERT_EPOCH_FIELD]: epoch } : {}),
              updatedAt: now,
            });

            // Release the reference so the transfer can be booked correctly.
            // The index only says who holds a reference NOW; the history is
            // the voided receipt above and the audit entry below.
            if (referenceSnap.exists) {
              const remaining = holdersOf(referenceSnap.data()).filter(
                (h) => !(h.batchId === input.batchId && h.receiptId === input.receiptId),
              );
              if (remaining.length === 0) tx.delete(referenceRef);
              else tx.set(referenceRef, { bankReferenceKey, holders: remaining, updatedAt: now });
            }

            tx.set(logRef, buildAuditLogDocument({
              action: 'payrollRemittances.receiptVoided',
              actorUid: auth.uid,
              actorRole: auth.role,
              actorEmail: auth.email ?? null,
              targetId: input.batchId,
              before: { receivedCents: priorReceivedCents, status: current['status'] ?? null },
              after: { receivedCents, status },
              meta: {
                employerId: current['employerId'] ?? null,
                receiptId: input.receiptId,
                amountCents: target['amountCents'] ?? null,
                receivedOn: target['receivedOn'] ?? null,
                bankReference: target['bankReference'] ?? null,
                recordedBy: target['recordedBy'] ?? null,
                reason: input.reason,
              },
            }, now));

            return {
              batchId: input.batchId,
              receiptId: input.receiptId,
              expectedCents,
              receivedCents,
              status,
              alreadyVoided: false,
            };
          });

          logger.info(
            { batchId: input.batchId, receiptId: input.receiptId, status: result.status, alreadyVoided: result.alreadyVoided },
            'Payroll remittance receipt voided',
          );
          return result;
        },
      ),
  ),
);

// ─── Ops: list remittances with status and aging ─────────────────────────────

/** Most records one page holds, and the page size when the caller names none. */
export const LIST_REMITTANCES_MAX = 500;

const ListPayrollRemittancesSchema = z
  .object({
    /** `outstanding` (default): expected or partial only. `all`: every record. */
    view: z.enum(['outstanding', 'all']).optional(),
    employerId: z.string().min(1).max(200).optional(),
    /** Only records past the grace window with money still missing. */
    overdueOnly: z.boolean().optional(),
    graceDays: z.number().int().min(0).max(365).optional(),
    /** Page size. */
    limit: z.number().int().min(1).max(LIST_REMITTANCES_MAX).optional(),
    /** `nextCursor` of the previous page, to get the one after it. */
    cursor: z.string().min(1).max(1000).optional(),
  })
  .optional();

export type ListPayrollRemittancesInput = z.infer<typeof ListPayrollRemittancesSchema>;

export interface RemittanceReceiptView {
  receiptId: string;
  amountCents: number;
  receivedOn: string | null;
  bankReference: string | null;
  recordedBy: string | null;
  /** ISO 8601, or null if the stored value is not a timestamp. */
  recordedAt: string | null;
  voided: boolean;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface RemittanceView {
  batchId: string;
  employerId: string | null;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
  deductionCount: number;
  lastReceivedOn: string | null;
  aging: RemittanceAging;
  receipts: RemittanceReceiptView[];
}

export interface RemittanceTotals {
  count: number;
  expectedCents: number;
  receivedCents: number;
  outstandingCents: number;
  overdueCount: number;
  overdueCents: number;
}

export interface MatchingRemittanceTotals extends RemittanceTotals {
  /** false: the walk stopped at its cap, so these figures cover only the first part of the view. */
  complete: boolean;
}

export interface ListPayrollRemittancesResult {
  /** The Mexico City date aging was computed against. */
  asOf: string;
  graceDays: number;
  /** The page size this call used. */
  pageSize: number;
  /** One page, in the ledger's order (see `remittancesQuery`). */
  remittances: RemittanceView[];
  /** Totals of THIS PAGE's rows — not of everything that matches. */
  totals: RemittanceTotals;
  /**
   * Totals of EVERY record the filters match, across all pages. Only on the
   * first page (no `cursor`): later pages of the same walk return null, as
   * does a first page whose totals walk failed — the list itself still works.
   */
  matchingTotals: MatchingRemittanceTotals | null;
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** `nextCursor !== null`. Kept for callers written before pagination. */
  truncated: boolean;
}

/**
 * A page cursor is the sort key of the page's last row, tagged with the
 * direction it was read in so a cursor from one view cannot be replayed into a
 * view sorted the other way (it would silently skip most of the ledger).
 * Opaque to the client: base64url of a small JSON array.
 */
export function encodeRemittanceCursor(direction: 'asc' | 'desc', position: RemittancePosition): string {
  return Buffer.from(JSON.stringify([direction, position.payPeriodEnd, position.batchId]), 'utf8').toString('base64url');
}

/** The position a cursor names, or null if it is not a cursor for `direction`. */
export function decodeRemittanceCursor(cursor: string, direction: 'asc' | 'desc'): RemittancePosition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [dir, payPeriodEnd, batchId] = parsed as unknown[];
  if (dir !== direction || typeof payPeriodEnd !== 'string' || typeof batchId !== 'string') return null;
  // The id goes to Firestore as a document id: it must be able to be one.
  if (!batchId || batchId.includes('/') || batchId.length > 200) return null;
  return { payPeriodEnd, batchId };
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function isoOrNull(v: unknown): string | null {
  const toDate = (v as { toDate?: () => Date } | null)?.toDate;
  return typeof toDate === 'function' ? toDate.call(v).toISOString() : null;
}

/** A stored record → the shape the ops UI renders. Pure, so the aging it reports is testable without a callable. */
export function toRemittanceView(
  batchId: string,
  doc: Record<string, unknown>,
  today: string,
  graceDays: number,
): RemittanceView {
  const expectedCents = Number(doc['expectedCents'] ?? 0);
  const receivedCents = Number(doc['receivedCents'] ?? 0);
  return {
    batchId,
    employerId: stringOrNull(doc['employerId']),
    payPeriodStart: stringOrNull(doc['payPeriodStart']),
    payPeriodEnd: stringOrNull(doc['payPeriodEnd']),
    expectedCents,
    receivedCents,
    // Derived, not read: a stored status can only ever agree with these two figures.
    status: remittanceStatus(expectedCents, receivedCents),
    deductionCount: Number(doc['deductionCount'] ?? 0),
    lastReceivedOn: stringOrNull(doc['lastReceivedOn']),
    aging: remittanceAging(doc, today, graceDays),
    receipts: receiptsOf(doc).map((r, i) => ({
      receiptId: receiptIdOf(r, i),
      amountCents: Number(r['amountCents'] ?? 0),
      receivedOn: stringOrNull(r['receivedOn']),
      bankReference: stringOrNull(r['bankReference']),
      recordedBy: stringOrNull(r['recordedBy']),
      recordedAt: isoOrNull(r['recordedAt']),
      voided: isVoided(r),
      voidedBy: stringOrNull(r['voidedBy']),
      voidedAt: isoOrNull(r['voidedAt']),
      voidReason: stringOrNull(r['voidReason']),
    })),
  };
}

const EMPTY_TOTALS: RemittanceTotals = {
  count: 0,
  expectedCents: 0,
  receivedCents: 0,
  outstandingCents: 0,
  overdueCount: 0,
  overdueCents: 0,
};

function addToTotals(t: RemittanceTotals, r: Pick<RemittanceView, 'expectedCents' | 'receivedCents' | 'aging'>): RemittanceTotals {
  return {
    count: t.count + 1,
    expectedCents: t.expectedCents + r.expectedCents,
    receivedCents: t.receivedCents + r.receivedCents,
    outstandingCents: t.outstandingCents + r.aging.outstandingCents,
    overdueCount: t.overdueCount + (r.aging.overdue ? 1 : 0),
    overdueCents: t.overdueCents + (r.aging.overdue ? r.aging.outstandingCents : 0),
  };
}

/** Records the totals walk reads per page, and the most pages it reads (40,000 records). */
export const MATCHING_TOTALS_PAGE_SIZE = 1000;
export const MATCHING_TOTALS_MAX_PAGES = 40;

export interface MatchingTotalsFilter {
  outstandingOnly: boolean;
  overdueOnly: boolean;
  employerId?: string;
  today: string;
  graceDays: number;
}

/**
 * Totals over every record a list filter matches, not one page of it.
 *
 * The same ordered query the list pages through, walked to the end with only
 * the three fields the arithmetic needs (`select`), and summed with the same
 * derivation the rows use — status from the figures, aging from the period
 * end — so the totals cannot disagree with the rows that make them up. It
 * needs no index the list does not already use. A Firestore sum() aggregation
 * would be cheaper per call, but would sum stored `status` and need composite
 * indexes over the summed fields; the outstanding view, which is what ops
 * opens, is small.
 *
 * The walk stops after MATCHING_TOTALS_MAX_PAGES pages and says so
 * (`complete: false`) rather than passing a partial sum off as the whole.
 */
export async function matchingRemittanceTotals(
  db: Firestore,
  filter: MatchingTotalsFilter,
  maxPages: number = MATCHING_TOTALS_MAX_PAGES,
): Promise<MatchingRemittanceTotals> {
  let totals = EMPTY_TOTALS;
  let after: RemittancePosition | undefined;
  for (let pages = 0; ; pages++) {
    const page = await remittancesQuery(db, {
      outstandingOnly: filter.outstandingOnly,
      employerId: filter.employerId,
      periodEndBefore: filter.overdueOnly ? calendarDaysBefore(filter.today, filter.graceDays) : undefined,
      after,
    })
      .select('expectedCents', 'receivedCents', 'payPeriodEnd')
      .limit(MATCHING_TOTALS_PAGE_SIZE)
      .get();

    for (const doc of page.docs) {
      const data = doc.data();
      const expectedCents = Number(data['expectedCents'] ?? 0);
      const receivedCents = Number(data['receivedCents'] ?? 0);
      // The same two filters the page applies to its rows.
      if (filter.outstandingOnly && !OUTSTANDING_REMITTANCE_STATUSES.includes(remittanceStatus(expectedCents, receivedCents))) {
        continue;
      }
      const aging = remittanceAging(data, filter.today, filter.graceDays);
      if (filter.overdueOnly && !aging.overdue) continue;
      totals = addToTotals(totals, { expectedCents, receivedCents, aging });
    }

    const last = page.docs[page.docs.length - 1];
    if (!last || page.docs.length < MATCHING_TOTALS_PAGE_SIZE) return { ...totals, complete: true };
    if (pages + 1 >= maxPages) {
      logger.warn({ ...filter, maxPages }, 'Remittance totals walk stopped at its cap; totals are incomplete');
      return { ...totals, complete: false };
    }
    after = { payPeriodEnd: String(last.data()['payPeriodEnd'] ?? ''), batchId: last.id };
  }
}

/**
 * The read path for the ops remittance screen: which batches still owe money,
 * and for how long.
 *
 * One ordered, paginated Firestore query (`remittancesQuery`): outstanding
 * records oldest pay period first, or — `view: 'all'` — every record newest
 * first. The order is total (pay period end, then batch id), so paging with
 * `nextCursor` neither skips nor repeats a record however many there are.
 *
 * The first page (no `cursor`) also carries `matchingTotals`, the totals of
 * every record the filters match (`matchingRemittanceTotals`); `totals` stays
 * the page's own.
 *
 * It only knows about batches that have a record. Batches processed before the
 * ledger shipped get one from the backfill script (or from the first receipt
 * booked against them).
 */
export const listPayrollRemittances = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  withAuth<ListPayrollRemittancesInput, ListPayrollRemittancesResult>(
    [...OPS_ROLES],
    async (data, auth) =>
      withErrorHandling(
        { functionName: 'listPayrollRemittances', uid: auth.uid },
        async () => {
          await enforceRateLimit(`rl:listPayrollRemittances:${auth.uid}`, 60, 60, {
            onUnavailable: 'closed',
            context: 'listPayrollRemittances',
          });

          const parsed = ListPayrollRemittancesSchema.safeParse(data ?? undefined);
          if (!parsed.success) {
            throw schemaRefusal(parsed.error.issues, {
              view: 'view-invalid',
              employerId: 'employer-id-invalid',
              overdueOnly: 'overdue-only-invalid',
              graceDays: 'grace-days-invalid',
              limit: 'limit-invalid',
              cursor: 'cursor-invalid',
            });
          }
          const input = parsed.data ?? {};
          const graceDays = input.graceDays ?? DEFAULT_REMITTANCE_GRACE_DAYS;
          const pageSize = input.limit ?? LIST_REMITTANCES_MAX;
          const today = todayInMexicoCity(new Date(Date.now()));

          // Overdue implies outstanding, whatever `view` says.
          const outstandingOnly = (input.view ?? 'outstanding') === 'outstanding' || input.overdueOnly === true;
          const direction = remittancesQueryDirection({ outstandingOnly });

          let after: RemittancePosition | undefined;
          if (input.cursor !== undefined) {
            const position = decodeRemittanceCursor(input.cursor, direction);
            if (!position) {
              throw refusal('invalid-argument', 'cursor-invalid', 'cursor is not a page cursor for this view', {
                field: 'cursor',
              });
            }
            after = position;
          }

          // One row more than the page, to learn whether another page exists
          // without a second query.
          const snap = await remittancesQuery(getFirestore(), {
            outstandingOnly,
            employerId: input.employerId,
            // "More than graceDays days after payPeriodEnd" is a range on the
            // sort field, so the server does it: payPeriodEnd < today − grace.
            periodEndBefore: input.overdueOnly ? calendarDaysBefore(today, graceDays) : undefined,
            after,
          })
            .limit(pageSize + 1)
            .get();
          const pageDocs = snap.docs.slice(0, pageSize);
          const last = pageDocs[pageDocs.length - 1];
          const nextCursor =
            snap.docs.length > pageSize && last
              ? encodeRemittanceCursor(direction, {
                  payPeriodEnd: String(last.data()['payPeriodEnd'] ?? ''),
                  batchId: last.id,
                })
              : null;

          // No re-sort: the query's order IS the contract, and it must be the
          // same on every page. The two filters only ever drop a row whose
          // stored fields disagree with what they derive to (a stale `status`,
          // an unreadable `payPeriodEnd`), so a page can come back short.
          const remittances = pageDocs
            .map((d) => toRemittanceView(d.id, d.data(), today, graceDays))
            .filter((r) => !outstandingOnly || OUTSTANDING_REMITTANCE_STATUSES.includes(r.status))
            .filter((r) => !input.overdueOnly || r.aging.overdue);

          const totals = remittances.reduce(addToTotals, EMPTY_TOTALS);

          // Later pages of a walk already had these on its first page.
          let matchingTotals: MatchingRemittanceTotals | null = null;
          if (input.cursor === undefined) {
            try {
              matchingTotals = await matchingRemittanceTotals(getFirestore(), {
                outstandingOnly,
                overdueOnly: input.overdueOnly === true,
                employerId: input.employerId,
                today,
                graceDays,
              });
            } catch (err) {
              // The list is still right without them; the screen falls back to
              // summing what it has loaded, and says so.
              logger.error(
                { error: err instanceof Error ? err.message : String(err) },
                'Remittance totals walk failed; returning the page without them',
              );
            }
          }

          return {
            asOf: today,
            graceDays,
            pageSize,
            remittances,
            totals,
            matchingTotals,
            nextCursor,
            truncated: nextCursor !== null,
          };
        },
      ),
  ),
);
