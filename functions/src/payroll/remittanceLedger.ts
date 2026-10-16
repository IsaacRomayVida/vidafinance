import { createHash } from 'crypto';
import type { Firestore, Query, Transaction } from 'firebase-admin/firestore';

/**
 * The remittance ledger's arithmetic and document shape, with no Firebase
 * runtime dependency (the `firebase-admin` import above is type-only).
 *
 * It lives apart from `remittance.ts` because three callers must agree on it
 * to the centavo and none may carry its own copy: `processPayroll` (through
 * `recordExpectedRemittance`), the ops callables, and the backfill script
 * `scripts/migrations/004_backfill_payroll_remittances.ts`, which runs outside
 * the functions runtime and so cannot import a module that loads
 * `firebase-functions`.
 *
 * Money is integer centavos throughout.
 */

export const PAYROLL_REMITTANCES_COLLECTION = 'payrollRemittances';
export const PAYROLL_REMITTANCE_REFERENCES_COLLECTION = 'payrollRemittanceReferences';
export const PAYROLL_BATCHES_COLLECTION = 'payrollBatches';
export const PAYROLL_DEDUCTIONS_COLLECTION = 'payrollDeductions';

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

// ─── Expected side ───────────────────────────────────────────────────────────

export interface RemittanceBatch {
  batchId: string;
  employerId: string;
  payPeriodStart: string;
  payPeriodEnd: string;
}

export interface ExpectedFromDeductions {
  expectedCents: number;
  deductionCount: number;
}

/**
 * What a batch's `payrollDeductions` rows say the employer owes. The one place
 * that sum is defined: each row is converted to centavos BEFORE adding, so the
 * total cannot pick up float dust from the peso amounts.
 */
export function expectedFromDeductionRows(rows: Array<Record<string, unknown>>): ExpectedFromDeductions {
  return {
    expectedCents: rows.reduce((sum, row) => sum + pesosToCents(Number(row['deductionAmount'] ?? 0)), 0),
    deductionCount: rows.length,
  };
}

export function batchDeductionsQuery(db: Firestore, batchId: string) {
  return db.collection(PAYROLL_DEDUCTIONS_COLLECTION).where('batchId', '==', batchId);
}

/** Reads the batch's deductions inside `tx`, so the sum is consistent with whatever `tx` writes. */
export async function readExpectedInTx(
  tx: Transaction,
  db: Firestore,
  batchId: string,
): Promise<ExpectedFromDeductions> {
  const deductions = await tx.get(batchDeductionsQuery(db, batchId));
  return expectedFromDeductionRows(deductions.docs.map((d) => d.data()));
}

/**
 * The fields the expected side owns, merged onto the record. `existing` is the
 * record as read in the same transaction (undefined when there is none): a
 * receipt ops already booked is preserved, only `expectedCents` and the derived
 * `status` move.
 *
 * `serverTimestamp` is passed in rather than imported so this module stays
 * importable outside the functions runtime.
 */
export function expectedRemittanceFields(
  batch: RemittanceBatch,
  expected: ExpectedFromDeductions,
  existing: Record<string, unknown> | undefined,
  serverTimestamp: unknown,
): Record<string, unknown> {
  const receivedCents = Number(existing?.['receivedCents'] ?? 0);
  // A retried batch that raises what a settled record expects re-opens it.
  const epoch = nextOverdueAlertEpoch(existing, expected.expectedCents, receivedCents);
  return {
    batchId: batch.batchId,
    employerId: batch.employerId,
    payPeriodStart: batch.payPeriodStart,
    payPeriodEnd: batch.payPeriodEnd,
    expectedCents: expected.expectedCents,
    deductionCount: expected.deductionCount,
    receivedCents,
    status: remittanceStatus(expected.expectedCents, receivedCents),
    ...(existing ? {} : { receipts: [], createdAt: serverTimestamp }),
    ...(epoch !== overdueAlertEpochOf(existing) ? { [OVERDUE_ALERT_EPOCH_FIELD]: epoch } : {}),
    updatedAt: serverTimestamp,
  };
}

/**
 * Write (or refresh) the expected side of a batch's record in its own
 * transaction. Returns null, writing nothing, for a batch that deducted nothing
 * and has no record: there is nothing to remit, and an empty record would read
 * as a reconciled one.
 */
export async function upsertExpectedRemittance(
  db: Firestore,
  batch: RemittanceBatch,
  serverTimestamp: () => unknown,
  extraOnCreate: Record<string, unknown> = {},
): Promise<{ expectedCents: number; status: RemittanceStatus; created: boolean } | null> {
  const remittanceRef = db.collection(PAYROLL_REMITTANCES_COLLECTION).doc(batch.batchId);

  return db.runTransaction(async (tx) => {
    const expected = await readExpectedInTx(tx, db, batch.batchId);
    const snap = await tx.get(remittanceRef);
    if (expected.expectedCents <= 0 && !snap.exists) return null;

    const fields = expectedRemittanceFields(batch, expected, snap.exists ? snap.data() ?? {} : undefined, serverTimestamp());
    tx.set(remittanceRef, { ...fields, ...(snap.exists ? {} : extraOnCreate) }, { merge: true });
    return {
      expectedCents: expected.expectedCents,
      status: fields['status'] as RemittanceStatus,
      created: !snap.exists,
    };
  });
}

/** A `payrollBatches` document → the identity fields a remittance record needs, or null if it lacks them. */
export function batchFromBatchDoc(batchId: string, data: Record<string, unknown> | undefined): RemittanceBatch | null {
  const employerId = data?.['employerId'];
  const payPeriodStart = data?.['payPeriodStart'];
  const payPeriodEnd = data?.['payPeriodEnd'];
  if (typeof employerId !== 'string' || typeof payPeriodStart !== 'string' || typeof payPeriodEnd !== 'string') {
    return null;
  }
  return { batchId, employerId, payPeriodStart, payPeriodEnd };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

export const REMITTANCE_TIME_ZONE = 'America/Mexico_City';

/** `YYYY-MM-DD` naming a day that exists: 2026-02-30 and 2026-13-01 do not. */
export function isRealCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls an impossible day forward (Feb 30 → Mar 2) instead of failing.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Today's date where the money moves. Functions run in UTC, which is already
 * tomorrow in Mexico City from 18:00 local — a UTC "today" would accept a
 * receipt dated tomorrow every evening.
 */
export function todayInMexicoCity(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REMITTANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Whole calendar days from `fromIso` to `toIso` (negative if `toIso` is earlier). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// ─── Bank references ─────────────────────────────────────────────────────────

/**
 * The form a bank reference is compared in: Unicode-normalised, trimmed, inner
 * whitespace collapsed to one space, upper-cased. "spei-0001", " SPEI-0001 " and
 * "SPEI-0001" are one transfer typed three ways. Punctuation is kept — two
 * references differing by a hyphen are not provably the same transfer.
 */
export function normalizeBankReference(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Document id of a reference's entry in `payrollRemittanceReferences`. Hashed
 * because a normalised reference may contain `/` or be `.`/`..`, none of which
 * can be a Firestore document id.
 */
export function bankReferenceDocId(bankReferenceKey: string): string {
  return createHash('sha256').update(bankReferenceKey, 'utf8').digest('hex');
}

// ─── Receipts ────────────────────────────────────────────────────────────────

export type StoredReceipt = Record<string, unknown>;

/**
 * A receipt's id. Receipts booked before ids existed have none; their position
 * in `receipts[]` is stable (the array only ever grows, nothing is removed or
 * reordered), so it serves as one.
 */
export function receiptIdOf(receipt: StoredReceipt, index: number): string {
  const id = receipt['receiptId'];
  return typeof id === 'string' && id ? id : `legacy-${index}`;
}

/** The comparison key of a stored receipt, computed for receipts booked before keys were stored. */
export function receiptReferenceKey(receipt: StoredReceipt): string {
  const key = receipt['bankReferenceKey'];
  if (typeof key === 'string' && key) return key;
  return normalizeBankReference(String(receipt['bankReference'] ?? ''));
}

export function isVoided(receipt: StoredReceipt): boolean {
  return receipt['voided'] === true;
}

/**
 * Money actually received: the sum of the receipts that have not been voided.
 * `receivedCents` on the record is always rewritten from this, never adjusted
 * by a delta, so the stored figure cannot drift from the receipts behind it.
 */
export function receivedCentsOf(receipts: StoredReceipt[]): number {
  return receipts.reduce((sum, r) => (isVoided(r) ? sum : sum + Number(r['amountCents'] ?? 0)), 0);
}

/** Latest `receivedOn` among receipts that still count, or null. */
export function lastReceivedOnOf(receipts: StoredReceipt[]): string | null {
  let last: string | null = null;
  for (const r of receipts) {
    const on = r['receivedOn'];
    if (isVoided(r) || typeof on !== 'string') continue;
    if (last === null || on > last) last = on;
  }
  return last;
}

export function receiptsOf(doc: Record<string, unknown> | undefined): StoredReceipt[] {
  const receipts = doc?.['receipts'];
  return Array.isArray(receipts) ? (receipts as StoredReceipt[]) : [];
}

// ─── Aging ───────────────────────────────────────────────────────────────────

/**
 * Days after the pay period ends before an unremitted balance counts as
 * overdue. A default for the ops view, not a contractual term: no remittance
 * deadline is recorded per employer, so callers may pass their own.
 */
export const DEFAULT_REMITTANCE_GRACE_DAYS = 7;

export type RemittanceAgingBucket =
  /** Nothing outstanding (received in full, or overpaid). */
  | 'settled'
  /** Outstanding, still inside the grace window. */
  | 'current'
  | 'overdue_1_15'
  | 'overdue_16_30'
  | 'overdue_31_plus';

export interface RemittanceAging {
  /** Expected minus received, floored at 0. */
  outstandingCents: number;
  /** Calendar days from `payPeriodEnd` to `today`; null when the record has no usable period end. */
  daysSincePeriodEnd: number | null;
  /** Days past the grace window; 0 unless overdue. */
  daysOverdue: number;
  overdue: boolean;
  bucket: RemittanceAgingBucket;
}

/**
 * How late an expected remittance is, as of `today` (YYYY-MM-DD, Mexico City).
 *
 * Works from `expectedCents` and `receivedCents` rather than `status`, so a
 * `partial` record ages on what is still missing and an `overpaid` one never
 * shows as owing. A record whose period end cannot be read is reported as
 * outstanding but never as overdue — an unknown age is not a late one.
 */
export function remittanceAging(
  doc: Record<string, unknown>,
  today: string,
  graceDays: number = DEFAULT_REMITTANCE_GRACE_DAYS,
): RemittanceAging {
  const expectedCents = Number(doc['expectedCents'] ?? 0);
  const receivedCents = Number(doc['receivedCents'] ?? 0);
  const outstandingCents = Math.max(0, expectedCents - receivedCents);

  const periodEnd = doc['payPeriodEnd'];
  const daysSincePeriodEnd =
    typeof periodEnd === 'string' && isRealCalendarDate(periodEnd) ? calendarDaysBetween(periodEnd, today) : null;

  if (outstandingCents === 0) {
    return { outstandingCents, daysSincePeriodEnd, daysOverdue: 0, overdue: false, bucket: 'settled' };
  }

  const daysOverdue = daysSincePeriodEnd === null ? 0 : Math.max(0, daysSincePeriodEnd - graceDays);
  let bucket: RemittanceAgingBucket = 'current';
  if (daysOverdue > 30) bucket = 'overdue_31_plus';
  else if (daysOverdue > 15) bucket = 'overdue_16_30';
  else if (daysOverdue > 0) bucket = 'overdue_1_15';

  return { outstandingCents, daysSincePeriodEnd, daysOverdue, overdue: daysOverdue > 0, bucket };
}

// ─── Reading the ledger in order ─────────────────────────────────────────────

export const OUTSTANDING_REMITTANCE_STATUSES: RemittanceStatus[] = ['expected', 'partial'];

/** Where a page of `remittancesQuery` ended: the last row's sort key. */
export interface RemittancePosition {
  payPeriodEnd: string;
  batchId: string;
}

export interface RemittancesQueryOptions {
  /**
   * true: only records still owing (`status` expected or partial), OLDEST pay
   * period first — the order ops works them in. false: every record, NEWEST
   * pay period first.
   */
  outstandingOnly: boolean;
  employerId?: string;
  /** Only records whose `payPeriodEnd` is strictly before this YYYY-MM-DD date. */
  periodEndBefore?: string;
  /** Continue after this row (the last row of the previous page). */
  after?: RemittancePosition;
}

/** The direction `remittancesQuery` sorts in for these options. */
export function remittancesQueryDirection(options: Pick<RemittancesQueryOptions, 'outstandingOnly'>): 'asc' | 'desc' {
  return options.outstandingOnly ? 'asc' : 'desc';
}

/**
 * The one ordered query over `payrollRemittances`, shared by the ops list and
 * the overdue alert so both walk the ledger the same way.
 *
 * Sorted on `payPeriodEnd` then document id (= batchId), which is a total
 * order, so a page boundary can never skip or repeat a record. The composite
 * indexes this needs are in firestore.indexes.json (collection group
 * `payrollRemittances`); see docs/runbooks/payroll-remittances.md.
 *
 * A record with no `payPeriodEnd` is not returned (Firestore leaves documents
 * without the sort field out of an ordered query). Every writer sets it:
 * `batchFromBatchDoc` refuses a batch without one.
 */
export function remittancesQuery(db: Firestore, options: RemittancesQueryOptions): Query {
  const direction = remittancesQueryDirection(options);
  let query: Query = db.collection(PAYROLL_REMITTANCES_COLLECTION);
  if (options.employerId) query = query.where('employerId', '==', options.employerId);
  if (options.outstandingOnly) query = query.where('status', 'in', OUTSTANDING_REMITTANCE_STATUSES);
  if (options.periodEndBefore) query = query.where('payPeriodEnd', '<', options.periodEndBefore);
  // '__name__' is the document id. It sorts the same way as the field before
  // it, so each direction needs one index rather than two.
  query = query.orderBy('payPeriodEnd', direction).orderBy('__name__', direction);
  if (options.after) query = query.startAfter(options.after.payPeriodEnd, options.after.batchId);
  return query;
}

/** The date `days` calendar days before `iso` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function calendarDaysBefore(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

// ─── Overdue alert thresholds ────────────────────────────────────────────────

/**
 * Days overdue at which ops is alerted, one alert per record per threshold.
 * They are the lower edges of the aging buckets above (1–15, 16–30, 31+), so an
 * alert means "this record just moved into a worse bucket".
 */
export const REMITTANCE_ALERT_THRESHOLD_DAYS = [1, 16, 31] as const;

/** The highest threshold a record `daysOverdue` days late has reached, or null if it is not overdue. */
export function remittanceAlertThreshold(daysOverdue: number): number | null {
  let reached: number | null = null;
  for (const threshold of REMITTANCE_ALERT_THRESHOLD_DAYS) {
    if (daysOverdue >= threshold) reached = threshold;
  }
  return reached;
}

// ─── Overdue alerts: identity and lifecycle ──────────────────────────────────

/** `incident_log` is the collection the ops Alerts page (`/ops/alerts`) lists. */
export const INCIDENT_LOG_COLLECTION = 'incident_log';
export const REMITTANCE_ALERT_SOURCE = 'remittance-overdue';

/**
 * The record field that numbers its overdue-alert cycles. A cycle is one
 * stretch of owing money: it starts at 0 and moves on each time a record that
 * was settled owes money again (a void took a receipt back out, or a retried
 * batch raised what is expected). Alerts are keyed on it, so a re-opened record
 * can raise a threshold again that its previous cycle already raised.
 */
export const OVERDUE_ALERT_EPOCH_FIELD = 'overdueAlertEpoch';

export function overdueAlertEpochOf(doc: Record<string, unknown> | undefined): number {
  const epoch = Number(doc?.[OVERDUE_ALERT_EPOCH_FIELD] ?? 0);
  return Number.isInteger(epoch) && epoch > 0 ? epoch : 0;
}

/**
 * The cycle a record is in after a write that leaves it at these figures.
 * `existing` is the record before the write (undefined when the write creates
 * it). Only a settled → owing move starts a new cycle; anything else keeps it.
 */
export function nextOverdueAlertEpoch(
  existing: Record<string, unknown> | undefined,
  expectedCents: number,
  receivedCents: number,
): number {
  const epoch = overdueAlertEpochOf(existing);
  if (!existing) return epoch;
  const wasSettled = Number(existing['expectedCents'] ?? 0) - Number(existing['receivedCents'] ?? 0) <= 0;
  return wasSettled && expectedCents - receivedCents > 0 ? epoch + 1 : epoch;
}

/**
 * Deterministic, so `create()` is the idempotency check. Cycle 0 keeps the id
 * alerts had before cycles existed; a later cycle is marked `e<n>_` straight
 * after the source, where a cycle-0 id always has a digit, so no two (batch,
 * cycle, threshold) triples share an id even though batch ids contain `_`.
 */
export function remittanceAlertDocId(batchId: string, thresholdDays: number, epoch = 0): string {
  return epoch > 0
    ? `${REMITTANCE_ALERT_SOURCE}_e${epoch}_${thresholdDays}d_${batchId}`
    : `${REMITTANCE_ALERT_SOURCE}_${thresholdDays}d_${batchId}`;
}

/** Every alert id one cycle of a record can have raised. */
export function remittanceAlertDocIds(batchId: string, epoch = 0): string[] {
  return REMITTANCE_ALERT_THRESHOLD_DAYS.map((threshold) => remittanceAlertDocId(batchId, threshold, epoch));
}

/** Why the system (not ops) closed an alert. */
export type RemittanceAlertResolution =
  /** A receipt left the record with nothing outstanding. */
  | 'remittance-received'
  /** The daily check found the record no longer overdue. */
  | 'no-longer-overdue'
  /** The record settled and owes again: the alert belongs to the cycle before. */
  | 'superseded';

/**
 * The update that closes an alert. `resolved` is the field the Alerts page
 * reads (and the only one ops may flip); the rest say it was the system, and why.
 */
export function resolvedAlertFields(resolution: RemittanceAlertResolution, resolvedAt: unknown): Record<string, unknown> {
  return { resolved: true, resolvedAt, resolvedBy: 'system', resolution };
}
