import { Router, Request, Response } from 'express';
import { internalAuth } from '../middleware/auth';
import { generateDeductionReport } from '../services/deductionReport';
import { pollAllSftpEmployers } from '../services/sftp';
import { db } from '../lib/firebase';

const router = Router();

router.use(internalAuth);

/**
 * POST /internal/generate-deduction-report
 * Body: { employerId, generatedBy, payPeriod?, batchId? }
 */
router.post('/generate-deduction-report', async (req: Request, res: Response) => {
  const { employerId, generatedBy, payPeriod, batchId } = req.body as {
    employerId: string;
    generatedBy: string;
    payPeriod?: string;
    batchId?: string;
  };

  if (!employerId || !generatedBy) {
    res.status(400).json({ error: 'employerId and generatedBy are required' });
    return;
  }

  try {
    const result = await generateDeductionReport({ employerId, generatedBy, payPeriod, batchId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[payroll] generate-deduction-report error:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /internal/poll-sftp
 * Trigger SFTP poll for all enabled employers.
 */
router.post('/poll-sftp', async (_req: Request, res: Response) => {
  try {
    const result = await pollAllSftpEmployers();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[payroll] poll-sftp error:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /internal/batch/:batchId
 * Fetch a batch doc for status polling by Cloud Functions.
 */
router.get('/batch/:batchId', async (req: Request, res: Response) => {
  const { batchId } = req.params;
  try {
    const doc = await db.collection('payroll_batches').doc(batchId).get();
    if (!doc.exists) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }
    res.json({ batchId, ...doc.data() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as internalRouter };
