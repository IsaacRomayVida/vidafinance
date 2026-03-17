import { Router } from 'express';
import { requireInternalSecret } from '../lib/internalAuth';
import { validateRfc } from '../services/rfcValidationService';

const router = Router();

// RFC: 4 letters + 6-digit DOB + 3 check chars (persona física, 13 chars)
// or:  3 letters + 6-digit date + 3 check chars (persona moral, 12 chars)
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

router.post('/rfc/validate', requireInternalSecret, async (req, res) => {
  const { rfc, expectedName } = req.body as { rfc?: string; expectedName?: string };

  if (!rfc || typeof rfc !== 'string') {
    res.status(400).json({ error: 'rfc is required' });
    return;
  }

  const normalized = rfc.toUpperCase().trim();
  if (!RFC_REGEX.test(normalized)) {
    res.status(400).json({ error: 'Invalid RFC format (must be 12-13 alphanumeric characters)' });
    return;
  }

  try {
    const result = await validateRfc({ rfc: normalized, expectedName });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[rfc/validate] error:', message);
    res.status(502).json({ error: `SAT API error: ${message}` });
  }
});

export default router;
