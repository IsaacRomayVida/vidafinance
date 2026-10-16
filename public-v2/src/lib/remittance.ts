/**
 * remittance.ts — the payroll-remittance callable contract as the ops console
 * sees it, plus the client-side checks that mirror the server's.
 *
 * Server side: functions/src/payroll/remittance.ts and remittanceLedger.ts
 * (contract in docs/runbooks/payroll-remittances.md). The validators here are
 * a courtesy — they save a round trip and say what is wrong in Spanish — and
 * the server stays the authority: it re-checks every field.
 */

export const REMITTANCE_TIME_ZONE = 'America/Mexico_City';
export const BANK_REFERENCE_MAX = 100;
export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 500;
/**
 * Rows asked for per request. Well under the server's cap of 500: the screen
 * shows every receipt of every row, so a page is already a long scroll.
 */
export const REMITTANCE_PAGE_SIZE = 50;
/** The server's own ceiling on `limit` (LIST_REMITTANCES_MAX). */
export const REMITTANCE_LIMIT_MAX = 500;

export type RemittanceStatus = 'expected' | 'partial' | 'received' | 'overpaid';
export type RemittanceAgingBucket = 'settled' | 'current' | 'overdue_1_15' | 'overdue_16_30' | 'overdue_31_plus';

export interface RemittanceAging {
  outstandingCents: number;
  daysSincePeriodEnd: number | null;
  daysOverdue: number;
  overdue: boolean;
  bucket: RemittanceAgingBucket;
}

export interface RemittanceReceipt {
  receiptId: string;
  amountCents: number;
  receivedOn: string | null;
  bankReference: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  voided: boolean;
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface Remittance {
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
  receipts: RemittanceReceipt[];
}

export interface ListRemittancesInput {
  view?: 'outstanding' | 'all';
  employerId?: string;
  overdueOnly?: boolean;
  graceDays?: number;
  /** Integer 1–500. The server defaults to 500. */
  limit?: number;
  /** The previous page's `nextCursor`. Only valid for the same view and filters. */
  cursor?: string;
}

export interface RemittanceTotals {
  count: number;
  expectedCents: number;
  receivedCents: number;
  outstandingCents: number;
  overdueCount: number;
  overdueCents: number;
}

export interface ListRemittancesResult {
  asOf: string;
  graceDays: number;
  /** Same as `nextCursor !== null`; kept by the server for older clients. */
  truncated: boolean;
  /** The `limit` the server applied. A page may hold fewer rows and still have a `nextCursor`. */
  pageSize?: number;
  /** Pass back as `cursor` for the next page; null (or absent, older server) on the last one. */
  nextCursor?: string | null;
  /** Totals of THIS page only. */
  totals: RemittanceTotals;
  /**
   * Totals of every record the filters match, across all pages. Sent with the
   * first page only (null on later pages, and when the server could not work
   * them out; absent from an older server). `complete: false` means the server
   * stopped at its cap and these cover only part of the view.
   */
  matchingTotals?: MatchingRemittanceTotals | null;
  remittances: Remittance[];
}

export interface MatchingRemittanceTotals extends RemittanceTotals {
  complete: boolean;
}

/**
 * Totals over the rows actually on screen — the fallback when the server sent
 * no `matchingTotals`. Recomputed from the rows rather than added page by
 * page, so it cannot drift from the list beneath it.
 */
export function totalsOf(remittances: Remittance[]): RemittanceTotals {
  return remittances.reduce<RemittanceTotals>(
    (t, r) => ({
      count: t.count + 1,
      expectedCents: t.expectedCents + r.expectedCents,
      receivedCents: t.receivedCents + r.receivedCents,
      outstandingCents: t.outstandingCents + r.aging.outstandingCents,
      overdueCount: t.overdueCount + (r.aging.overdue ? 1 : 0),
      overdueCents: t.overdueCents + (r.aging.overdue ? r.aging.outstandingCents : 0),
    }),
    { count: 0, expectedCents: 0, receivedCents: 0, outstandingCents: 0, overdueCount: 0, overdueCents: 0 },
  );
}

export interface RecordRemittanceInput {
  batchId: string;
  amountCents: number;
  receivedOn: string;
  bankReference: string;
  sharedTransfer?: boolean;
}

export interface RecordRemittanceResult {
  batchId: string;
  receiptId: string;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
  createdRecord: boolean;
}

export interface VoidReceiptInput {
  batchId: string;
  receiptId: string;
  reason: string;
}

export interface VoidReceiptResult {
  batchId: string;
  receiptId: string;
  expectedCents: number;
  receivedCents: number;
  status: RemittanceStatus;
  alreadyVoided: boolean;
}

/** YYYY-MM-DD that names a day that exists (2026-02-30 does not). */
export function isRealCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls an impossible day forward (Feb 30 → Mar 2) instead of failing.
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Today where the money moves. The browser's own "today" is wrong for this in
 * two directions: an ops user east of Mexico City is already on tomorrow, and
 * `toISOString()` is UTC, which is tomorrow from 18:00 local.
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

export type ReceivedOnProblem = 'required' | 'invalid' | 'future' | 'before_period';

/**
 * Why `receivedOn` would be rejected, or null if the server will take it.
 * `payPeriodStart` is the batch's own; like the server, the lower bound is
 * skipped when the record has no readable start date.
 */
export function receivedOnProblem(value: string, today: string, payPeriodStart?: string | null): ReceivedOnProblem | null {
  if (!value) return 'required';
  if (!isRealCalendarDate(value)) return 'invalid';
  // All sides are zero-padded YYYY-MM-DD, so string order is date order.
  if (value > today) return 'future';
  if (payPeriodStart && isRealCalendarDate(payPeriodStart) && value < payPeriodStart) return 'before_period';
  return null;
}

export type BankReferenceProblem = 'required' | 'too_long';

export function bankReferenceProblem(value: string): BankReferenceProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return 'required';
  if (trimmed.length > BANK_REFERENCE_MAX) return 'too_long';
  return null;
}

export type VoidReasonProblem = 'required' | 'too_long';

export function voidReasonProblem(value: string): VoidReasonProblem | null {
  const trimmed = value.trim();
  if (trimmed.length < VOID_REASON_MIN) return 'required';
  if (trimmed.length > VOID_REASON_MAX) return 'too_long';
  return null;
}

/**
 * Every `details.reason` the remittance callables send (RemittanceRefusalReason
 * in functions/src/payroll/remittance.ts; table in
 * docs/runbooks/payroll-remittances.md), mapped to the i18n key of the text ops
 * reads. The server's `message` is English and written for logs — it is never
 * shown. remittanceReasons.parity.test.ts reads the server's list and fails if
 * a reason is missing here or has no Spanish text.
 */
export const REMITTANCE_REASON_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'bank-reference-in-batch': 'remit_err_dup_batch',
  'bank-reference-in-other-batch': 'remit_err_dup_other',
  'input-invalid': 'remit_reason_input_invalid',
  'batch-id-invalid': 'remit_reason_batch_id_invalid',
  'amount-invalid': 'remit_reason_amount_invalid',
  'received-on-invalid-format': 'remit_reason_received_on_invalid_format',
  'received-on-not-a-date': 'remit_reason_received_on_not_a_date',
  'received-on-future': 'remit_reason_received_on_future',
  'received-on-before-pay-period': 'remit_reason_received_on_before_pay_period',
  'bank-reference-invalid': 'remit_reason_bank_reference_invalid',
  'shared-transfer-invalid': 'remit_reason_shared_transfer_invalid',
  'receipt-id-invalid': 'remit_reason_receipt_id_invalid',
  'void-reason-invalid': 'remit_reason_void_reason_invalid',
  'view-invalid': 'remit_reason_view_invalid',
  'employer-id-invalid': 'remit_reason_employer_id_invalid',
  'overdue-only-invalid': 'remit_reason_overdue_only_invalid',
  'grace-days-invalid': 'remit_reason_grace_days_invalid',
  'limit-invalid': 'remit_reason_limit_invalid',
  'cursor-invalid': 'remit_reason_cursor_invalid',
  'remittance-not-expected': 'remit_reason_remittance_not_expected',
  'remittance-not-found': 'remit_reason_remittance_not_found',
  'receipt-not-found': 'remit_reason_receipt_not_found',
});

/** What a failed remittance callable said, reduced to what the screen acts on. */
export interface RemittanceRefusal {
  /** `details.reason` when it is one this screen has words for, else null. */
  reason: string | null;
  /** Batches already holding the reference (the two duplicate reasons). */
  batchIds: string[];
  /** `details.today` (received-on-future), YYYY-MM-DD in Mexico City. */
  today: string | null;
  /** `details.payPeriodStart` (received-on-before-pay-period), YYYY-MM-DD. */
  payPeriodStart: string | null;
  /** An `already-exists` with no reason this screen knows: still a duplicate. */
  duplicate: boolean;
}

export function readRemittanceRefusal(err: unknown): RemittanceRefusal {
  const none: RemittanceRefusal = { reason: null, batchIds: [], today: null, payPeriodStart: null, duplicate: false };
  if (typeof err !== 'object' || err === null) return none;
  const { code, details } = err as { code?: unknown; details?: unknown };
  const d = (typeof details === 'object' && details !== null ? details : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const rawReason = str(d['reason']);
  return {
    reason: rawReason !== null && Object.prototype.hasOwnProperty.call(REMITTANCE_REASON_KEYS, rawReason) ? rawReason : null,
    batchIds: Array.isArray(d['batchIds']) ? d['batchIds'].filter((b): b is string => typeof b === 'string') : [],
    today: str(d['today']),
    payPeriodStart: str(d['payPeriodStart']),
    duplicate: typeof code === 'string' && code.includes('already-exists'),
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The words for a refusal, in the UI's language, or null when the server gave
 * no reason this screen knows — the caller then falls back to `friendlyError`.
 * Never returns the server's English `message`.
 */
export function remittanceRefusalText(refusal: RemittanceRefusal, t: Translate, locale: string): string | null {
  if (refusal.reason === null) return refusal.duplicate ? t('remit_err_dup') : null;
  return t(REMITTANCE_REASON_KEYS[refusal.reason], {
    batches: refusal.batchIds.join(', '),
    today: formatIsoDate(refusal.today ?? todayInMexicoCity(), locale),
    payPeriodStart: formatIsoDate(refusal.payPeriodStart, locale),
    referenceMax: BANK_REFERENCE_MAX,
    reasonMin: VOID_REASON_MIN,
    reasonMax: VOID_REASON_MAX,
    limitMax: REMITTANCE_LIMIT_MAX,
  });
}

/** `2026-09-15` → `15 sep 2026`. Anything that is not a real date comes back as-is. */
export function formatIsoDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const day = iso.slice(0, 10);
  if (!isRealCalendarDate(day)) return iso;
  // Rendered in UTC so a calendar date never slips a day in the viewer's zone.
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * An instant (`voidedAt`, `recordedAt`: ISO timestamps) → the calendar date it
 * was in Mexico City. A receipt voided at 19:00 on the 2nd in Mexico City is
 * already the 3rd in UTC; ops reads the ledger against a bank statement dated
 * in Mexico City, so that is the day shown — whatever zone the browser is in.
 */
export function formatInstantInMexicoCity(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return instant.toLocaleDateString(locale, {
    timeZone: REMITTANCE_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
