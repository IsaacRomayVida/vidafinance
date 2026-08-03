import {
  LOAN_STATUS,
  ALL_LOAN_STATUSES,
  REPAID_STATUSES,
  DISBURSED_STATUSES,
  POST_DISBURSEMENT_STATUSES,
  DEFAULT_STATUSES,
  isRepaidStatus,
  isDisbursedStatus,
  isDefaultStatus,
  isKnownLoanStatus,
  isCreditRestoringRepayment,
} from '../loanStatus';

describe('loanStatus — canonical vocabulary', () => {
  it('recognizes every canonical status as known', () => {
    for (const status of ALL_LOAN_STATUSES) {
      expect(isKnownLoanStatus(status)).toBe(true);
    }
  });

  it('rejects an unknown/typo status', () => {
    expect(isKnownLoanStatus('payed')).toBe(false);
    expect(isKnownLoanStatus('')).toBe(false);
    expect(isKnownLoanStatus(undefined)).toBe(false);
  });

  it('treats the canonical repaid spelling and every legacy alias as repaid', () => {
    expect(isRepaidStatus(LOAN_STATUS.REPAID)).toBe(true);
    expect(isRepaidStatus('paid')).toBe(true);
    expect(isRepaidStatus('complete')).toBe(true);
    expect(isRepaidStatus('completed')).toBe(true);
  });

  it('does not treat an in-progress status as repaid', () => {
    for (const status of [LOAN_STATUS.PENDING, LOAN_STATUS.APPROVED, LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE]) {
      expect(isRepaidStatus(status)).toBe(false);
    }
  });

  it('treats both live disbursement spellings as disbursed', () => {
    expect(isDisbursedStatus(LOAN_STATUS.ACTIVE)).toBe(true);
    expect(isDisbursedStatus(LOAN_STATUS.DISBURSED)).toBe(true);
    expect(isDisbursedStatus(LOAN_STATUS.APPROVED)).toBe(false);
  });

  it('DEFAULT_STATUSES covers overdue, in_collections, and written_off only', () => {
    expect(new Set(DEFAULT_STATUSES)).toEqual(
      new Set([LOAN_STATUS.OVERDUE, LOAN_STATUS.IN_COLLECTIONS, LOAN_STATUS.WRITTEN_OFF])
    );
    expect(isDefaultStatus(LOAN_STATUS.ACTIVE)).toBe(false);
  });

  it('POST_DISBURSEMENT_STATUSES is a superset of DISBURSED_STATUSES and REPAID_STATUSES', () => {
    for (const s of DISBURSED_STATUSES) expect(POST_DISBURSEMENT_STATUSES).toContain(s);
    for (const s of REPAID_STATUSES) expect(POST_DISBURSEMENT_STATUSES).toContain(s);
  });

  // The trigger owns the canonical 'repaid' transition only. 'paid' is
  // payment-server's spelling, and it restores the employee's availableCredit
  // itself in the same transaction — counting it here too would double-credit.
  describe('isCreditRestoringRepayment', () => {
    it.each([
      ['active', 'repaid'],
      ['disbursed', 'repaid'],
      ['overdue', 'repaid'],
    ])('fires when moving from %s to %s', (before, after) => {
      expect(isCreditRestoringRepayment(before, after)).toBe(true);
    });

    it.each([
      ['pending', 'approved'],
      ['approved', 'active'],
      ['active', 'overdue'],
      ['repaid', 'repaid'], // already repaid — must not re-fire
      ['active', 'paid'], // payment-server's path; it counters this itself
      ['approved', 'paid'], // the dead literal the old gate required
    ])('does not fire when moving from %s to %s', (before, after) => {
      expect(isCreditRestoringRepayment(before, after)).toBe(false);
    });
  });
});
