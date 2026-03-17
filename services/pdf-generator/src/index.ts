import 'dotenv/config';

// Firebase must be initialized before importing any module that uses it
import './lib/firebase';

import express from 'express';
import { redis } from './lib/redis';
import { pdfWorker } from './workers/pdfWorker';
import { generateRouter } from './routes/generate';
import { mifielRouter } from './routes/mifiel';
import { securityHeaders } from './middleware/security';
import { corsMiddleware } from './middleware/cors';
import { generalLimiter } from './middleware/rateLimit';

const app = express();
app.use(securityHeaders);
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(generalLimiter);
app.use(express.json({ limit: '100kb' }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/generate', generateRouter);
app.use('/mifiel', mifielRouter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  let redisOk = false;
  try {
    await redis.ping();
    redisOk = true;
  } catch (_) {
    // Redis down — degraded but still running
  }
  res.json({
    status: redisOk ? 'ok' : 'degraded',
    service: 'vida-pdf-generator',
    redis: redisOk,
    worker: pdfWorker.isRunning(),
    ts: new Date().toISOString(),
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3004);
app.listen(PORT, () =>
  console.log(`[pdf-generator] Listening on port ${PORT}`),
);
