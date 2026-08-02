import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';

import type { PayFrequency } from './calculateNextPayrollDate';

/**
 * Where a borrower's pay frequency came from.
 *
 * This is returned alongside the frequency itself because the two callers that
 * need it — the disbursement path and the borrower-facing quote — must be able
 * to tell an inferred cadence from a known one. A quote that states an inferred
 * deduction date with the same confidence as a real one is the failure this
 * exists to prevent (#424).
 *
 *   'loan_snapshot'   — the loan carried a borrowerSnapshot.payFrequency.
 *   'employee_record' — read from employees/{uid}, written at onboarding.
 *   'default_monthly' — nothing was readable; 'monthly' was assumed.
 */
export type PayFrequencySource = 'loan_snapshot' | 'employee_record' | 'default_monthly';

export interface ResolvedPayFrequency {
  frequency: PayFrequency;
  source: PayFrequencySource;
}

const VALID_FREQUENCIES: readonly PayFrequency[] = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

function asPayFrequency(value: unknown): PayFrequency | null {
  return typeof value === 'string' && (VALID_FREQUENCIES as readonly string[]).includes(value)
    ? (value as PayFrequency)
    : null;
}

/**
 * Resolves the pay frequency that governs when a loan is deducted.
 *
 * Order is deliberate. `borrowerSnapshot` is tried first because that is what
 * markLoanDisbursed has always read, and honouring it keeps behaviour identical
 * for any loan that does carry one. In practice none do — repo-wide, nothing
 * writes that field onto a loan document; the name belongs to the underwriting
 * queue's job payload (#431). So until now every loan fell through to the
 * 'monthly' default and every borrower was scheduled for month-end regardless
 * of how they are actually paid.
 *
 * `employees/{uid}` is the record that has held the real answer the whole time:
 * Onboarding writes `payFrequency` there alongside salary and CLABE.
 *
 * A read failure degrades to 'monthly' rather than throwing. Disbursement of an
 * approved loan must not be blocked by an unreadable employee document — but
 * the caller is told, via `source`, that the date it got is an assumption.
 */
export async function resolvePayFrequency(
  uid: string | undefined,
  loanBorrowerSnapshot?: Record<string, unknown>
): Promise<ResolvedPayFrequency> {
  const fromSnapshot = asPayFrequency(loanBorrowerSnapshot?.['payFrequency']);
  if (fromSnapshot) {
    return { frequency: fromSnapshot, source: 'loan_snapshot' };
  }

  if (!uid) {
    return { frequency: 'monthly', source: 'default_monthly' };
  }

  try {
    const snap = await getFirestore().collection('employees').doc(uid).get();
    const fromRecord = asPayFrequency(snap.data()?.['payFrequency']);
    if (fromRecord) {
      return { frequency: fromRecord, source: 'employee_record' };
    }
  } catch (e: unknown) {
    logger.warn('Could not read employee pay frequency; assuming monthly', {
      uid,
      error: (e as Error).message,
      service: 'functions',
    });
  }

  return { frequency: 'monthly', source: 'default_monthly' };
}
