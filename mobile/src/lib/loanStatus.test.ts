/**
 * Keeps mobile's status vocabulary in agreement with the server's
 * (functions/src/loans/loanStatus.ts) and the web app's
 * (public-v2/src/lib/loanStatus.ts) — the same test-keeps-the-mirrors-honest
 * arrangement those two already use with each other.
 */
import { describe, expect, it } from 'vitest';

import {
  isPayableStatus,
  isRepaidStatus,
  LOAN_STATUS,
  PAYABLE_STATUSES,
  statusLabelKey,
} from './loanStatus';

describe('payable statuses', () => {
  it('matches the deductible set the server bills against: disbursed spellings + overdue + in_collections', () => {
    expect([...PAYABLE_STATUSES].sort()).toEqual(
      ['active', 'disbursed', 'in_collections', 'overdue'].sort()
    );
  });

  it('a pending or repaid loan is never payable', () => {
    expect(isPayableStatus(LOAN_STATUS.PENDING)).toBe(false);
    expect(isPayableStatus(LOAN_STATUS.REPAID)).toBe(false);
    expect(isPayableStatus('paid')).toBe(false);
  });

  it('non-strings are never payable', () => {
    expect(isPayableStatus(undefined)).toBe(false);
    expect(isPayableStatus(42)).toBe(false);
  });
});

describe('repaid statuses', () => {
  it('legacy aliases still read as repaid — historical docs must not resurface as owed', () => {
    for (const alias of ['paid', 'complete', 'completed', 'repaid']) {
      expect(isRepaidStatus(alias)).toBe(true);
    }
  });
});

describe('statusLabelKey', () => {
  it('collapses legacy repaid aliases onto the repaid label', () => {
    expect(statusLabelKey('paid')).toBe('loanStatus.repaid');
  });

  it('renders unknown for unrecognized server vocabulary instead of leaking it', () => {
    expect(statusLabelKey('some_future_status')).toBe('loanStatus.unknown');
    expect(statusLabelKey(undefined)).toBe('loanStatus.unknown');
  });

  it('every canonical status has a label key', () => {
    for (const status of Object.values(LOAN_STATUS)) {
      expect(statusLabelKey(status)).toBe(`loanStatus.${status}`);
    }
  });
});
