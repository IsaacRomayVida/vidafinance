import { describe, expect, it } from 'vitest';
import {
  DEDUCTIBLE_STATUSES,
  DEDUCTION_REPORT_STATUSES,
  isActiveDeductionStatus,
  isRepaidStatus,
} from './loanStatus';

// Mirrors DISBURSED_STATUSES / REPAID_STATUSES / LOAN_STATUS.OVERDUE in
// functions/src/loans/loanStatus.ts. public-v2 and functions are separate
// TypeScript projects with no shared package (see payFrequencies.ts), so this
// list can't import that one; this test is what keeps the two in agreement.
//
// This is the regression guard for the employer deduction report bug: the
// report's Firestore query filtered on ['active', 'paid'] — 'paid' is a dead
// spelling no write path has ever produced, and 'disbursed'/'overdue' (both
// live) were missing entirely, so manually-disbursed and overdue loans never
// appeared and never got deducted.
const STATUSES_FUNCTIONS_TREATS_AS_HAVING_A_DEDUCTION = [
  'active',
  'disbursed',
  'overdue',
  'in_collections',
  'repaid',
  'paid',
  'complete',
  'completed',
];

// Mirrors DEDUCTIBLE_STATUSES in functions/src/loans/loanStatus.ts — the set
// processPayroll's loan lookup queries on. THIS is the list that has to agree
// with the server, and the one that didn't: this report billed the employer
// for `overdue` loans while the server's lookup was a hardcoded
// ['active', 'disbursed'], so the employer withheld the deduction from the
// paycheck and the server credited nothing against the debt.
const STATUSES_FUNCTIONS_WILL_DEDUCT_AGAINST = [
  'active',
  'disbursed',
  'overdue',
  'in_collections',
];

describe('deduction report status vocabulary', () => {
  it('matches, in both directions, every status functions/src/loans/loanStatus.ts says has a deduction', () => {
    expect([...DEDUCTION_REPORT_STATUSES].sort()).toEqual(
      [...STATUSES_FUNCTIONS_TREATS_AS_HAVING_A_DEDUCTION].sort(),
    );
  });

  it('includes disbursed, so a manually-disbursed loan is not invisible to the employer', () => {
    expect(DEDUCTION_REPORT_STATUSES).toContain('disbursed');
  });

  it('includes overdue', () => {
    expect(DEDUCTION_REPORT_STATUSES).toContain('overdue');
  });

  it('stays under the Firestore "in" query cap of 30 values', () => {
    expect(DEDUCTION_REPORT_STATUSES.length).toBeLessThanOrEqual(30);
  });
});

describe('deductible status vocabulary', () => {
  it('matches, in both directions, the set processPayroll queries loans on', () => {
    expect([...DEDUCTIBLE_STATUSES].sort()).toEqual(
      [...STATUSES_FUNCTIONS_WILL_DEDUCT_AGAINST].sort(),
    );
  });

  // The defect, stated directly: anything this report bills the employer for
  // and still expects a payment on MUST be a status the server will accept a
  // deduction against. Otherwise the money leaves the paycheck and lands
  // nowhere.
  it('accepts every status this report shows as still owing', () => {
    const stillOwing = DEDUCTION_REPORT_STATUSES.filter((s) => !isRepaidStatus(s));
    expect([...stillOwing].sort()).toEqual([...DEDUCTIBLE_STATUSES].sort());
  });

  it('excludes every repaid spelling — there is nothing left to deduct', () => {
    for (const s of ['repaid', 'paid', 'complete', 'completed']) {
      expect(DEDUCTIBLE_STATUSES).not.toContain(s);
    }
  });

  it('excludes statuses where no funds ever went out', () => {
    for (const s of ['pending', 'under_review', 'approved', 'disbursement_queued']) {
      expect(DEDUCTIBLE_STATUSES).not.toContain(s);
    }
  });

  it('stays under the Firestore "in" query cap of 30 values', () => {
    expect(DEDUCTIBLE_STATUSES.length).toBeLessThanOrEqual(30);
  });
});

describe('isActiveDeductionStatus', () => {
  it('is true for active, disbursed, overdue and in_collections', () => {
    expect(isActiveDeductionStatus('active')).toBe(true);
    expect(isActiveDeductionStatus('disbursed')).toBe(true);
    expect(isActiveDeductionStatus('overdue')).toBe(true);
    expect(isActiveDeductionStatus('in_collections')).toBe(true);
  });

  it('is false for repaid or unknown statuses', () => {
    expect(isActiveDeductionStatus('repaid')).toBe(false);
    expect(isActiveDeductionStatus('paid')).toBe(false);
    expect(isActiveDeductionStatus(undefined)).toBe(false);
  });
});

describe('isRepaidStatus', () => {
  it('is true for the canonical spelling and every dead legacy alias', () => {
    expect(isRepaidStatus('repaid')).toBe(true);
    expect(isRepaidStatus('paid')).toBe(true);
    expect(isRepaidStatus('complete')).toBe(true);
    expect(isRepaidStatus('completed')).toBe(true);
  });

  it('is false for active/disbursed/overdue', () => {
    expect(isRepaidStatus('active')).toBe(false);
    expect(isRepaidStatus('disbursed')).toBe(false);
    expect(isRepaidStatus('overdue')).toBe(false);
  });
});
