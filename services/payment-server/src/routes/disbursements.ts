import { Router, Request, Response } from 'express';
import { Queue } from 'bullmq';
import { requireInternalSecret } from '../middleware/requireInternalSecret';
import type { DisbursementJobData } from '../workers/disbursementWorker';

const router = Router();

// All /disburse routes require the internal secret header
router.use(requireInternalSecret);

// ── BullMQ queue (lazy-initialized) ─────────────────────────────────────────

let disbursementQueue: Queue<DisbursementJobData> | null = null;

function getQueue(): Queue<DisbursementJobData> {
  if (disbursementQueue) return disbursementQueue;

  const redisUrl = process.env.REDIS_URL ?? '';
  disbursementQueue = new Queue<DisbursementJobData>('vida-disbursements', {
    connection: {
      url: redisUrl,
      ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
    },
    defaultJobOptions: {
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    },
  });
  return disbursementQueue;
}

// ── POST /disburse ──────────────────────────────────────────────────────────

interface DisburseBody {
  loanId: string;
  userId: string;
  amount: number;
  clabe?: string;
  beneficiaryName?: string;
}

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { loanId, userId, amount, clabe, beneficiaryName } = req.body as DisburseBody;

  if (!loanId || !userId || !amount) {
    res.status(400).json({ error: 'Missing required fields: loanId, userId, amount' });
    return;
  }

  try {
    const queue = getQueue();
    const job = await queue.add('disburse', {
      loanId,
      userId,
      amount,
      ...(clabe ? { clabe } : {}),
      ...(beneficiaryName ? { beneficiaryName } : {}),
    });

    console.log(`[payment-server] Disbursement job ${job.id} enqueued for loan ${loanId}`);
    res.json({ ok: true, jobId: job.id, loanId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[payment-server] Failed to enqueue disbursement:', message);
    res.status(500).json({ error: 'Failed to enqueue disbursement job' });
  }
});

export { router as disbursementsRouter };
