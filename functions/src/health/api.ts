import { onRequest } from 'firebase-functions/v2/https';

export const api = onRequest({ cors: true }, async (req, res) => {
  if (req.path === '/api/health') {
    res.json({ status: 'ok', service: 'vida-finance', timestamp: new Date().toISOString() });
    return;
  }
  res.status(404).json({ error: 'Not found' });
});
