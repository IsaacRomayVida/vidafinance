import { describe, expect, it } from 'vitest';
import { clientWritableKycStatus } from './kycStatus';

// firestore.rules noSelfAssignedVerification(): the only kycStatus values a
// self-registration create may carry. Kept literal here on purpose — this test
// is the guard that the helper never emits anything outside it.
const RULES_ALLOWED = ['not_started', 'pending_review', 'rejected'];

describe('clientWritableKycStatus', () => {
  it("never persists 'approved' — the rules deny the registration write if it does", () => {
    expect(clientWritableKycStatus('approved')).toBe('pending_review');
  });

  it('passes the rules-allowed values through unchanged', () => {
    for (const s of ['not_started', 'pending_review', 'rejected'] as const) {
      expect(clientWritableKycStatus(s)).toBe(s);
    }
  });

  it('only ever emits a value the rules accept', () => {
    for (const s of ['not_started', 'pending_review', 'rejected', 'approved'] as const) {
      expect(RULES_ALLOWED).toContain(clientWritableKycStatus(s));
    }
  });
});
