import { Router, Request, Response } from 'express';
import { db, admin } from '../lib/firebase';
import { requireInternalSecret } from '../middleware/requireInternalSecret';

const router = Router();

// ── POST /payment-links/oxxo ─────────────────────────────────────────────────

interface OxxoLinkRequest {
  loanId: string;
  amount: number;
  borrowerName: string;
  borrowerEmail: string;
  expiresAt: number; // Unix ms
}

router.post('/oxxo', requireInternalSecret, async (req: Request, res: Response): Promise<void> => {
  const { loanId, amount, borrowerName, borrowerEmail, expiresAt } = req.body as OxxoLinkRequest;

  if (!loanId || !amount || !borrowerName || !borrowerEmail || !expiresAt) {
    res.status(400).json({
      error: 'Missing required fields: loanId, amount, borrowerName, borrowerEmail, expiresAt',
    });
    return;
  }

  const conektaApiKey = process.env.CONEKTA_API_KEY;
  if (!conektaApiKey) {
    res.status(500).json({ error: 'CONEKTA_API_KEY not configured' });
    return;
  }

  try {
    // Use Conekta REST API directly to avoid SDK version conflicts
    const fetch = (await import('node-fetch')).default;
    const authToken = Buffer.from(`${conektaApiKey}:`).toString('base64');

    const orderPayload = {
      currency: 'MXN',
      customer_info: {
        name: borrowerName,
        email: borrowerEmail,
      },
      line_items: [
        {
          name: 'Préstamo VIDA Finance',
          unit_price: Math.round(amount * 100),
          quantity: 1,
        },
      ],
      charges: [
        {
          payment_method: {
            type: 'oxxo_cash',
            expires_at: Math.floor(expiresAt / 1000),
          },
        },
      ],
      metadata: { loan_id: loanId },
    };

    const response = await fetch('https://api.conekta.io/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.conekta-v2.1.0+json',
      },
      body: JSON.stringify(orderPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Conekta API error ${response.status}: ${errText}`);
    }

    const order = (await response.json()) as {
      id: string;
      charges: { data: Array<{ payment_method: { reference: string; expires_at: number } }> };
    };

    const oxxoCharge = order.charges?.data?.[0];
    const paymentRef = oxxoCharge?.payment_method?.reference ?? '';
    const chargeExpiresAt = oxxoCharge?.payment_method?.expires_at ?? Math.floor(expiresAt / 1000);

    // Store OXXO order in Firestore for reconciliation
    await db.collection('oxxo_links').doc(loanId).set({
      conektaOrderId: order.id,
      loanId,
      amount,
      borrowerName,
      borrowerEmail,
      paymentReference: paymentRef,
      expiresAt: admin.firestore.Timestamp.fromMillis(chargeExpiresAt * 1000),
      status: 'pending',
      createdAt: admin.firestore.Timestamp.now(),
    });

    res.json({
      orderId: order.id,
      paymentUrl: paymentRef,
      expiresAt: chargeExpiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] Conekta OXXO link error:', message);
    res.status(500).json({ error: message });
  }
});

export { router as paymentLinksRouter };
