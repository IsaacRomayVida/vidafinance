// ── Admin-editable loan fee rate: two-person change control (#389) ────────────
//
// The fee rate is the highest-stakes knob in the product: one field reprices
// every future loan and lands on a CONDUSEF-regulated contract. Nobody changes
// it alone and nobody changes it silently. The flow is:
//
//   proposeLoanConfigChange({ feeRate, reason })  -> a pending proposal, no
//                                                    effect on pricing
//   approveLoanConfigChange({ proposalId })       -> by a DIFFERENT uid, within
//                                                    the TTL; only now does
//                                                    config/loan change
//
// Both steps append to audit_log inside the same transaction as the mutation,
// so a change that cannot be logged does not happen.
//
// ROLE DECISION (#389, verified 2026-08-02): these are gated on
// ['admin', 'super_admin'], NOT ['super_admin'] alone. Two reasons, both
// verified against the source rather than assumed:
//
//   1. `super_admin` is not grantable through any API. adminClaims.ts's
//      AdminClaimSchema enum is ['employee','employer_admin','ops','admin'] and
//      there is an explicit test asserting 'super_admin' is rejected
//      (adminClaims.test.ts, "throws invalid-argument when role is
//      super_admin"). Gating on it alone would make the fee rate unchangeable
//      by anyone until an operator runs the new out-of-band
//      scripts/bootstrap-super-admin.js twice — for two DIFFERENT people, since
//      proposer != approver. A pricing control nobody can operate is not a
//      safe pricing control.
//   2. It would not actually be a stronger gate today. withAuth() honours the
//      legacy `admin: true` boolean claim for any required role in
//      ADMIN_ROLES (= admin | super_admin | ops), so a legacy-admin token
//      satisfies ['super_admin'] exactly as it satisfies ['admin'].
//
// Tightening to ['super_admin'] is a one-line change here once
// bootstrap-super-admin.js has been run for the intended principals AND the
// legacy `admin: true` bypass in authMiddleware.ts is retired.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';

import { withAuth } from '../middleware/authMiddleware';
import { withErrorHandling } from '../utils/errorHandler';
import { AUDIT_LOG_COLLECTION, buildAuditLogDocument } from '../utils/auditLog';
import {
  LOAN_CONFIG_COLLECTION,
  LOAN_CONFIG_DOC_ID,
  LOAN_CONFIG_DOC_PATH,
  MAX_ALLOWED_FEE_RATE,
  MIN_ALLOWED_FEE_RATE,
  assertValidFeeRate,
  getSeedLoanConfigValues,
} from './loanConfig';

/** Subcollection of config/loan. Denied to all clients by firestore.rules. */
export const LOAN_CONFIG_PROPOSALS_SUBCOLLECTION = 'proposals';

/**
 * A proposal that nobody approved goes stale: the rate it was reasoned about,
 * the market it was priced for and often the proposer's employment have all
 * moved on. Approving a week-old proposal is approving a decision you no longer
 * have the context for, so proposals die on their own after 24h.
 */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a real justification, short enough not to be a document store. */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 1000;

const ProposeSchema = z.object({
  feeRate: z.number().finite(),
  // MANDATORY. An unexplained repricing is indistinguishable from an attack in
  // the audit log six months later, so there is no default and no empty string.
  reason: z.string().trim().min(MIN_REASON_LENGTH).max(MAX_REASON_LENGTH),
});

const ApproveSchema = z.object({
  proposalId: z.string().trim().min(1),
});

export type ProposeLoanConfigChangeInput = z.infer<typeof ProposeSchema>;
export type ApproveLoanConfigChangeInput = z.infer<typeof ApproveSchema>;

export interface ProposeLoanConfigChangeResult {
  proposalId: string;
  currentFeeRate: number;
  proposedFeeRate: number;
  expiresAt: string;
}

export interface ApproveLoanConfigChangeResult {
  proposalId: string;
  previousFeeRate: number;
  feeRate: number;
}

export type ProposalStatus = 'pending' | 'approved';

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', parsed.error.issues[0]?.message ?? 'Invalid input');
  }
  return parsed.data;
}

/**
 * The live rate as stored, or the compile-time seed when config/loan has never
 * been written. Bounds are re-asserted here so a live document that has drifted
 * out of range (console edit, backup restore) cannot be used as the "before"
 * value of a change that would then look legitimate in the audit log.
 */
function readLiveFeeRate(
  snapshot: { exists: boolean; data(): FirebaseFirestore.DocumentData | undefined } | undefined
): number {
  if (!snapshot?.exists) return getSeedLoanConfigValues().feeRate;
  const stored = snapshot.data()?.['feeRate'];
  return assertValidFeeRate(stored, `Live loan config at ${LOAN_CONFIG_DOC_PATH}`);
}

/**
 * Bounds enforcement on the WRITE side. Rejects with invalid-argument (a caller
 * error) rather than letting LoanConfigError bubble up as a 500 — the caller
 * needs to know their number was refused and why.
 */
function assertProposableFeeRate(feeRate: number): number {
  if (feeRate < MIN_ALLOWED_FEE_RATE || feeRate > MAX_ALLOWED_FEE_RATE) {
    throw new HttpsError(
      'invalid-argument',
      `feeRate must be between ${MIN_ALLOWED_FEE_RATE} and ${MAX_ALLOWED_FEE_RATE} ` +
        `(received ${feeRate}). These bounds are compile-time constants and cannot be changed through this API.`
    );
  }
  return feeRate;
}

// ── proposeLoanConfigChange ──────────────────────────────────────────────────
// Records an intent. Changes NOTHING about what borrowers are quoted.

export const proposeLoanConfigChange = onCall(
  { enforceAppCheck: true },
  withAuth<ProposeLoanConfigChangeInput, ProposeLoanConfigChangeResult>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'proposeLoanConfigChange', uid: auth.uid }, async () => {
        const { feeRate, reason } = parseOrThrow(ProposeSchema, data);
        assertProposableFeeRate(feeRate);

        const db = getFirestore();
        const now = Timestamp.now();
        const expiresAt = Timestamp.fromMillis(now.toMillis() + PROPOSAL_TTL_MS);

        const configRef = db.collection(LOAN_CONFIG_COLLECTION).doc(LOAN_CONFIG_DOC_ID);
        const proposalRef = configRef.collection(LOAN_CONFIG_PROPOSALS_SUBCOLLECTION).doc();

        const currentFeeRate = readLiveFeeRate(await configRef.get());

        if (currentFeeRate === feeRate) {
          throw new HttpsError(
            'failed-precondition',
            `feeRate is already ${feeRate}; nothing to change.`
          );
        }

        // Proposal and audit record commit together. A proposal that cannot be
        // logged never becomes approvable.
        await db.runTransaction(async (txn) => {
          txn.set(proposalRef, {
            status: 'pending' satisfies ProposalStatus,
            currentFeeRate,
            proposedFeeRate: feeRate,
            reason,
            proposedBy: auth.uid,
            proposedByEmail: auth.email ?? null,
            proposedAt: now,
            expiresAt,
            approvedBy: null,
            approvedByEmail: null,
            approvedAt: null,
          });
          txn.set(
            db.collection(AUDIT_LOG_COLLECTION).doc(),
            buildAuditLogDocument(
              {
                action: 'config.proposeLoanConfigChange',
                actorUid: auth.uid,
                actorRole: auth.role,
                actorEmail: auth.email ?? null,
                targetId: proposalRef.id,
                before: { feeRate: currentFeeRate },
                after: { feeRate },
                meta: {
                  entityType: 'loanConfigProposal',
                  reason,
                  expiresAt: expiresAt.toDate().toISOString(),
                },
              },
              now
            )
          );
        });

        return {
          proposalId: proposalRef.id,
          currentFeeRate,
          proposedFeeRate: feeRate,
          expiresAt: expiresAt.toDate().toISOString(),
        };
      })
  )
);

// ── approveLoanConfigChange ──────────────────────────────────────────────────
// The ONLY writer of config/loan. Everything it checks — second person, TTL,
// single use, bounds — is re-checked inside the transaction, because all four
// are races otherwise: two approvers clicking at once, an approval landing a
// millisecond after expiry, the same proposal replayed.

export const approveLoanConfigChange = onCall(
  { enforceAppCheck: true },
  withAuth<ApproveLoanConfigChangeInput, ApproveLoanConfigChangeResult>(
    ['admin', 'super_admin'],
    async (data, auth) =>
      withErrorHandling({ functionName: 'approveLoanConfigChange', uid: auth.uid }, async () => {
        const { proposalId } = parseOrThrow(ApproveSchema, data);

        const db = getFirestore();
        const now = Timestamp.now();

        const configRef = db.collection(LOAN_CONFIG_COLLECTION).doc(LOAN_CONFIG_DOC_ID);
        const proposalRef = configRef
          .collection(LOAN_CONFIG_PROPOSALS_SUBCOLLECTION)
          .doc(proposalId);

        const result = await db.runTransaction(async (txn) => {
          const proposalSnap = await txn.get(proposalRef);
          if (!proposalSnap.exists) {
            throw new HttpsError('not-found', 'Proposal not found');
          }
          const proposal = proposalSnap.data() ?? {};

          if (proposal['status'] !== 'pending') {
            throw new HttpsError(
              'failed-precondition',
              `Proposal is already ${String(proposal['status'])} and cannot be approved again.`
            );
          }

          // Two-person rule, enforced on uid — not on email, not on role, and
          // never on anything the client sends. This is the whole control.
          if (proposal['proposedBy'] === auth.uid) {
            throw new HttpsError(
              'permission-denied',
              'A loan config change must be approved by someone other than its proposer.'
            );
          }

          const expiresAt = proposal['expiresAt'] as Timestamp | undefined;
          if (!expiresAt || typeof expiresAt.toMillis !== 'function') {
            throw new HttpsError('failed-precondition', 'Proposal is malformed (no expiry).');
          }
          if (expiresAt.toMillis() <= now.toMillis()) {
            throw new HttpsError(
              'deadline-exceeded',
              'Proposal has expired. Raise a new one if the change is still intended.'
            );
          }

          // Re-validate against the CURRENT code bounds, not the ones in force
          // when the proposal was raised: if the ceiling was lowered in between,
          // the old proposal must not be able to sail through it.
          const proposedFeeRate = proposal['proposedFeeRate'];
          if (typeof proposedFeeRate !== 'number' || !Number.isFinite(proposedFeeRate)) {
            throw new HttpsError(
              'failed-precondition',
              'Proposal is malformed (proposedFeeRate is not a finite number).'
            );
          }
          if (proposedFeeRate < MIN_ALLOWED_FEE_RATE || proposedFeeRate > MAX_ALLOWED_FEE_RATE) {
            throw new HttpsError(
              'failed-precondition',
              `Proposed feeRate ${proposedFeeRate} is outside the currently permitted range ` +
                `[${MIN_ALLOWED_FEE_RATE}, ${MAX_ALLOWED_FEE_RATE}]. Raise a new proposal.`
            );
          }

          const previousFeeRate = readLiveFeeRate(await txn.get(configRef));

          txn.set(
            configRef,
            {
              feeRate: proposedFeeRate,
              updatedAt: now,
              updatedBy: auth.uid,
            },
            { merge: true }
          );

          txn.update(proposalRef, {
            status: 'approved' satisfies ProposalStatus,
            approvedBy: auth.uid,
            approvedByEmail: auth.email ?? null,
            approvedAt: now,
            appliedFromFeeRate: previousFeeRate,
          });

          txn.set(
            db.collection(AUDIT_LOG_COLLECTION).doc(),
            buildAuditLogDocument(
              {
                action: 'config.approveLoanConfigChange',
                actorUid: auth.uid,
                actorRole: auth.role,
                actorEmail: auth.email ?? null,
                targetId: proposalId,
                before: { feeRate: previousFeeRate },
                after: { feeRate: proposedFeeRate },
                meta: {
                  entityType: 'loanConfig',
                  reason: proposal['reason'] ?? null,
                  proposedBy: proposal['proposedBy'] ?? null,
                },
              },
              now
            )
          );

          return { proposalId, previousFeeRate, feeRate: proposedFeeRate };
        });

        return result;
      })
  )
);
