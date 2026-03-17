import { Router, Request, Response } from 'express';
import { Queue } from 'bullmq';
import { db } from '../lib/firebase';
import { requireInternalSecret } from '../middleware/internalAuth';
import { generateLimiter } from '../middleware/rateLimit';
import { renderTemplate, getAvailableTemplates, TemplateName } from '../services/templateService';
import { renderPDF, uploadPDF } from '../services/pdfService';

const router = Router();

const redisUrl = process.env.REDIS_URL ?? '';
const bullConnection = {
  url: redisUrl,
  ...(redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
};

const pdfQueue = new Queue('vida-pdfs', { connection: bullConnection });

// POST /generate/async — enqueue a PDF job for background processing
router.post('/async', requireInternalSecret, generateLimiter, async (req: Request, res: Response) => {
  const { type, loanId, employeeId, employerId, periodLabel, month, amount, chargeId } = req.body;

  const validTypes = ['loan_contract', 'repayment_receipt', 'deduction_report', 'portfolio_report'];
  if (!type || !validTypes.includes(type)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  const job = await pdfQueue.add(type, {
    type,
    loanId,
    employeeId,
    employerId,
    periodLabel,
    month,
    amount,
    chargeId,
  });

  res.status(202).json({
    status: 'queued',
    jobId: job.id,
    type,
  });
});

// POST /generate/sync — generate a PDF immediately and return the URL
router.post('/sync', requireInternalSecret, generateLimiter, async (req: Request, res: Response) => {
  const { template, data, storagePath } = req.body as {
    template: string;
    data: Record<string, unknown>;
    storagePath?: string;
  };

  const available = getAvailableTemplates();
  if (!template || !available.includes(template as TemplateName)) {
    res.status(400).json({ error: `Invalid template. Must be one of: ${available.join(', ')}` });
    return;
  }

  try {
    const html = renderTemplate(template as TemplateName, data);
    const pdfBuf = await renderPDF(html);

    if (storagePath) {
      const url = await uploadPDF(pdfBuf, storagePath);
      res.json({ url, size: pdfBuf.length });
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${template}_${Date.now()}.pdf"`);
      res.send(pdfBuf);
    }
  } catch (err) {
    console.error('[generate/sync] Error:', err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

// GET /generate/templates — list available templates
router.get('/templates', requireInternalSecret, (_req: Request, res: Response) => {
  res.json({ templates: getAvailableTemplates() });
});

// GET /generate/status/:jobId — check job status
router.get('/status/:jobId', requireInternalSecret, async (req: Request, res: Response) => {
  const job = await pdfQueue.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const state = await job.getState();
  res.json({
    jobId: job.id,
    type: job.data.type,
    state,
    progress: job.progress,
    failedReason: job.failedReason,
    finishedOn: job.finishedOn,
  });
});

export { router as generateRouter };
