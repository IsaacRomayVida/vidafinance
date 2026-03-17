import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { admin, db } from '../lib/firebase';
import { redis } from '../lib/redis';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Call a Firebase Cloud Function via HTTP.
 * Uses FIREBASE_FUNCTIONS_URL env var as base (e.g. https://us-central1-<project>.cloudfunctions.net).
 */
async function callFirebaseFunction(name: string, payload: Record<string, unknown>): Promise<void> {
  const baseUrl = process.env.FIREBASE_FUNCTIONS_URL;
  if (!baseUrl) {
    console.warn(`[payment-server] FIREBASE_FUNCTIONS_URL not set — skipping ${name} call`);
    return;
  }
  await axios.post(`${baseUrl}/${name}`, payload, {
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.INTERNAL_API_SECRET
        ? { 'x-internal-secret': process.env.INTERNAL_API_SECRET }
        : {}),
    },
    timeout: 30_000,
  });
}

// ── POST /webhooks/stp ───────────────────────────────────────────────────────

interface StpWebhookBody {
  id?: number | string;
  folioOrigen?: string;
  estado?: string;
  claveRastreo?: string;
  monto?: number;
  [key: string]: unknown;
}

router.post('/stp', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as StpWebhookBody;
  const { id, folioOrigen, estado, claveRastreo, monto } = body;

  console.log(`[payment-server] STP webhook received: estado=${estado} folio=${folioOrigen}`);

  if (!folioOrigen) {
    res.status(400).json({ error: 'Missing folioOrigen' });
    return;
  }

  try {
    const disbQuery = await db
      .collection('disbursements')
      .where('stpFolioOrigen', '==', folioOrigen)
      .limit(1)
      .get();

    if (disbQuery.empty) {
      console.warn(`[payment-server] STP webhook: no disbursement found for folio ${folioOrigen}`);
      res.json({ ok: true, warning: 'disbursement_not_found' });
      return;
    }

    const disbDoc = disbQuery.docs[0];
    const loanId = disbDoc.id;
    const disbData = disbDoc.data();

    if (estado === 'LQ') {
      // Payment liquidated (confirmed) — mark disbursement and call Cloud Function
      await disbDoc.ref.update({
        status: 'confirmed',
        stpTransactionId: String(id ?? ''),
        stpClaveRastreo: claveRastreo ?? '',
        confirmedAt: admin.firestore.Timestamp.now(),
      });

      await callFirebaseFunction('markLoanDisbursed', {
        loanId,
        stpTransactionId: String(id ?? ''),
        stpClaveRastreo: claveRastreo ?? '',
        disbursedAmount: monto ?? disbData['amount'],
        disbursedAt: new Date().toISOString(),
      });

      console.log(`[payment-server] STP LQ: loan ${loanId} disbursement confirmed`);

    } else if (estado === 'DE') {
      // Payment returned — mark as failed, notify borrower
      await disbDoc.ref.update({
        status: 'returned',
        returnedAt: admin.firestore.Timestamp.now(),
        stpTransactionId: String(id ?? ''),
      });

      await db.collection('loans').doc(loanId).update({
        status: 'disbursement_failed',
        disbursementError: 'STP returned payment (DE)',
      });

      await redis.lpush(
        'jobs:notifications',
        JSON.stringify({
          type: 'loan_disbursement_failed',
          userId: disbData['userId'],
          loanId,
        }),
      );

      console.log(`[payment-server] STP DE: loan ${loanId} disbursement returned`);

    } else {
      console.log(`[payment-server] STP webhook: unhandled estado=${estado} for folio=${folioOrigen}`);
    }

    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] STP webhook error:', message);

    await db.collection('incident_log').add({
      source: 'stp-webhook',
      folioOrigen,
      estado,
      error: message,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /webhooks/conekta ───────────────────────────────────────────────────

router.post('/conekta', async (req: Request, res: Response): Promise<void> => {
  const sig =
    (req.headers['digest'] as string) ||
    (req.headers['x-conekta-signature'] as string) ||
    '';

  const rawBody = req.body as Buffer;
  let valid = false;

  try {
    const pubKey = process.env.CONEKTA_WEBHOOK_SECRET ?? '';
    if (pubKey.startsWith('-----BEGIN PUBLIC KEY')) {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(rawBody);
      valid = verifier.verify(pubKey, sig, 'base64');
    } else if (pubKey) {
      const expected = crypto
        .createHmac('sha256', pubKey)
        .update(rawBody)
        .digest('base64');
      valid = sig === expected;
    } else {
      // No secret configured — accept in sandbox/dev
      valid = true;
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    await db.collection('incident_log').add({
      source: 'conekta-webhook',
      error: 'invalid_signature',
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  try {
    const { type, data } = JSON.parse(rawBody.toString()) as {
      type: string;
      data: { object: Record<string, unknown> };
    };

    if (type === 'order.paid') {
      const obj = data.object;
      const metadata = (obj['metadata'] as Record<string, string>) ?? {};
      const { loan_id: loanId } = metadata;

      if (!loanId) {
        console.warn('[payment-server] Conekta order.paid missing loan_id in metadata');
        res.json({ received: true });
        return;
      }

      const charges = (obj['charges'] as { data: Array<{ id: string; payment_method: Record<string, unknown> }> })?.data ?? [];
      const chargeId = charges[0]?.id ?? '';
      const amount = (obj['amount'] as number) / 100;

      await db.runTransaction(async (tx) => {
        const ref = db.collection('loans').doc(loanId);
        const doc = await tx.get(ref);
        if (!doc.exists || doc.data()?.['status'] === 'paid') return;
        tx.update(ref, {
          status: 'paid',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paidAmount: amount,
          repaymentRef: chargeId,
          paymentMethod: 'conekta_oxxo',
        });
        tx.set(db.collection('repayments').doc(), {
          loanId,
          amount,
          method: 'oxxo',
          conektaOrderId: obj['id'],
          conektaChargeId: chargeId,
          status: 'completed',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      console.log(`[payment-server] Conekta OXXO payment confirmed for loan ${loanId}`);
    }

    if (type === 'order.payment_failed') {
      const obj = data.object;
      const metadata = (obj['metadata'] as Record<string, string>) ?? {};
      const { loan_id: loanId } = metadata;
      if (loanId) {
        await db.collection('payment_failures').add({
          loanId,
          conektaOrderId: obj['id'],
          reason: obj['payment_status'],
          ts: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    res.json({ received: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] Conekta webhook error:', message);
    await db.collection('incident_log').add({
      source: 'conekta-webhook',
      error: message,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

export { router as webhooksRouter };
