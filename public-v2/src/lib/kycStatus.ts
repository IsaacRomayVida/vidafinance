/**
 * The kycStatus values a client may write onto its own employees/{uid} at
 * registration — firestore.rules' noSelfAssignedVerification() allowlist,
 * mirrored. The identity verdict itself is server-owned (metamapStatus, set by
 * the MetaMap webhook), so 'approved' is never something the browser can say
 * about itself.
 */
export type ClientKycStatus = 'not_started' | 'pending_review' | 'rejected';

/**
 * Onboarding's dev-build test bypass (testBypassAllowed) shows the step as
 * 'approved' locally. Persisting that value made the rules deny the
 * employees/{uid} create — registration's final write — so the bypass flow
 * could never finish (AUDIT_EMPLOYER_PATH.md E2's failure mode, on a new
 * field). The UI may display 'approved'; what is written is clamped to the
 * allowlist, as 'pending_review' — the server verifies, the client waits.
 */
export function clientWritableKycStatus(
  status: ClientKycStatus | 'approved',
): ClientKycStatus {
  return status === 'approved' ? 'pending_review' : status;
}
