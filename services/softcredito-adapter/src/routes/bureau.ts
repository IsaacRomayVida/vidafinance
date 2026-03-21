import { Router } from 'express';
import pino from 'pino';
import { requireInternalSecret } from '../lib/internalAuth';
import { queryBureau } from '../services/softcreditoService';
import { BureauQueryRequest } from '../types/bureau';

const log = pino({ name: 'vida-softcredito-adapter', level: process.env.LOG_LEVEL || 'info', formatters: { level: (label) => ({ level: label }) } });

const router = Router();

router.post('/bureau/query', requireInternalSecret, async (req, res) => {
  const { curp, fullName, dateOfBirth, rfc } = req.body as Partial<BureauQueryRequest>;

  if (!curp || !fullName || !dateOfBirth) {
    res.status(400).json({ error: 'Missing required fields: curp, fullName, dateOfBirth' });
    return;
  }

  if (typeof curp !== 'string' || typeof fullName !== 'string' || typeof dateOfBirth !== 'string') {
    res.status(400).json({ error: 'curp, fullName, and dateOfBirth must be strings' });
    return;
  }

  // Validate date format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    res.status(400).json({ error: 'dateOfBirth must be in YYYY-MM-DD format' });
    return;
  }

  try {
    const result = await queryBureau({ curp: curp.toUpperCase(), fullName, dateOfBirth, rfc });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    log.error({ error: message, service: 'softcredito-adapter' }, 'Bureau query error');
    res.status(502).json({ error: `Bureau API error: ${message}` });
  }
});

export default router;
