import { Router, Request, Response } from 'express';
import { requireInternalSecret } from '../middleware/internalAuth';
import { sendPagareForSigning, getDocumentStatus } from '../services/mifielClient';

const router = Router();

// POST /mifiel/send — send a pagare PDF for e-signing
router.post('/send', requireInternalSecret, async (req: Request, res: Response) => {
  const { pdfPath, borrowerName, borrowerEmail, borrowerRfc, loanId } = req.body;

  if (!pdfPath || !borrowerName || !borrowerEmail || !borrowerRfc || !loanId) {
    res.status(400).json({ error: 'Missing required fields: pdfPath, borrowerName, borrowerEmail, borrowerRfc, loanId' });
    return;
  }

  try {
    const result = await sendPagareForSigning({ pdfPath, borrowerName, borrowerEmail, borrowerRfc, loanId });
    res.json(result);
  } catch (err) {
    console.error('[mifiel/send] Error:', err);
    res.status(500).json({ error: 'Failed to send document for signing' });
  }
});

// GET /mifiel/status/:documentId — check signing status
router.get('/status/:documentId', requireInternalSecret, async (req: Request, res: Response) => {
  try {
    const status = await getDocumentStatus(req.params.documentId);
    res.json(status);
  } catch (err) {
    console.error('[mifiel/status] Error:', err);
    res.status(500).json({ error: 'Failed to fetch document status' });
  }
});

export { router as mifielRouter };
