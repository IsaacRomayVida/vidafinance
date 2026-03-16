import { Router } from 'express';
import { requireInternalSecret } from '../lib/internalAuth';
import { validateCurp } from '../services/renapoCurpService';

const router = Router();

// Mexican CURP: 4 letters + 6-digit DOB + sex (H/M) + 5 state/name letters + 2 check chars
const CURP_REGEX = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/;

router.post('/curp/validate', requireInternalSecret, async (req, res) => {
  const { curp, expectedName } = req.body as { curp?: string; expectedName?: string };

  if (!curp || typeof curp !== 'string') {
    res.status(400).json({ error: 'curp is required' });
    return;
  }

  const normalized = curp.toUpperCase().trim();
  if (!CURP_REGEX.test(normalized)) {
    res.status(400).json({ error: 'Invalid CURP format (must be 18 alphanumeric characters)' });
    return;
  }

  try {
    const result = await validateCurp({ curp: normalized, expectedName });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[curp/validate] error:', message);
    res.status(502).json({ error: `RENAPO API error: ${message}` });
  }
});

export default router;
