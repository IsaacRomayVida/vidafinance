import { Router, Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/requireInternalSecret';
import { createOxxoPaymentLink } from '../services/conektaService';

const router = Router();

// ── POST /payment-links/oxxo ─────────────────────────────────────────────────

interface OxxoLinkRequest {
  loanId: string;
  amount: number;
  borrowerName: string;
  borrowerEmail: string;
  borrowerPhone: string;
  expiresAt: number; // Unix ms
}

router.post('/oxxo', requireInternalSecret, async (req: Request, res: Response): Promise<void> => {
  const { loanId, amount, borrowerName, borrowerEmail, borrowerPhone, expiresAt } = req.body as OxxoLinkRequest;

  if (!loanId || !amount || !borrowerName || !borrowerEmail || !borrowerPhone || !expiresAt) {
    res.status(400).json({
      error: 'Missing required fields: loanId, amount, borrowerName, borrowerEmail, borrowerPhone, expiresAt',
    });
    return;
  }

  try {
    const result = await createOxxoPaymentLink({
      loanId,
      amount,
      borrowerName,
      borrowerEmail,
      borrowerPhone,
      expiresAt,
    });

    res.json({
      orderId: result.orderId,
      paymentUrl: result.paymentReference,
      expiresAt: result.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] Conekta OXXO link error:', message);
    res.status(500).json({ error: message });
  }
});

export { router as paymentLinksRouter };
