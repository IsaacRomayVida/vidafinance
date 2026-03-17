import { admin, db } from '../lib/firebase';
import { redis } from '../lib/redis';

// ── Types ──────────────────────────────────────────────────────────────────

export interface IncomingPayment {
  id: string;
  referenceNumber?: string;
  senderClabe?: string;
  amount: number;
  receivedAt: string; // ISO-8601
  rawPayload?: Record<string, unknown>;
}

export type MatchStrategy = 'reference_match' | 'clabe_amount_match' | 'manual_review';

export interface ReconciliationResult {
  paymentId: string;
  strategy: MatchStrategy;
  loanId?: string;
  matched: boolean;
}

// ── Strategy 1: Match by STP reference number ──────────────────────────────

async function matchByReference(payment: IncomingPayment): Promise<ReconciliationResult | null> {
  if (!payment.referenceNumber) return null;

  const snap = await db
    .collection('loans')
    .where('stpReferenceNumber', '==', payment.referenceNumber)
    .where('status', 'in', ['disbursed', 'overdue'])
    .limit(1)
    .get();

  if (snap.empty) return null;

  return {
    paymentId: payment.id,
    strategy: 'reference_match',
    loanId: snap.docs[0].id,
    matched: true,
  };
}

// ── Strategy 2: Match by employer CLABE + amount ───────────────────────────

async function matchByClabeAmount(payment: IncomingPayment): Promise<ReconciliationResult | null> {
  if (!payment.senderClabe) return null;

  const snap = await db
    .collection('loans')
    .where('employerClabe', '==', payment.senderClabe)
    .where('repaymentAmount', '==', payment.amount)
    .where('status', 'in', ['disbursed', 'overdue'])
    .limit(1)
    .get();

  if (snap.empty) return null;

  return {
    paymentId: payment.id,
    strategy: 'clabe_amount_match',
    loanId: snap.docs[0].id,
    matched: true,
  };
}

// ── Strategy 3: Flag for manual review ─────────────────────────────────────

function flagForManualReview(payment: IncomingPayment): ReconciliationResult {
  return {
    paymentId: payment.id,
    strategy: 'manual_review',
    matched: false,
  };
}

// ── Core reconciliation function ───────────────────────────────────────────

export async function reconcilePayment(payment: IncomingPayment): Promise<ReconciliationResult> {
  // Try strategies in priority order
  const byRef = await matchByReference(payment);
  if (byRef) {
    await applyMatch(byRef, payment);
    return byRef;
  }

  const byClabe = await matchByClabeAmount(payment);
  if (byClabe) {
    await applyMatch(byClabe, payment);
    return byClabe;
  }

  // No match — flag for manual review
  const review = flagForManualReview(payment);
  await db.collection('manual_review').add({
    paymentId: payment.id,
    referenceNumber: payment.referenceNumber ?? null,
    senderClabe: payment.senderClabe ?? null,
    amount: payment.amount,
    receivedAt: payment.receivedAt,
    rawPayload: payment.rawPayload ?? null,
    flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'pending',
  });

  return review;
}

// ── Apply a successful match ───────────────────────────────────────────────

async function applyMatch(result: ReconciliationResult, payment: IncomingPayment): Promise<void> {
  const loanId = result.loanId!;
  const loanRef = db.collection('loans').doc(loanId);

  // Atomic transaction: update loan + employer balance
  await db.runTransaction(async (tx) => {
    const loanSnap = await tx.get(loanRef);
    if (!loanSnap.exists) throw new Error(`Loan ${loanId} not found`);

    const loanData = loanSnap.data()!;

    tx.update(loanRef, {
      status: 'repaid',
      repaidAt: admin.firestore.Timestamp.now(),
      repaidAmount: payment.amount,
      reconciliationStrategy: result.strategy,
      reconciliationPaymentId: payment.id,
    });

    // Update employer outstanding balance if employerId exists
    const employerId = loanData['employerId'] as string | undefined;
    if (employerId) {
      const employerRef = db.collection('employers').doc(employerId);
      tx.update(employerRef, {
        outstandingBalance: admin.firestore.FieldValue.increment(-payment.amount),
      });
    }
  });

  // Push notification job to Redis
  const loanSnap = await loanRef.get();
  const userId = loanSnap.data()?.['userId'] as string | undefined;

  await redis.lpush(
    'jobs:notifications',
    JSON.stringify({
      type: 'loan_repaid',
      userId: userId ?? '',
      loanId,
      amount: payment.amount,
    }),
  );
}
