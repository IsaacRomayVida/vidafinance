import { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { admin, db } from '../lib/firebase';
import { redis } from '../lib/redis';
import { signStpOrder, validateClabe, StpOrder } from '../lib/stpSigning';
import { requireInternalSecret } from '../middleware/requireInternalSecret';

const router = Router();

// All /internal/* routes require the internal secret header
router.use(requireInternalSecret);

// ── Types ────────────────────────────────────────────────────────────────────

export interface DisburseRequest {
  loanId: string;
  userId: string;
  amount: number;
  clabe: string;
  beneficiaryName: string;
}

export interface ReconcileDeduction {
  employeeId: string;
  curp: string;
  amount: number;
}

export interface ReconcileRequest {
  employerId: string;
  payrollDate: string;
  deductions: ReconcileDeduction[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashCurp(curp: string): string {
  return crypto.createHash('sha256').update(curp.toUpperCase().trim()).digest('hex');
}

/**
 * Build and send a SPEI order to STP sandbox, store the result in Firestore.
 */
export async function disburseLoan(req: DisburseRequest): Promise<{
  stpId: string | number;
  folioOrigen: string;
}> {
  if (!validateClabe(req.clabe)) {
    throw new Error(`Invalid CLABE: ${req.clabe}`);
  }

  const empresa = process.env.STP_EMPRESA ?? 'VIDA SOFOM';
  const folioOrigen = `VIDA-${req.loanId}-${Date.now()}`;

  const stpOrder: StpOrder & Record<string, unknown> = {
    empresa,
    folioOrigen,
    causaDevolucion: '',
    cuenta: req.clabe,
    rfcCurpBeneficiario: 'ND',
    nombreBeneficiario: req.beneficiaryName,
    conceptoPago: 'Prestamo VIDA Finance',
    monto: req.amount,
    tipoPago: 1,
    topologia: 'T',
    medioEntrega: 3,
    prioridad: 1,
    iva: 0,
  };

  const privateKey = process.env.STP_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('STP_PRIVATE_KEY is required for signing');
  }

  const firma = signStpOrder(stpOrder, privateKey);

  const stpApiUrl = process.env.STP_API_URL ?? 'https://demo.stpmex.com:7002';
  const response = await axios.post<{ id: string | number }>(
    `${stpApiUrl}/spei/ordenaPago`,
    { ...stpOrder, firma },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.STP_API_KEY ? { Authorization: `Bearer ${process.env.STP_API_KEY}` } : {}),
      },
      timeout: 30_000,
    },
  );

  await db.collection('disbursements').doc(req.loanId).set({
    stpFolioOrigen: folioOrigen,
    stpId: String(response.data.id),
    status: 'pending_confirmation',
    amount: req.amount,
    clabe: req.clabe,
    userId: req.userId,
    beneficiaryName: req.beneficiaryName,
    sentAt: admin.firestore.Timestamp.now(),
  });

  await db.collection('loans').doc(req.loanId).update({
    status: 'disbursement_sent',
    stpFolioOrigen: folioOrigen,
  });

  return { stpId: response.data.id, folioOrigen };
}

// ── POST /internal/disburse ──────────────────────────────────────────────────

router.post('/disburse', async (req: Request, res: Response): Promise<void> => {
  const { loanId, userId, amount, clabe, beneficiaryName } = req.body as DisburseRequest;

  if (!loanId || !userId || !amount || !clabe || !beneficiaryName) {
    res.status(400).json({ error: 'Missing required fields: loanId, userId, amount, clabe, beneficiaryName' });
    return;
  }

  try {
    const result = await disburseLoan({ loanId, userId, amount, clabe, beneficiaryName });
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] disburseLoan error:', message);

    await db.collection('incident_log').add({
      source: 'disburse-endpoint',
      loanId,
      error: message,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(500).json({ error: message });
  }
});

// ── POST /internal/reconcile ─────────────────────────────────────────────────

router.post('/reconcile', async (req: Request, res: Response): Promise<void> => {
  const { employerId, payrollDate, deductions } = req.body as ReconcileRequest;

  if (!employerId || !payrollDate || !Array.isArray(deductions)) {
    res.status(400).json({ error: 'Missing required fields: employerId, payrollDate, deductions[]' });
    return;
  }

  try {
    const results = await Promise.all(
      deductions.map(async (d) => {
        const curpHash = hashCurp(d.curp);

        const loanQuery = await db
          .collection('loans')
          .where('employerId', '==', employerId)
          .where('borrowerSnapshot.curpHash', '==', curpHash)
          .where('status', 'in', ['disbursed', 'overdue'])
          .limit(1)
          .get();

        if (loanQuery.empty) {
          return { curp: d.curp, status: 'no_active_loan' };
        }

        const loan = loanQuery.docs[0];
        const loanId = loan.id;

        await loan.ref.update({
          status: 'repaid',
          repaidAt: admin.firestore.Timestamp.now(),
          repaidAmount: d.amount,
          payrollDate,
          employerId,
        });

        await redis.lpush(
          'jobs:notifications',
          JSON.stringify({
            type: 'loan_repaid',
            userId: loan.data()['userId'],
            loanId,
            amount: d.amount,
          }),
        );

        return { curp: d.curp, loanId, status: 'repaid' };
      }),
    );

    res.json({ processed: results.length, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] reconcile error:', message);
    res.status(500).json({ error: message });
  }
});

// ── GET /internal/queue-stats ────────────────────────────────────────────────

router.get('/queue-stats', async (_req: Request, res: Response): Promise<void> => {
  const { Queue } = await import('bullmq');
  const redisUrl = process.env.REDIS_URL ?? '';
  const bullConnection = {
    url: redisUrl,
    ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
  };

  const names = ['vida-disbursements', 'vida-notifications', 'vida-pdfs', 'vida-underwriting'];
  const stats: Record<string, unknown> = {};

  for (const name of names) {
    const q = new Queue(name, { connection: bullConnection });
    const [waiting, active, failed, completed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getFailedCount(),
      q.getCompletedCount(),
      q.getDelayedCount(),
    ]);
    stats[name] = { waiting, active, failed, completed, delayed };
    await q.close();
  }

  res.json({ queues: stats, ts: new Date().toISOString() });
});

export { router as internalRouter };
