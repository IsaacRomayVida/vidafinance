import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHmac, timingSafeEqual } from 'crypto';

const WEBHOOK_SECRET_ENV = 'METAMAP_WEBHOOK_SECRET';

function verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

export const metamapWebhook = onRequest(
  { region: 'us-central1', cors: false, invoker: 'public' },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // Fail CLOSED if secret is missing — never accept unsigned requests.
    const secret = process.env[WEBHOOK_SECRET_ENV];
    if (!secret) {
      logger.error('METAMAP_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'webhook_not_configured' });
      return;
    }

    // firebase-functions v2 exposes req.rawBody for POST with JSON content-type.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
      ? (req as unknown as { rawBody: Buffer }).rawBody.toString('utf8')
      : JSON.stringify(req.body);
    const sig = (req.headers['x-metamap-signature'] ?? req.headers['X-Metamap-Signature']) as
      | string
      | undefined;
    if (!verifySignature(rawBody, sig, secret)) {
      logger.warn('Invalid MetaMap webhook signature', { ip: req.ip });
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const payload = req.body as { eventName?: string; [k: string]: unknown };
    const eventName = payload?.eventName;
    const db = getFirestore();

    try {
      if (eventName === 'verification.completed') {
        await handleVerificationCompleted(db, payload);
      } else if (eventName === 'document.signed') {
        await handleDocumentSigned(db, payload);
      } else {
        logger.info('Unhandled MetaMap event', { eventName });
      }

      await db.collection('webhookEvents').add({
        source: 'metamap',
        eventName: eventName ?? 'unknown',
        receivedAt: FieldValue.serverTimestamp(),
        payload,
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('MetaMap webhook processing failed', { err, eventName });
      res.status(500).json({ error: 'internal' });
    }
  }
);

async function handleVerificationCompleted(
  db: FirebaseFirestore.Firestore,
  payload: Record<string, unknown>
): Promise<void> {
  const identity = payload['identity'] as Record<string, unknown> | undefined;
  const verificationId =
    (identity?.['id'] as string | undefined) ?? (payload['verificationId'] as string | undefined);
  const status =
    (payload['status'] as string | undefined) ?? (identity?.['status'] as string | undefined);

  if (!verificationId) {
    logger.warn('verification.completed missing identity.id', { payload });
    return;
  }

  // limit(2), not limit(1), so an AMBIGUOUS match is detectable rather than
  // silently resolved. `metamapVerificationId` is written by the browser
  // (Onboarding.tsx) and is the only thing tying this verdict to an account —
  // and since requestLoan now treats `metamapStatus == 'verified'` as proof of
  // identity, whichever document this picks is the one that can borrow. Under
  // limit(1) two accounts claiming the same verificationId meant an arbitrary
  // one of them was marked verified: an attacker who learned a colleague's id
  // could put it on their own document and take the verdict from a real
  // verification they never sat. Fail CLOSED and mark neither — a stuck
  // verification is a support ticket, a wrongly granted one is a loan to
  // someone whose identity was never checked.
  const snap = await db
    .collectionGroup('employees')
    .where('metamapVerificationId', '==', verificationId)
    .limit(2)
    .get();

  if (snap.empty) {
    logger.warn('verification.completed: no employee with verificationId', { verificationId });
    return;
  }

  if (snap.size > 1) {
    logger.error('verification.completed: verificationId claimed by multiple employees', {
      verificationId,
      employeeIds: snap.docs.map((d) => d.id),
    });
    return;
  }

  const doc = snap.docs[0];
  const existingVerifiedAt = doc.data()['metamapVerifiedAt'] ?? null;
  await doc.ref.update({
    metamapStatus: status ?? null,
    metamapVerifiedAt: status === 'verified' ? FieldValue.serverTimestamp() : existingVerifiedAt,
    metamapLastEventAt: FieldValue.serverTimestamp(),
  });
}

async function handleDocumentSigned(
  db: FirebaseFirestore.Firestore,
  payload: Record<string, unknown>
): Promise<void> {
  const metadata = payload['metadata'] as Record<string, unknown> | undefined;
  const loanId =
    (payload['loanId'] as string | undefined) ?? (metadata?.['loanId'] as string | undefined);

  if (!loanId) {
    logger.warn('document.signed missing loanId', { payload });
    return;
  }

  await db.collection('loans').doc(loanId).update({
    contractSignedAt: FieldValue.serverTimestamp(),
    contractMetamapDocumentId: (payload['documentId'] as string | undefined) ?? null,
    contractStatus: 'signed',
  });
}
