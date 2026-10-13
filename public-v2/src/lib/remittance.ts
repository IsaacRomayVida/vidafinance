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
}

export interface ListRemittancesResult {
  asOf: string;
  graceDays: number;
  truncated: boolean;
  totals: {
    count: number;
    expectedCents: number;
    receivedCents: number;
    outstandingCents: number;
    overdueCount: number;
    overdueCents: number;
  };
  remittances: Remittance[];
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

export type ReceivedOnProblem = 'required' | 'invalid' | 'future';

/** Why `receivedOn` would be rejected, or null if the server will take it. */
export function receivedOnProblem(value: string, today: string): ReceivedOnProblem | null {
  if (!value) return 'required';
  if (!isRealCalendarDate(value)) return 'invalid';
  // Both sides are zero-padded YYYY-MM-DD, so string order is date order.
  if (value > today) return 'future';
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
 * What a failed remittance callable is telling ops, reduced to the cases the
 * screen words differently. Anything else falls through to `friendlyError`.
 */
export type RemittanceErrorKind =
  | { kind: 'duplicate_in_batch' }
  | { kind: 'duplicate_in_other_batch'; batchIds: string[] }
  | { kind: 'duplicate' }
  | { kind: 'invalid'; detail: string }
  | { kind: 'not_found' }
  | { kind: 'other' };

export function classifyRemittanceError(err: unknown): RemittanceErrorKind {
  if (typeof err !== 'object' || err === null) return { kind: 'other' };
  const { code, details, message } = err as { code?: unknown; details?: unknown; message?: unknown };
  const c = typeof code === 'string' ? code : '';

  if (c.includes('already-exists')) {
    const d = (typeof details === 'object' && details !== null ? details : {}) as {
      reason?: unknown;
      batchIds?: unknown;
    };
    const batchIds = Array.isArray(d.batchIds) ? d.batchIds.filter((b): b is string => typeof b === 'string') : [];
    if (d.reason === 'bank-reference-in-batch') return { kind: 'duplicate_in_batch' };
    if (d.reason === 'bank-reference-in-other-batch') return { kind: 'duplicate_in_other_batch', batchIds };
    return { kind: 'duplicate' };
  }
  if (c.includes('invalid-argument')) {
    return { kind: 'invalid', detail: typeof message === 'string' ? message : '' };
  }
  if (c.includes('not-found')) return { kind: 'not_found' };
  return { kind: 'other' };
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
